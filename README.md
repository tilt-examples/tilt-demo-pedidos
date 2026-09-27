# tilt-demo-pedidos

Serviço de exemplo publicado pela Tilt nas máquinas da grade: recebe um **pedido de venda** em JSON,
**valida** e **publica** no Google Pub/Sub. Um push em `main` testa as regras nas máquinas ociosas e
publica a versão nova sozinho.

## Como chamar

```bash
curl -X POST --data-binary @pedido.json http://<endereço>:8080/pedidos   # um pedido
curl -X POST --data-binary @lote.json   http://<endereço>:8080/pedidos   # um lote (lista)
curl http://<endereço>:8080/saude
```

Respostas: `200` publicado (com o `mensagemId` que o Google devolveu), `422` recusado (com a lista de
erros, e nada é publicado), `502` o Pub/Sub recusou, `503` válido mas o serviço está sem credencial.
Um lote devolve `200` com o resumo pedido a pedido.

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
  um centavo), peso bruto e volume (tolerância de 0,001).

A mensagem publicada é o próprio JSON do pedido, com os atributos `pedido`, `operacao` (o `zop`) e
`origem=tilt`.

## Configuração

- `PUBSUB_TOPICO`: `projects/<projeto>/topics/<tópico>`.
- `GCP_CHAVE`: o JSON da conta de serviço (só permissão de publicar), entregue pela Tilt a partir do
  cofre de segredos. Nunca no código nem na imagem.
