"""Regras de validação do pedido de venda.

Tiradas do exemplo de payload que o cliente enviou. Cada regra devolve uma mensagem em
português, com o caminho do campo, para quem integra saber exatamente o que corrigir.

A regra mais forte é a de fechamento: a soma dos itens tem de bater com o total do pedido em
valor, imposto, peso bruto e volume -- o exemplo do cliente fecha nos quatro.
"""

from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

DECIMAL_RE = re.compile(r"^\d+(\.\d+)?$")
DIGITOS_RE = re.compile(r"^\d+$")
MOEDA_RE = re.compile(r"^[A-Z]{3}$")

# Tolerâncias do fechamento: centavo para dinheiro, grama/decímetro cúbico para peso e volume.
TOLERANCIA_VALOR = Decimal("0.01")
TOLERANCIA_MEDIDA = Decimal("0.001")

CAMPOS_TEXTO_DO_PEDIDO = (
    "SalesOrganisationID",
    "DistributionChannelCode",
    "DivisionCode",
    "ProcessingTypeCode",
    "BuyerPartyName",
    "PlantPartyID",
)
DATAS_DO_PEDIDO = ("DateTime", "PriceDateTime", "RequestedFulfillmentStartDateTime")
CAMPOS_TEXTO_DO_ITEM = ("Description", "QuantityMeasureUnitCode", "PlantPartyID")


def _texto(pedido: dict, campo: str, caminho: str, erros: list[str]) -> str | None:
    valor = pedido.get(campo)
    if not isinstance(valor, str) or not valor.strip():
        erros.append(f"{caminho}{campo}: obrigatório, texto não vazio")
        return None
    return valor


def _decimal(
    obj: dict, campo: str, caminho: str, erros: list[str], positivo: bool = False
) -> Decimal | None:
    valor = obj.get(campo)
    if not isinstance(valor, str) or not DECIMAL_RE.match(valor):
        erros.append(f"{caminho}{campo}: obrigatório, número decimal em texto (ex.: \"12.50\")")
        return None
    try:
        numero = Decimal(valor)
    except InvalidOperation:
        erros.append(f"{caminho}{campo}: número inválido")
        return None
    if positivo and numero <= 0:
        erros.append(f"{caminho}{campo}: tem de ser maior que zero")
    return numero


def _data(obj: dict, campo: str, caminho: str, erros: list[str]) -> None:
    valor = obj.get(campo)
    if not isinstance(valor, str):
        erros.append(f"{caminho}{campo}: obrigatório, data e hora ISO 8601 (ex.: 2026-04-17T18:15:20Z)")
        return
    try:
        datetime.fromisoformat(valor.replace("Z", "+00:00"))
    except ValueError:
        erros.append(f"{caminho}{campo}: data e hora inválida: {valor!r}")


def _mesma_moeda(obj: dict, campo: str, moeda: str | None, caminho: str, erros: list[str]) -> None:
    valor = obj.get(campo)
    if moeda is not None and valor != moeda:
        erros.append(f"{caminho}{campo}: {valor!r} difere da moeda do pedido {moeda!r}")


def validar_pedido(pedido: object) -> list[str]:
    """Devolve a lista de erros; vazia quer dizer pedido válido."""
    if not isinstance(pedido, dict):
        return ["o pedido tem de ser um objeto JSON"]
    erros: list[str] = []

    pedido_id = pedido.get("ID")
    if not isinstance(pedido_id, str) or not DIGITOS_RE.match(pedido_id):
        erros.append("ID: obrigatório, só dígitos")
        pedido_id = None
    for campo in CAMPOS_TEXTO_DO_PEDIDO:
        _texto(pedido, campo, "", erros)
    for campo in DATAS_DO_PEDIDO:
        _data(pedido, campo, "", erros)

    moeda = pedido.get("CurrencyCode")
    if not isinstance(moeda, str) or not MOEDA_RE.match(moeda):
        erros.append("CurrencyCode: obrigatório, código de 3 letras (ex.: BRL)")
        moeda = None
    _mesma_moeda(pedido, "NetAmountCurrencyCode", moeda, "", erros)
    _mesma_moeda(pedido, "TaxAmountCurrencyCode", moeda, "", erros)

    total = _decimal(pedido, "NetAmount", "", erros)
    imposto = _decimal(pedido, "TaxAmount", "", erros)
    peso = _decimal(pedido, "GrossWeightMeasure", "", erros)
    volume = _decimal(pedido, "VolumeMeasure", "", erros)

    itens = pedido.get("items")
    if not isinstance(itens, list) or len(itens) == 0:
        erros.append("items: obrigatório, pelo menos um item")
        return erros

    somas = {"NetAmount": Decimal(0), "TaxAmount": Decimal(0), "GrossWeightMeasure": Decimal(0), "VolumeMeasure": Decimal(0)}
    somas_validas = True
    ids_vistos: set[str] = set()
    for indice, item in enumerate(itens):
        caminho = f"items[{indice}]."
        if not isinstance(item, dict):
            erros.append(f"items[{indice}]: tem de ser um objeto")
            somas_validas = False
            continue
        item_id = item.get("ID")
        if not isinstance(item_id, str) or not DIGITOS_RE.match(item_id):
            erros.append(f"{caminho}ID: obrigatório, só dígitos")
        elif item_id in ids_vistos:
            erros.append(f"{caminho}ID: {item_id!r} repetido no mesmo pedido")
        else:
            ids_vistos.add(item_id)
        produto = item.get("ProductID")
        if not isinstance(produto, str) or not DIGITOS_RE.match(produto):
            erros.append(f"{caminho}ProductID: obrigatório, só dígitos")
        for campo in CAMPOS_TEXTO_DO_ITEM:
            _texto(item, campo, caminho, erros)
        if pedido_id is not None and item.get("SalesOrderID") != pedido_id:
            erros.append(f"{caminho}SalesOrderID: {item.get('SalesOrderID')!r} não é o pedido {pedido_id!r}")
        _decimal(item, "Quantity", caminho, erros, positivo=True)
        _mesma_moeda(item, "NetAmountCurrencyCode", moeda, caminho, erros)
        _mesma_moeda(item, "TaxAmountCurrencyCode", moeda, caminho, erros)
        for campo in somas:
            numero = _decimal(item, campo, caminho, erros)
            if numero is None:
                somas_validas = False
            else:
                somas[campo] += numero

    # Fechamento: só compara quando todas as parcelas e o total são números -- senão o erro de
    # formato já foi dito, e uma segunda mensagem sobre a soma só confundiria.
    if somas_validas:
        for campo, total_do_pedido, tolerancia, nome in (
            ("NetAmount", total, TOLERANCIA_VALOR, "valor líquido"),
            ("TaxAmount", imposto, TOLERANCIA_VALOR, "imposto"),
            ("GrossWeightMeasure", peso, TOLERANCIA_MEDIDA, "peso bruto"),
            ("VolumeMeasure", volume, TOLERANCIA_MEDIDA, "volume"),
        ):
            if total_do_pedido is not None and abs(somas[campo] - total_do_pedido) > tolerancia:
                erros.append(
                    f"{campo}: a soma dos itens ({somas[campo]}) não fecha com o {nome} do pedido ({total_do_pedido})"
                )
    return erros
