// A função distribuída de pedidos, no contrato da Tilt: lê a entrada, escreve a saída.
//
//   node funcao.mjs <entrada> <pasta-de-saida>
//
// Um arquivo só, sem dependências: roda com o Node que já vem no conector da Tilt, em qualquer
// máquina (Windows ou Linux), sem imagem de contêiner. A entrada traz um pedido (um JSON) ou um lote
// (uma linha JSON por pedido). Cada pedido é validado e, se válido, publicado no Google Pub/Sub pela
// API REST, com um JWT assinado aqui mesmo (node:crypto) pela chave da conta de serviço que a Tilt
// entrega pelo ambiente a partir do cofre. A saída (resultado.jsonl) tem uma linha por pedido, com o
// `mensagemId` que o Google devolveu ou a lista de erros -- é o que a Tilt junta no fim do trabalho.

import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- regras de validação

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const DIGITOS_RE = /^\d+$/;
const MOEDA_RE = /^[A-Z]{3}$/;
const DATA_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// Aritmética exata: cada decimal vira inteiro (BigInt) com ESCALA casas, como o Decimal do Python.
// Ponto flutuante somaria 3461.91 + 5555.97 + 3223.00 com erro e recusaria pedido que fecha.
const ESCALA = 9;
const UM = 10n ** BigInt(ESCALA);
const TOLERANCIA_VALOR = UM / 100n; // um centavo
const TOLERANCIA_MEDIDA = UM / 1000n; // grama / decímetro cúbico

const CAMPOS_TEXTO_DO_PEDIDO = [
  "SalesOrganisationID",
  "DistributionChannelCode",
  "DivisionCode",
  "ProcessingTypeCode",
  "BuyerPartyName",
  "PlantPartyID",
];
const DATAS_DO_PEDIDO = ["DateTime", "PriceDateTime", "RequestedFulfillmentStartDateTime"];
const CAMPOS_TEXTO_DO_ITEM = ["Description", "QuantityMeasureUnitCode", "PlantPartyID"];
const SOMAS = ["NetAmount", "TaxAmount", "GrossWeightMeasure", "VolumeMeasure"];

export function paraInteiro(texto) {
  const [inteira, fracao = ""] = texto.split(".");
  if (fracao.length > ESCALA) return null;
  return BigInt(inteira) * UM + BigInt(fracao.padEnd(ESCALA, "0"));
}

export function paraTexto(inteiro) {
  const negativo = inteiro < 0n;
  const abs = negativo ? -inteiro : inteiro;
  const inteira = (abs / UM).toString();
  const fracao = (abs % UM).toString().padStart(ESCALA, "0").replace(/0+$/, "");
  return `${negativo ? "-" : ""}${inteira}${fracao ? `.${fracao}` : ""}`;
}

const ehObjeto = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function texto(obj, campo, caminho, erros) {
  const valor = obj[campo];
  if (typeof valor !== "string" || valor.trim() === "") {
    erros.push(`${caminho}${campo}: obrigatório, texto não vazio`);
    return null;
  }
  return valor;
}

function decimal(obj, campo, caminho, erros, positivo = false) {
  const valor = obj[campo];
  if (typeof valor !== "string" || !DECIMAL_RE.test(valor)) {
    erros.push(`${caminho}${campo}: obrigatório, número decimal em texto (ex.: "12.50")`);
    return null;
  }
  const numero = paraInteiro(valor);
  if (numero === null) {
    erros.push(`${caminho}${campo}: número inválido`);
    return null;
  }
  if (positivo && numero <= 0n) erros.push(`${caminho}${campo}: tem de ser maior que zero`);
  return numero;
}

function data(obj, campo, caminho, erros) {
  const valor = obj[campo];
  if (typeof valor !== "string") {
    erros.push(`${caminho}${campo}: obrigatório, data e hora ISO 8601 (ex.: 2026-04-17T18:15:20Z)`);
    return;
  }
  if (!DATA_RE.test(valor) || Number.isNaN(Date.parse(valor))) {
    erros.push(`${caminho}${campo}: data e hora inválida: ${JSON.stringify(valor)}`);
  }
}

function mesmaMoeda(obj, campo, moeda, caminho, erros) {
  const valor = obj[campo];
  if (moeda !== null && valor !== moeda) {
    erros.push(`${caminho}${campo}: ${JSON.stringify(valor ?? null)} difere da moeda do pedido ${JSON.stringify(moeda)}`);
  }
}

