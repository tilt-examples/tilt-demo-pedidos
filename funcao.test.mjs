// Testes das regras e do fluxo: `node --test`. Sem rede: o publicador é de mentira.
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  jwtDaContaDeServico,
  main,
  paraInteiro,
  paraTexto,
  pedidosDaEntrada,
  processar,
  publicadorDoGoogle,
  validarPedido,
} from "./funcao.mjs";

const EXEMPLO = JSON.parse(readFileSync(new URL("./exemplo_ficticio.json", import.meta.url), "utf8"));
const copia = () => structuredClone(EXEMPLO);
const temErro = (erros, trecho) => erros.some((e) => e.includes(trecho));

function publicadorDeMentira(publicados) {
  return async (dados, atributos) => {
    publicados.push([JSON.parse(dados), atributos]);
    return `msg-${publicados.length}`;
  };
}

// ---------------------------------------------------------------- regras

test("o exemplo é válido", () => {
  assert.deepEqual(validarPedido(EXEMPLO), []);
});

test("a soma dos itens tem de fechar com o total", () => {
  const p = copia();
  p.items[0].NetAmount = "3461.00";
  const erros = validarPedido(p);
  assert.ok(temErro(erros, "NetAmount: a soma dos itens"), erros);
});

test("peso e volume também fecham", () => {
  const p = copia();
  p.items[1].GrossWeightMeasure = "1.000";
  p.items[2].VolumeMeasure = "9.999";
  const erros = validarPedido(p);
  assert.ok(temErro(erros, "peso bruto"), erros);
  assert.ok(temErro(erros, "volume"), erros);
});

test("a soma é exata, não em ponto flutuante", () => {
  // 0.1 + 0.2 em ponto flutuante dá 0.30000000000000004; aqui tem de fechar com "0.3".
  const p = copia();
  for (const item of p.items) item.NetAmount = "0.1";
  p.items[0].NetAmount = "0.1";
  p.items[1].NetAmount = "0.2";
  p.items[2].NetAmount = "0.0";
  p.NetAmount = "0.3";
  assert.ok(!temErro(validarPedido(p), "NetAmount: a soma"), validarPedido(p));
  assert.equal(paraTexto(paraInteiro("12240.88")), "12240.88");
  assert.equal(paraTexto(paraInteiro("751.139") + paraInteiro("0.001")), "751.14");
  assert.equal(paraInteiro("1.0000000001"), null); // mais casas do que a escala: recusa, não arredonda
});

test("item de outro pedido é recusado", () => {
  const p = copia();
  p.items[2].SalesOrderID = "123";
  assert.ok(temErro(validarPedido(p), "items[2].SalesOrderID"));
});

test("campos obrigatórios e formatos", () => {
  const p = copia();
  delete p.BuyerPartyName;
  p.NetAmount = "doze mil";
  p.DateTime = "ontem";
  p.items[0].Quantity = "0";
  const erros = validarPedido(p);
  for (const trecho of ["BuyerPartyName", "NetAmount: obrigatório, número", "DateTime: data", "items[0].Quantity: tem de ser maior"]) {
    assert.ok(temErro(erros, trecho), [trecho, erros]);
  }
});

test("sem itens e moeda diferente", () => {
  const p = copia();
  p.TaxAmountCurrencyCode = "USD";
  assert.ok(temErro(validarPedido(p), "TaxAmountCurrencyCode"));
  p.items = [];
  assert.ok(validarPedido(p).includes("items: obrigatório, pelo menos um item"));
});

test("produto interno diferente do produto é aceito", () => {
  const p = copia();
  p.items[2].ProductInternalID = "000000000999999999";
  assert.deepEqual(validarPedido(p), []);
});

test("o que não é objeto é recusado sem quebrar", () => {
  assert.deepEqual(validarPedido("texto"), ["o pedido tem de ser um objeto JSON"]);
  assert.deepEqual(validarPedido(null), ["o pedido tem de ser um objeto JSON"]);
  assert.deepEqual(validarPedido([EXEMPLO]), ["o pedido tem de ser um objeto JSON"]);
});

// ---------------------------------------------------------------- fluxo

test("pedido válido é publicado com o próprio JSON", async () => {
  const publicados = [];
  const r = await processar(EXEMPLO, publicadorDeMentira(publicados));
  assert.deepEqual([r.status, r.mensagemId], ["publicado", "msg-1"]);
  assert.deepEqual(publicados[0][0], EXEMPLO);
  assert.deepEqual(publicados[0][1], { pedido: "9000000001", operacao: "I", origem: "tilt" });
});

test("pedido inválido não é publicado", async () => {
  const publicados = [];
  const p = copia();
  p.items = [];
  const r = await processar(p, publicadorDeMentira(publicados));
  assert.equal(r.status, "recusado");
  assert.deepEqual(publicados, []);
});

test("sem credencial valida mas diz que não publicou", async () => {
  const r = await processar(EXEMPLO, null);
  assert.equal(r.status, "valido-sem-publicacao");
  assert.equal(publicadorDoGoogle({}), null);
  assert.equal(publicadorDoGoogle({ GCP_CHAVE: "{}" }), null);
});

test("falha do Pub/Sub vira resultado e não derruba", async () => {
  const r = await processar(EXEMPLO, async () => {
    throw new Error("PERMISSION_DENIED: sem permissão de publicar");
  });
  assert.equal(r.status, "falhou");
  assert.ok(r.erros[0].includes("PERMISSION_DENIED"));
  const atrasado = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  const r2 = await processar(EXEMPLO, async () => {
    throw atrasado;
  });
  assert.ok(r2.erros[0].includes("não confirmou em 20 s"), r2);
});

