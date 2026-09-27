"""A função distribuída (contrato da Tilt): lê /entrada, escreve /saida.

/entrada traz um pedido (um JSON) ou um lote (uma linha JSON por pedido). Cada pedido é validado e,
se válido, publicado no Google Pub/Sub. /saida/resultado.jsonl recebe uma linha por pedido, com o
`mensagemId` que o Google devolveu ou a lista de erros -- é o que a Tilt junta no fim do trabalho.
"""

from __future__ import annotations

import json
import os
import sys

from servico import processar, publicador_do_google


def pedidos_da_entrada(texto: str) -> list[object]:
    texto = texto.strip()
    if not texto:
        return []
    try:
        um = json.loads(texto)
        return um if isinstance(um, list) else [um]
    except json.JSONDecodeError:
        pedidos: list[object] = []
        for numero, linha in enumerate(texto.splitlines(), 1):
            if not linha.strip():
                continue
            try:
                pedidos.append(json.loads(linha))
            except json.JSONDecodeError as erro:
                pedidos.append({"_erroDeLeitura": f"linha {numero}: JSON inválido ({erro})"})
        return pedidos


def main(entrada: str = "/entrada", saida_dir: str = "/saida") -> int:
    with open(entrada, encoding="utf-8") as f:
        pedidos = pedidos_da_entrada(f.read())
    publicar = publicador_do_google()
    linhas = []
    for pedido in pedidos:
        if isinstance(pedido, dict) and "_erroDeLeitura" in pedido:
            linhas.append({"pedido": None, "status": "recusado", "erros": [pedido["_erroDeLeitura"]]})
            continue
        _codigo, resultado = processar(pedido, publicar)
        resultado["parte"] = os.environ.get("TILT_PARTE", "")
        linhas.append(resultado)
    os.makedirs(saida_dir, exist_ok=True)
    with open(os.path.join(saida_dir, "resultado.jsonl"), "w", encoding="utf-8") as f:
        for linha in linhas:
            f.write(json.dumps(linha, ensure_ascii=False) + "\n")
    print(f"funcao: {len(linhas)} pedido(s) processado(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
