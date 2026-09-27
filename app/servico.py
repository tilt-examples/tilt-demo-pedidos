"""Serviço de pedidos: recebe o pedido de venda por HTTP, valida e publica no Google Pub/Sub.

POST /pedidos  -- um pedido (objeto) ou um lote (lista de pedidos)
GET  /saude    -- 200 quando o serviço está de pé (e diz se a publicação está configurada)

A credencial do Google vem do ambiente (`GCP_CHAVE`, o JSON da conta de serviço), que a Tilt
entrega a partir do cofre de segredos -- nunca do código nem da imagem. O tópico vem de
`PUBSUB_TOPICO` (projects/<projeto>/topics/<tópico>).
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from concurrent.futures import TimeoutError as FuturoAtrasado
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from validacao import validar_pedido

TETO_DO_CORPO = 10 * 1024 * 1024
PRAZO_DA_PUBLICACAO_S = 20

Publicador = Callable[[bytes, dict[str, str]], str]


def publicador_do_google() -> Publicador | None:
    """O publicador de verdade, ou None quando a credencial ou o tópico não foram entregues."""
    chave = os.environ.get("GCP_CHAVE", "").strip()
    topico = os.environ.get("PUBSUB_TOPICO", "").strip()
    if not chave or not topico:
        return None
    from google.cloud import pubsub_v1
    from google.oauth2 import service_account

    credenciais = service_account.Credentials.from_service_account_info(json.loads(chave))
    cliente = pubsub_v1.PublisherClient(credentials=credenciais)

    def publicar(dados: bytes, atributos: dict[str, str]) -> str:
        return cliente.publish(topico, dados, **atributos).result(timeout=PRAZO_DA_PUBLICACAO_S)

    return publicar


def processar(corpo: object, publicar: Publicador | None) -> tuple[int, dict]:
    """Um pedido ou um lote -> (status HTTP, resposta). Puro: o teste chama sem rede."""
    lote = isinstance(corpo, list)
    pedidos = corpo if lote else [corpo]
    if lote and len(pedidos) == 0:
        return 400, {"status": "recusado", "erros": ["lote vazio"]}

    resultados = []
    for pedido in pedidos:
        pedido_id = pedido.get("ID") if isinstance(pedido, dict) else None
        erros = validar_pedido(pedido)
        if erros:
            resultados.append({"pedido": pedido_id, "status": "recusado", "erros": erros})
            continue
        if publicar is None:
            resultados.append({"pedido": pedido_id, "status": "valido-sem-publicacao",
                               "erros": ["publicação não configurada neste serviço (sem credencial ou tópico)"]})
            continue
        inicio = time.monotonic()
        try:
            mensagem_id = publicar(
                json.dumps(pedido, ensure_ascii=False).encode("utf-8"),
                {"pedido": str(pedido_id), "operacao": str(pedido.get("zop", "")), "origem": "tilt"},
            )
        except FuturoAtrasado:
            resultados.append({"pedido": pedido_id, "status": "falhou",
                               "erros": [f"o Pub/Sub não confirmou em {PRAZO_DA_PUBLICACAO_S} s"]})
            continue
        except Exception as erro:  # noqa: BLE001 -- a resposta diz o motivo, o serviço segue de pé
            resultados.append({"pedido": pedido_id, "status": "falhou", "erros": [f"Pub/Sub recusou: {erro}"]})
            continue
        resultados.append({"pedido": pedido_id, "status": "publicado", "mensagemId": mensagem_id,
                           "publicacaoMs": round((time.monotonic() - inicio) * 1000)})

    if not lote:
        r = resultados[0]
        codigo = {"publicado": 200, "recusado": 422, "valido-sem-publicacao": 503, "falhou": 502}[r["status"]]
        return codigo, r
    contagem = {s: sum(1 for r in resultados if r["status"] == s)
                for s in ("publicado", "recusado", "falhou", "valido-sem-publicacao")}
    return 200, {"total": len(resultados), **contagem, "resultados": resultados}


class Pedidos(BaseHTTPRequestHandler):
    publicar: Publicador | None = None
    server_version = "tilt-demo-pedidos"

    def _responder(self, codigo: int, corpo: dict) -> None:
        dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("/saude", ""):
            self._responder(200, {"ok": True, "publicacao": "configurada" if Pedidos.publicar else "ausente"})
        else:
            self._responder(404, {"erro": "use POST /pedidos"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/pedidos":
            self._responder(404, {"erro": "use POST /pedidos"})
            return
        inicio = time.monotonic()
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0 or tamanho > TETO_DO_CORPO:
            self._responder(413 if tamanho > TETO_DO_CORPO else 400,
                            {"status": "recusado", "erros": ["corpo vazio ou maior que 10 MB"]})
            return
        try:
            corpo = json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as erro:
            self._responder(400, {"status": "recusado", "erros": [f"JSON inválido: {erro}"]})
            return
        codigo, resposta = processar(corpo, Pedidos.publicar)
        resposta["tempoTotalMs"] = round((time.monotonic() - inicio) * 1000)
        self._responder(codigo, resposta)

    def log_message(self, formato: str, *args: object) -> None:
        sys.stdout.write("%s %s\n" % (self.address_string(), formato % args))
        sys.stdout.flush()


def main() -> None:
    Pedidos.publicar = publicador_do_google()
    porta = int(os.environ.get("PORTA", "8080"))
    servidor = ThreadingHTTPServer(("0.0.0.0", porta), Pedidos)
    # Sai na hora quando pedem para parar: como processo 1 do contêiner, sem isto o SIGTERM é
    # ignorado e a troca de versão espera 10 s pelo SIGKILL -- 10 s fora do ar a cada atualização.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=servidor.shutdown).start())
    print(f"pedidos: ouvindo na porta {porta}; publicacao {'configurada' if Pedidos.publicar else 'AUSENTE'}", flush=True)
    servidor.serve_forever()
    print("pedidos: parado", flush=True)


if __name__ == "__main__":
    main()