/** Devolve a lista de erros; vazia quer dizer pedido válido. */
export function validarPedido(pedido) {
  if (!ehObjeto(pedido)) return ["o pedido tem de ser um objeto JSON"];
  const erros = [];

  let pedidoId = pedido.ID;
  if (typeof pedidoId !== "string" || !DIGITOS_RE.test(pedidoId)) {
    erros.push("ID: obrigatório, só dígitos");
    pedidoId = null;
  }
  for (const campo of CAMPOS_TEXTO_DO_PEDIDO) texto(pedido, campo, "", erros);
  for (const campo of DATAS_DO_PEDIDO) data(pedido, campo, "", erros);

  let moeda = pedido.CurrencyCode;
  if (typeof moeda !== "string" || !MOEDA_RE.test(moeda)) {
    erros.push("CurrencyCode: obrigatório, código de 3 letras (ex.: BRL)");
    moeda = null;
  }
  mesmaMoeda(pedido, "NetAmountCurrencyCode", moeda, "", erros);
  mesmaMoeda(pedido, "TaxAmountCurrencyCode", moeda, "", erros);

  const totais = {
    NetAmount: decimal(pedido, "NetAmount", "", erros),
    TaxAmount: decimal(pedido, "TaxAmount", "", erros),
    GrossWeightMeasure: decimal(pedido, "GrossWeightMeasure", "", erros),
    VolumeMeasure: decimal(pedido, "VolumeMeasure", "", erros),
  };

  const itens = pedido.items;
  if (!Array.isArray(itens) || itens.length === 0) {
    erros.push("items: obrigatório, pelo menos um item");
    return erros;
  }

  const somas = { NetAmount: 0n, TaxAmount: 0n, GrossWeightMeasure: 0n, VolumeMeasure: 0n };
  let somasValidas = true;
  const idsVistos = new Set();
  itens.forEach((item, indice) => {
    const caminho = `items[${indice}].`;
    if (!ehObjeto(item)) {
      erros.push(`items[${indice}]: tem de ser um objeto`);
      somasValidas = false;
      return;
    }
    const itemId = item.ID;
    if (typeof itemId !== "string" || !DIGITOS_RE.test(itemId)) {
      erros.push(`${caminho}ID: obrigatório, só dígitos`);
    } else if (idsVistos.has(itemId)) {
      erros.push(`${caminho}ID: ${JSON.stringify(itemId)} repetido no mesmo pedido`);
    } else {
      idsVistos.add(itemId);
    }
    const produto = item.ProductID;
    if (typeof produto !== "string" || !DIGITOS_RE.test(produto)) {
      erros.push(`${caminho}ProductID: obrigatório, só dígitos`);
    }
    for (const campo of CAMPOS_TEXTO_DO_ITEM) texto(item, campo, caminho, erros);
    if (pedidoId !== null && item.SalesOrderID !== pedidoId) {
      erros.push(`${caminho}SalesOrderID: ${JSON.stringify(item.SalesOrderID ?? null)} não é o pedido ${JSON.stringify(pedidoId)}`);
    }
    decimal(item, "Quantity", caminho, erros, true);
    mesmaMoeda(item, "NetAmountCurrencyCode", moeda, caminho, erros);
    mesmaMoeda(item, "TaxAmountCurrencyCode", moeda, caminho, erros);
    for (const campo of SOMAS) {
      const numero = decimal(item, campo, caminho, erros);
      if (numero === null) somasValidas = false;
      else somas[campo] += numero;
    }
  });

  // Fechamento: só compara quando todas as parcelas e o total são números -- senão o erro de
  // formato já foi dito, e uma segunda mensagem sobre a soma só confundiria.
  if (somasValidas) {
    const nomes = {
      NetAmount: ["valor líquido", TOLERANCIA_VALOR],
      TaxAmount: ["imposto", TOLERANCIA_VALOR],
      GrossWeightMeasure: ["peso bruto", TOLERANCIA_MEDIDA],
      VolumeMeasure: ["volume", TOLERANCIA_MEDIDA],
    };
    for (const campo of SOMAS) {
      const total = totais[campo];
      if (total === null) continue;
      const diferenca = somas[campo] - total;
      const [nome, tolerancia] = nomes[campo];
      if ((diferenca < 0n ? -diferenca : diferenca) > tolerancia) {
        erros.push(`${campo}: a soma dos itens (${paraTexto(somas[campo])}) não fecha com o ${nome} do pedido (${paraTexto(total)})`);
      }
    }
  }
  return erros;
}

// ---------------------------------------------------------------- publicação no Pub/Sub

export const PRAZO_DA_PUBLICACAO_MS = 20_000;

const base64url = (dados) => Buffer.from(dados).toString("base64url");

/** JWT RS256 assinado pela chave da conta de serviço; o Google aceita como bearer sem trocar por token. */
export function jwtDaContaDeServico(conta, agora = Math.floor(Date.now() / 1000)) {
  const cabecalho = { alg: "RS256", typ: "JWT", kid: conta.private_key_id };
  const corpo = {
    iss: conta.client_email,
    sub: conta.client_email,
    aud: "https://pubsub.googleapis.com/",
    iat: agora,
    exp: agora + 3600,
  };
  const assinavel = `${base64url(JSON.stringify(cabecalho))}.${base64url(JSON.stringify(corpo))}`;
  const assinatura = createSign("RSA-SHA256").update(assinavel).end().sign(conta.private_key);
  return `${assinavel}.${assinatura.toString("base64url")}`;
}