// ---------------------------------------------------------------- Pub/Sub por REST

const par = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONTA = {
  client_email: "publicador@projeto.iam.gserviceaccount.com",
  private_key_id: "abc123",
  private_key: par.privateKey.export({ type: "pkcs8", format: "pem" }),
};

test("o JWT é RS256, assinado pela chave, com o público do Pub/Sub", () => {
  const jwt = jwtDaContaDeServico(CONTA, 1_700_000_000);
  const [h, c, s] = jwt.split(".");
  const cabecalho = JSON.parse(Buffer.from(h, "base64url").toString());
  const corpo = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual(cabecalho, { alg: "RS256", typ: "JWT", kid: "abc123" });
  assert.deepEqual(corpo, {
    iss: CONTA.client_email,
    sub: CONTA.client_email,
    aud: "https://pubsub.googleapis.com/",
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).end().verify(par.publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

test("o publicador chama o endpoint de publish do tópico e devolve o messageId", async () => {
  const chamadas = [];
  const buscar = async (url, init) => {
    chamadas.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ messageIds: ["1234567890"] }) };
  };
  const publicar = publicadorDoGoogle(
    { GCP_CHAVE: JSON.stringify(CONTA), PUBSUB_TOPICO: "projects/p/topics/t" },
    buscar,
  );
  const id = await publicar(JSON.stringify(EXEMPLO), { pedido: "9000000001" });
  assert.equal(id, "1234567890");
  const [url, init] = chamadas[0];
  assert.equal(url, "https://pubsub.googleapis.com/v1/projects/p/topics/t:publish");
  assert.match(init.headers.Authorization, /^Bearer ey/);
  const corpo = JSON.parse(init.body);
  assert.deepEqual(JSON.parse(Buffer.from(corpo.messages[0].data, "base64").toString()), EXEMPLO);
  assert.deepEqual(corpo.messages[0].attributes, { pedido: "9000000001" });
});

test("PUBSUB_ENDPOINT troca o endereço pelo relé da Tilt, e TILT_CHAVE vai no cabeçalho X-Tilt-Chave", async () => {
  const chamadas = [];
  const buscar = async (url, init) => {
    chamadas.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ messageIds: ["1"] }) };
  };
  const publicar = publicadorDoGoogle(
    {
      GCP_CHAVE: JSON.stringify(CONTA),
      PUBSUB_TOPICO: "projects/p/topics/t",
      PUBSUB_ENDPOINT: "https://console-api.tilt.tools/api/v1/rele/pubsub/",
      TILT_CHAVE: "tilt_sk_abc",
    },
    buscar,
  );
  await publicar("{}", {});
  assert.equal(chamadas[0][0], "https://console-api.tilt.tools/api/v1/rele/pubsub/v1/projects/p/topics/t:publish");
  assert.equal(chamadas[0][1].headers["X-Tilt-Chave"], "tilt_sk_abc");
  assert.match(chamadas[0][1].headers.Authorization, /^Bearer ey/);
  // Sem TILT_CHAVE: nem o cabeçalho, nem o relé -- o Google direto, como antes.
  const direto = publicadorDoGoogle({ GCP_CHAVE: JSON.stringify(CONTA), PUBSUB_TOPICO: "projects/p/topics/t" }, buscar);
  await direto("{}", {});
  assert.equal(chamadas[1][0], "https://pubsub.googleapis.com/v1/projects/p/topics/t:publish");
  assert.equal("X-Tilt-Chave" in chamadas[1][1].headers, false);
});

test("resposta de erro do Google vira exceção com o status dele", async () => {
  const buscar = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { code: 403, message: "User not authorized", status: "PERMISSION_DENIED" } }),
  });
  const publicar = publicadorDoGoogle({ GCP_CHAVE: JSON.stringify(CONTA), PUBSUB_TOPICO: "projects/p/topics/t" }, buscar);
  await assert.rejects(publicar("{}", {}), /PERMISSION_DENIED: User not authorized/);
});

// ---------------------------------------------------------------- a entrada e a saída

test("a entrada aceita um pedido, uma lista ou JSON Lines", () => {
  assert.equal(pedidosDaEntrada("").length, 0);
  assert.equal(pedidosDaEntrada(JSON.stringify(EXEMPLO)).length, 1);
  assert.equal(pedidosDaEntrada(JSON.stringify([EXEMPLO, EXEMPLO])).length, 2);
  const jsonl = `${JSON.stringify(EXEMPLO)}\n\n{isto não é json}\n${JSON.stringify(EXEMPLO)}\n`;
  const pedidos = pedidosDaEntrada(jsonl);
  assert.equal(pedidos.length, 3);
  assert.match(pedidos[1]._erroDeLeitura, /^linha 3: JSON inválido/);
});

test("main lê a entrada e escreve resultado.jsonl com uma linha por pedido", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pedidos-"));
  const entrada = join(dir, "entrada.jsonl");
  const ruim = copia();
  ruim.ID = "9000000002";
  ruim.NetAmount = "1.00";
  writeFileSync(entrada, `${JSON.stringify(EXEMPLO)}\n${JSON.stringify(ruim)}\n`);
  const codigo = await main(entrada, join(dir, "saida"), { TILT_PARTE: "p1" });
  assert.equal(codigo, 0);
  const linhas = readFileSync(join(dir, "saida", "resultado.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(linhas.length, 2);
  assert.deepEqual([linhas[0].status, linhas[1].status], ["valido-sem-publicacao", "recusado"]);
  assert.deepEqual([linhas[0].parte, linhas[1].pedido], ["p1", "9000000002"]);
});
