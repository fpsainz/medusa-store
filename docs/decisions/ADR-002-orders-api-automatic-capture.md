# ADR-002: Orders API com captura automática

> Status: aceito · Data: 2026-09-18 · Commits: `92d16ec` (introdução), mantido até `0326748`

## Contexto

O provider precisa criar cobranças no Mercado Pago para cartão e, depois, para Pix.

## Decisão

- Usar a **Orders API** (`POST /v1/orders` via classe `Order` do SDK `mercadopago` 3.6.1), com `type: 'online'` e `processing_mode: 'automatic'`.
- `external_reference = cart_id`, que é o que o webhook usa para achar o cart.
- `currency: 'BRL'` fixo na criação das Orders.
- Captura automática: `capturePayment` lança erro de propósito ("automatic capture is used for this project").
- Toda escrita na Orders API envia idempotency key (criação, cancelamento, reembolso).

## Alternativas consideradas

Não registradas no código nem nos commits.

## Consequências

- A autorização de cartão retorna `captured` quando o Mercado Pago responde `processed`/`approved`.
- Não existe fluxo de autorizar agora e capturar depois. Adotá-lo exigiria um novo ADR e a implementação de `capturePayment`.
- A moeda fixa em BRL acopla o provider ao mercado brasileiro.
- Reembolso usa `Order.refund` na transação de pagamento. Está **[não validado]** em uso real e não tem testes.