/** O publicador de verdade, ou null quando a credencial ou o tópico não foram entregues. */
export function publicadorDoGoogle(ambiente = process.env, buscar = fetch) {
  const chave = (ambiente.GCP_CHAVE ?? "").trim();
  const topico = (ambiente.PUBSUB_TOPICO ?? "").trim();
  if (!chave || !topico) return null;
  const conta = JSON.parse(chave);
  let jwt = null;
  let jwtVenceEm = 0;
  return async function publicar(dados, atributos) {
    const agora = Math.floor(Date.now() / 1000);
    if (!jwt || agora > jwtVenceEm - 60) {
      jwt = jwtDaContaDeServico(conta, agora);
      jwtVenceEm = agora + 3600;
    }
    const resposta = await buscar(`https://pubsub.googleapis.com/v1/${topico}:publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ data: Buffer.from(dados).toString("base64"), attributes: atributos }] }),
      signal: AbortSignal.timeout(PRAZO_DA_PUBLICACAO_MS),
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      const erro = corpo?.error ?? {};
      throw new Error(`${erro.status ?? resposta.status}: ${erro.message ?? "sem detalhe"}`);
    }
    const id = corpo?.messageIds?.[0];
    if (typeof id !== "string") throw new Error("o Pub/Sub respondeu sem messageId");
    return id;
  };
}

// ---------------------------------------------------------------- o fluxo

/** Um pedido -> a linha de resultado. Puro: o teste chama sem rede. */
export async function processar(pedido, publicar) {
  const pedidoId = ehObjeto(pedido) && typeof pedido.ID === "string" ? pedido.ID : null;
  const erros = validarPedido(pedido);
  if (erros.length > 0) return { pedido: pedidoId, status: "recusado", erros };
  if (publicar === null) {
    return {
      pedido: pedidoId,
      status: "valido-sem-publicacao",
      erros: ["publicação não configurada (sem credencial ou tópico)"],
    };
  }
  const inicio = performance.now();
  try {
    const mensagemId = await publicar(JSON.stringify(pedido), {
      pedido: String(pedidoId),
      operacao: String(pedido.zop ?? ""),
      origem: "tilt",
    });
    return { pedido: pedidoId, status: "publicado", mensagemId, publicacaoMs: Math.round(performance.now() - inicio) };
  } catch (erro) {
    const prazo = erro?.name === "TimeoutError";
    return {
      pedido: pedidoId,
      status: "falhou",
      erros: [prazo ? `o Pub/Sub não confirmou em ${PRAZO_DA_PUBLICACAO_MS / 1000} s` : `Pub/Sub recusou: ${erro?.message ?? erro}`],
    };
  }
}

/** A entrada é um JSON (um pedido ou uma lista) ou JSON Lines (um pedido por linha). */
export function pedidosDaEntrada(textoDaEntrada) {
  const aparado = textoDaEntrada.trim();
  if (!aparado) return [];
  try {
    const um = JSON.parse(aparado);
    return Array.isArray(um) ? um : [um];
  } catch {
    return aparado.split(/\r?\n/).flatMap((linha, i) => {
      if (!linha.trim()) return [];
      try {
        return [JSON.parse(linha)];
      } catch (erro) {
        return [{ _erroDeLeitura: `linha ${i + 1}: JSON inválido (${erro.message})` }];
      }
    });
  }
}

export async function main(entrada, saidaDir, ambiente = process.env) {
  const pedidos = pedidosDaEntrada(readFileSync(entrada, "utf8"));
  const publicar = publicadorDoGoogle(ambiente);
  const linhas = [];
  for (const pedido of pedidos) {
    if (ehObjeto(pedido) && "_erroDeLeitura" in pedido) {
      linhas.push({ pedido: null, status: "recusado", erros: [pedido._erroDeLeitura] });
      continue;
    }
    const resultado = await processar(pedido, publicar);
    resultado.parte = ambiente.TILT_PARTE ?? "";
    linhas.push(resultado);
  }
  mkdirSync(saidaDir, { recursive: true });
  writeFileSync(join(saidaDir, "resultado.jsonl"), linhas.map((l) => `${JSON.stringify(l)}\n`).join(""));
  console.log(`funcao: ${linhas.length} pedido(s) processado(s)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entrada, saidaDir] = process.argv.slice(2);
  if (!entrada || !saidaDir) {
    console.error("uso: node funcao.mjs <entrada> <pasta-de-saida>");
    process.exit(2);
  }
  main(entrada, saidaDir).then((codigo) => process.exit(codigo), (erro) => {
    console.error(`funcao: ${erro?.stack ?? erro}`);
    process.exit(1);
  });
}
