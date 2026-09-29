# ADR-011: Contrato de reembolso do provider Mercado Pago

> Status: aceito (não commitado) · Data: 2026-09-29 · Commits: correção sobre `fb5d9a0`, ainda não commitada

Investigação e evidências: [INV-004](../investigations/INV-004-refund-payment-amount-and-idempotency.md). Regras garantidas pelo código: invariantes 42–44 em [../mercadopago/invariants.md](../mercadopago/invariants.md). **[MCP 2026-09-29]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data.

## Contexto

- O Medusa 2.20.1 grava o `Refund`, confere o valor contra o capturado e só então chama `refundPayment` do provider com `data` = `payment.data`, `amount` = `refund.raw_amount` (`BigNumberInput`, na prática `{ value, precision }`) e `context.idempotency_key` = `refund.id`. Se o provider lança erro, o `Refund` é apagado (`PaymentModuleService.refundPayment`, `refundPaymentFromProvider_`).
- Em `fb5d9a0`, `refundPayment` tinha dois defeitos, reproduzidos por teste unitário (INV-004):
  1. **Valor:** `Number({ value, precision })` é `NaN`, então todo reembolso pedido pelo Medusa falhava antes de chamar o Mercado Pago. Sem valor, o código usava `data.amount` e reembolsava o total da session.
  2. **Idempotência:** todos os reembolsos de um Payment usavam a `mercadopago_idempotency_key` da session, ignorando o `refund.id`.
- Além disso, o reembolso total era enviado no formato do parcial.
- Orders API [MCP 2026-09-29]: `POST /v1/orders/{order_id}/refund`. Total: body vazio. Parcial: `transactions[{ id, amount }]`, com `id` = `transactions.payments[].id`. `X-Idempotency-Key` obrigatório, de 1 a 128 caracteres, único por requisição (`409 idempotency_key_already_used`). Reembolso permitido até 180 dias após a aprovação, com saldo suficiente na conta; a Order também precisa estar em um status que permita reembolso (`409 cannot_refund_order`, `order_already_refunded`, `order_refund_already_in_process`; `400 refund_amount_exceeds`).

## Decisão

1. **Valor.** O valor é `RefundPaymentInput.amount`, convertido com o `BigNumber` do Medusa e enviado como decimal com 2 casas. Precisa ser informado, finito e positivo; caso contrário, erro `INVALID_DATA` sem chamar o Mercado Pago. Não há fallback para o valor da session.
2. **Idempotência.** `X-Idempotency-Key` = `context.idempotency_key`, sempre. Nunca a key da Payment Session, a de criação do Pix ou qualquer outra compartilhada. Ausente, vazia ou com mais de 128 caracteres → erro `INVALID_DATA` sem chamar o Mercado Pago.
3. **Total.** Valor pedido igual ao valor do pagamento (`payment.data.amount`, comparado em 2 casas) → `POST /v1/orders/{order_id}/refund` sem body. Como a captura é sempre integral ([ADR-002](ADR-002-orders-api-automatic-capture.md)), esse valor é o capturado, e o guard do Medusa só o aceita quando nada foi reembolsado antes. Sem `data.amount`, nunca é total.
4. **Parcial.** Qualquer outro valor, inclusive o restante depois de reembolsos parciais → `{ "transactions": [{ "id": <mercadopago_payment_id>, "amount": "<decimal>" }] }`. Sem `mercadopago_payment_id` → erro sem chamar o Mercado Pago.
5. **Sem consulta prévia.** Nenhum `GET /v1/orders/{id}` antes do reembolso. O Medusa controla o saldo reembolsável; o provider envia a operação pedida, e uma recusa do Mercado Pago (pré-condição, saldo, status da Order) volta como erro.
6. **Erros.** Qualquer erro da API é propagado sem tratamento, para o Payment Module apagar o `Refund` e o erro chegar a quem pediu.
7. **Resultado.** O provider considera a chamada bem-sucedida quando o Mercado Pago aceita a operação (resposta 2xx) e grava em `payment.data` o status da Order e o último reembolso (`mercadopago_refund_id`, `mercadopago_refunded_amount`). Isso **não** afirma que o dinheiro já foi devolvido: o status real do reembolso depois da aceitação (`transactions.refunds[].status`: `processing`, `processed`, `failed` [MCP 2026-09-29]) ainda será validado no sandbox (INV-004).

## Alternativas consideradas

- **Sempre o formato parcial, também para o total** (comportamento anterior): contraria a documentação, que manda body vazio no total. Descartada.
- **Ler a Order antes de cada reembolso** para decidir total × parcial pelo saldo real do Mercado Pago: acrescenta uma chamada e um modo de falha para uma informação que o Medusa já controla. Um reembolso feito fora do Medusa aparece como erro do Mercado Pago, o que é aceitável. Descartada.
- **Derivar a key do valor ou da Order** quando o contexto não a traz: dois reembolsos de mesmo valor colidiriam. Descartada; sem key, recusa.

## Consequências

- Reembolsos pedidos pelo Medusa passam a chegar ao Mercado Pago, cada um com a sua key.
- Um reembolso feito fora do Medusa (painel do Mercado Pago) não é conhecido pelo Medusa; um total posterior pedido pelo Medusa deve ser recusado pelo Mercado Pago **[não validado]**.
- Validação no sandbox (2026-09-29, [INV-004](../investigations/INV-004-refund-payment-amount-and-idempotency.md#e2e-sandbox-2026-09-29)): total sem body e parcial com `transactions` aceitos (HTTP 201) para cartão e Pix, cada reembolso com a key do seu `Refund`; todos os reembolsos vieram `processed` na resposta e continuaram assim. `processing`/`failed` não foram observados, então a decisão 7 continua valendo: 2xx significa operação aceita, não dinheiro devolvido.
- O webhook não trata reembolsos (`getWebhookActionAndData` → `not_supported`). Se o Mercado Pago aceitar o reembolso e depois ele falhar, o Medusa continua registrando o `Refund` **[não validado]**: tratado na INV-004 antes de qualquer mudança.
