"""Testes das regras e do fluxo -- rodam na imagem, a cada push, nas máquinas ociosas da grade."""

import copy
import json
import os
import unittest

from servico import processar
from validacao import validar_pedido

AQUI = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(AQUI, "exemplo_ficticio.json"), encoding="utf-8") as f:
    EXEMPLO = json.load(f)


def publicador_de_mentira(publicados):
    def publicar(dados, atributos):
        publicados.append((json.loads(dados), atributos))
        return f"msg-{len(publicados)}"
    return publicar


class Regras(unittest.TestCase):
    def test_o_exemplo_e_valido(self):
        self.assertEqual(validar_pedido(EXEMPLO), [])

    def test_a_soma_dos_itens_tem_de_fechar_com_o_total(self):
        p = copy.deepcopy(EXEMPLO)
        p["items"][0]["NetAmount"] = "3461.00"
        erros = validar_pedido(p)
        self.assertTrue(any("NetAmount: a soma dos itens" in e for e in erros), erros)

    def test_peso_e_volume_tambem_fecham(self):
        p = copy.deepcopy(EXEMPLO)
        p["items"][1]["GrossWeightMeasure"] = "1.000"
        p["items"][2]["VolumeMeasure"] = "9.999"
        erros = validar_pedido(p)
        self.assertTrue(any("peso bruto" in e for e in erros), erros)
        self.assertTrue(any("volume" in e for e in erros), erros)

    def test_item_de_outro_pedido_e_recusado(self):
        p = copy.deepcopy(EXEMPLO)
        p["items"][2]["SalesOrderID"] = "123"
        self.assertTrue(any("items[2].SalesOrderID" in e for e in validar_pedido(p)))

    def test_campos_obrigatorios_e_formatos(self):
        p = copy.deepcopy(EXEMPLO)
        del p["BuyerPartyName"]
        p["NetAmount"] = "doze mil"
        p["DateTime"] = "ontem"
        p["items"][0]["Quantity"] = "0"
        erros = validar_pedido(p)
        for trecho in ("BuyerPartyName", "NetAmount: obrigatório, número", "DateTime: data", "items[0].Quantity: tem de ser maior"):
            self.assertTrue(any(trecho in e for e in erros), (trecho, erros))

    def test_sem_itens_e_moeda_diferente(self):
        p = copy.deepcopy(EXEMPLO)
        p["TaxAmountCurrencyCode"] = "USD"
        self.assertTrue(any("TaxAmountCurrencyCode" in e for e in validar_pedido(p)))
        p["items"] = []
        self.assertIn("items: obrigatório, pelo menos um item", validar_pedido(p))

    def test_produto_interno_diferente_do_produto_e_aceito(self):
        # O exemplo do cliente tem um item assim -- exigir igualdade recusaria o próprio exemplo.
        p = copy.deepcopy(EXEMPLO)
        p["items"][2]["ProductInternalID"] = "000000000999999999"
        self.assertEqual(validar_pedido(p), [])


class Fluxo(unittest.TestCase):
    def test_pedido_valido_e_publicado_com_o_proprio_json(self):
        publicados = []
        codigo, r = processar(EXEMPLO, publicador_de_mentira(publicados))
        self.assertEqual((codigo, r["status"], r["mensagemId"]), (200, "publicado", "msg-1"))
        self.assertEqual(publicados[0][0], EXEMPLO)
        self.assertEqual(publicados[0][1]["pedido"], "9000000001")

    def test_pedido_invalido_nao_e_publicado(self):
        publicados = []
        p = copy.deepcopy(EXEMPLO)
        p["items"] = []
        codigo, r = processar(p, publicador_de_mentira(publicados))
        self.assertEqual((codigo, r["status"]), (422, "recusado"))
        self.assertEqual(publicados, [])

    def test_lote_resume_pedido_a_pedido(self):
        publicados = []
        ruim = copy.deepcopy(EXEMPLO)
        ruim["ID"] = "9000000002"
        ruim["NetAmount"] = "1.00"
        codigo, r = processar([EXEMPLO, ruim, EXEMPLO], publicador_de_mentira(publicados))
        self.assertEqual(codigo, 200)
        self.assertEqual((r["total"], r["publicado"], r["recusado"]), (3, 2, 1))
        self.assertEqual(len(publicados), 2)

    def test_sem_credencial_valida_mas_diz_que_nao_publicou(self):
        codigo, r = processar(EXEMPLO, None)
        self.assertEqual((codigo, r["status"]), (503, "valido-sem-publicacao"))

    def test_falha_do_pubsub_vira_resposta_e_nao_derruba(self):
        def quebra(_d, _a):
            raise RuntimeError("PERMISSION_DENIED")
        codigo, r = processar(EXEMPLO, quebra)
        self.assertEqual((codigo, r["status"]), (502, "falhou"))
        self.assertIn("PERMISSION_DENIED", r["erros"][0])


if __name__ == "__main__":
    unittest.main()
