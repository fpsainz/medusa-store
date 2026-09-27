# Invariantes do Mercado Pago

> Status: vigente · Última verificação: 2026-09-27 · Commit: `c6beff1`

Regras que o código atual garante e que **não podem ser quebradas** sem uma decisão explícita (novo ADR). Cada regra indica onde é garantida e qual spec a cobre. "Sem teste" significa que a regra está no código, mas nenhum teste a protege.

Specs (caminhos relativos a `apps/backend/src/`):
`S` = `modules/mercadopago/__tests__/service.unit.spec.ts` ·
`W` = `api/hooks/payment/[provider]/__tests__/route.unit.spec.ts` ·
`PS` = `api/store/mercadopago/payment-sessions/[id]/__tests__/route.unit.spec.ts` ·
`PX` = `.../payment-sessions/[id]/pix/__tests__/route.unit.spec.ts` ·
`CX` = `.../carts/[id]/pix/__tests__/route.unit.spec.ts` ·
`OX` = `.../orders/[id]/pix/__tests__/route.unit.spec.ts` ·
`R` = `api/utils/__tests__/redact-mercadopago-data.unit.spec.ts`

## Identidade

1. **O token do provider é `pp_mercadopago`.** Não adicionar `id` ao provider em `medusa-config.ts`. — `medusa-config.ts`, `service.ts` (`identifier`). Sem teste que falhe se o `id` for adicionado. [ADR-001](../decisions/ADR-001-provider-identity-pp-mercadopago.md)

## Escrita na Payment Session

2. **O cliente nunca escreve campos `mercadopago_*`, `status`, QR/ticket, expiração nem idempotency keys.** A rota de update aceita só a allowlist de `buildAllowedSessionData`; `payer` é reduzido a `email` + `identification.{type, number}`. — `payment-sessions/[id]/route.ts`. Teste: `PS`.
3. **Toda rota que recebe `payment_session_id` + `cart_id` confere a posse:** a session precisa pertencer ao `payment_collection` do cart informado e ao provider `pp_mercadopago`. — rotas `payment-sessions/[id]` e `payment-sessions/[id]/pix`. Testes: `PS`, `PX`.
4. **Atualizar a session nunca autoriza nem captura.** `updatePayment` e as rotas de update/prepare não chamam `authorizePayment` nem `cart.complete`. — `service.ts`, rotas. Testes: `PS`, `PX`, `S`.
5. **`mercadopago_pix_action` é transitório:** removido no início de `updatePayment`, nunca persistido. A rota de update comum o descarta pela allowlist. — `service.ts`. Teste: `S` (lifecycle Review).

## Pix

6. **A cobrança Pix é criada na Review, pela rota `prepare`,** não pelo botão "Place order". `authorizePayment` só cria a Order como fallback, quando não há `mercadopago_order_id`. — `preparePixOrder`, `authorizePix`. Teste: `S`. [ADR-003](../decisions/ADR-003-pix-charge-created-at-review.md)
7. **Uma cobrança Pix paga nunca é descartada, substituída nem regenerada.** `invalidatePixOrder` lança `NOT_ALLOWED`, `preparePixOrder` devolve a Order paga como está, a rota `prepare` não chama o provider se a session já está `authorized`, e o storefront só oferece regenerar em `expired`/`canceled`/`failed`/`rejected`. Testes: `S`, `PX`.
8. **Nenhuma Order Pix fica pagável sem uma session:** ao trocar de método (`updatePayment`) ou remover a session (`deletePayment`), a Order pendente é cancelada na Orders API. Teste: `S` (`deletePayment`, lifecycle).
9. **Status Pix desconhecido nunca vira `pending`:** `normalizePixStatus` → `unknown`, e `resolvePixStatus` lança `UNEXPECTED_STATE`. Teste: `S`.
10. **O valor da Order Pix precisa bater com o da session** (comparação em 2 casas decimais) para reutilizar (`preparePixOrder`) ou autorizar (`reauthorizePixOrder`, que lança `INVALID_DATA` se divergir). Teste: `S`.
11. **Idempotency key do Pix:** derivada da key base + valor + "geração". Cada substituição incrementa a geração, então uma Order nova nunca reaproveita a key da anterior. Cancelamento usa `sha256(<pix key>:cancel)`. — `getPixIdempotencyKey`, `createPixOrder`, `invalidatePixOrder`. Teste: `S`.
12. **Sinais Pix e não-Pix ao mesmo tempo na session lançam erro** antes de qualquer chamada externa. A ausência de campos de cartão não indica Pix. — `isPixSession`. Teste: `S` (Pix discriminator).
13. **Rotas de leitura do Pix não gravam na session.** A session só muda via webhook, `completeCart` ou a rota `prepare`. — `carts/[id]/pix`, `orders/[id]/pix`. Testes: `CX`, `OX`.

