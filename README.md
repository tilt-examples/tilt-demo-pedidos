# tilt-demo-pedidos

Função distribuída de exemplo, rodada pela Tilt nas máquinas da sua grade: recebe **pedidos de
venda** em JSON, **valida** e **publica** cada um no Google Pub/Sub. Um arquivo JavaScript só
(`funcao.mjs`), sem dependências: cada máquina com o conector da Tilt -- Windows ou Linux -- roda a
função com o próprio Node. Um push em `main` troca a versão.

## Como chamar

```bash
# um pedido, ou um lote (uma lista, ou um pedido por linha em .jsonl)
curl -X POST -H "Authorization: Bearer tilt_sk_..." --data-binary @pedido.json \
  "https://<tilt>/api/v1/agentes/<id>/trabalhos?esperar=60"
```

Cada pedido vira uma parte, que uma máquina puxa e executa. O resultado é uma linha por pedido:
`publicado` (com o `mensagemId` que o Google devolveu), `recusado` (com a lista de erros, e nada é
publicado), `falhou` (o Pub/Sub recusou) ou `valido-sem-publicacao` (sem credencial).

## Regras de validação

- `ID` do pedido: só dígitos.
- Obrigatórios, texto não vazio: `SalesOrganisationID`, `DistributionChannelCode`, `DivisionCode`,
  `ProcessingTypeCode`, `BuyerPartyName`, `PlantPartyID`.
- Datas ISO 8601: `DateTime`, `PriceDateTime`, `RequestedFulfillmentStartDateTime`.
- `CurrencyCode` com 3 letras; as moedas do valor e do imposto iguais a ele, no pedido e em cada item.
- Números decimais em texto: `NetAmount`, `TaxAmount`, `GrossWeightMeasure`, `VolumeMeasure`.
- `items`: pelo menos um. Em cada item: `ID` e `ProductID` só dígitos, sem `ID` repetido;
  `Description`, `QuantityMeasureUnitCode` e `PlantPartyID` preenchidos; `Quantity` maior que zero;
  `SalesOrderID` igual ao `ID` do pedido.
- **Fechamento:** a soma dos itens bate com o total do pedido em valor líquido e imposto (tolerância de
  um centavo), peso bruto e volume (tolerância de 0,001). A conta é exata, não em ponto flutuante.

A mensagem publicada é o próprio JSON do pedido, com os atributos `pedido`, `operacao` (o `zop`) e
`origem=tilt`.

## Configuração (o `tilt.toml`)

- `PUBSUB_TOPICO`: `projects/<projeto>/topics/<tópico>`.
- `PUBSUB_ENDPOINT` e `TILT_CHAVE`: quando a máquina não alcança o Google, a publicação passa pelo relé
  da Tilt, autenticada pela chave de API da Tilt guardada no cofre (`tilt_chave`).
- `GCP_CHAVE`: o JSON da conta de serviço (só permissão de publicar), entregue pela Tilt a partir do
  cofre de segredos. Nunca no código nem no repositório.

## Testes

```bash
node --test
```

O branch `funcao-container` guarda a versão anterior, em Python dentro de uma imagem.