## Exposição de dados ao storefront

14. **O storefront recebe apenas DTOs** (`toPixPaymentDto`, `toPixDto` da rota de orders): nunca `session.data` completo, payer, identificação ou idempotency keys. A rota de orders, acessível só com o ID do pedido, devolve apenas `status` e `ticket_url`, e só para uma session Pix (`payment_method_id === "pix"`); pedido de cartão ou sem session Pix → 404. — Testes: `OX`, `CX`.
24. **A Store API genérica nunca devolve o `data` do provider Mercado Pago.** Nas respostas de `/store/carts*`, `/store/payment-collections*` e `/store/orders*`, todo `payment_sessions[].data` e `payments[].data` do Mercado Pago, em qualquer profundidade e também com `?fields=`, sai reduzido a `{ payment_method_id }`. Um item sem `provider_id` é reconhecido pelas chaves `mercadopago_*`. O armazenamento não muda, e outros providers não são tocados. — `api/middlewares.ts`, `api/utils/redact-mercadopago-data.ts`. Teste: `R`. [ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md)
15. **Respostas de estado Pix usam `Cache-Control: no-store`.** — rotas `prepare`, `carts/[id]/pix`, `orders/[id]/pix`. Testes: `PX`, `CX`, `OX` (os três fazem referência ao header).

## Webhook

Detalhes em [webhook.md](webhook.md). Teste de todos os itens abaixo: `W`.

16. **A assinatura HMAC é validada antes de qualquer outra ação** (antes dela só há os checks de presença de `data.id`, dos headers e do secret). Assinatura inválida → 401, sem emitir evento.
17. **`data.id` vai em minúsculas somente para o validador HMAC;** o valor original é usado em `Order.get`, na correlação e no payload. [ADR-004](../decisions/ADR-004-webhook-hmac-lowercase-data-id.md)
18. **O `data.id` vem da query string** (`?data.id=`), nunca do body, e precisa ter valor único.
19. **A correlação é pela Order exata:** o cart vem de `external_reference`, e a session é a que tem `data.mercadopago_order_id === data.id`. Nunca "a session Mercado Pago do cart" em geral. Mais de uma → 503 sem emitir.
20. **Order paga sem session correspondente → 503** (o Mercado Pago tenta de novo); **não paga → 200**, sem processar.
21. **Providers diferentes de `mercadopago` recebem exatamente o comportamento do core** (sem HMAC, sem correlação).

## Tipo do cartão

23. **`payment_method.type` do cartão vem somente de `payment_type_id`** (`credit_card` ou `debit_card`, coletado de `additionalData.paymentTypeId`). O tipo nunca é inferido nem tem fallback para `credit_card`. Ausente ou inválido → `authorizePayment` recusa sem criar Order. A rota recusa valores fora do contrato, e `prepaid_card` fica fora. — `service.ts` (`isCardPaymentType`), `payment-sessions/[id]/route.ts`. Testes: `S`, `PS`. [ADR-005](../decisions/ADR-005-card-payment-type-from-brick.md)

## Captura

22. **A captura é automática** (`processing_mode: 'automatic'`); `capturePayment` lança erro de propósito. — `service.ts`. Sem teste. [ADR-002](../decisions/ADR-002-orders-api-automatic-capture.md)
