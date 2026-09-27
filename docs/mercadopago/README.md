# Mercado Pago

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

Antes de alterar qualquer coisa aqui, leia [invariants.md](invariants.md).

## Identidade do provider

```text
endpoint público:        /hooks/payment/mercadopago
provider interno:        mercadopago        (valor de `provider` no evento payment.webhook_received)
provider ID/token:       pp_mercadopago     (pp_${identifier}; sem `id` no medusa-config.ts)
service identifier:      mercadopago        (service.ts: static identifier)
```

São três conceitos distintos, mesmo quando os valores coincidem. Histórico e motivo: [ADR-001](../decisions/ADR-001-provider-identity-pp-mercadopago.md).

A string `"pp_mercadopago"` está duplicada (não importada) na rota do webhook, nas quatro rotas `/store/mercadopago/*`, em `apps/storefront/src/lib/constants.tsx` e em `apps/storefront/src/modules/order/components/payment-details/index.tsx`.

## Escopo implementado

- **Checkout transparente** com **Payment Brick** (`@mercadopago/sdk-react`, componente `Payment`): crédito, débito e Pix (`bankTransfer`).
- **Orders API** (`/v1/orders`), `type: 'online'`, `processing_mode: 'automatic'`, `currency: 'BRL'` fixa. Ver [ADR-002](../decisions/ADR-002-orders-api-automatic-capture.md).
- Cartão e Pix usam **o mesmo provider** (`pp_mercadopago`). A diferença está só em `session.data` (ver "Discriminação cartão × Pix").
- Webhook com validação HMAC: [webhook.md](webhook.md).
- Reembolso e cancelamento: implementados (`refundPayment`, `cancelPayment`), **sem testes** e **[não validado]** em uso real.

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `apps/backend/src/modules/mercadopago/service.ts` | Provider: ciclo de vida da session, criação de Orders, status, Pix. |
| `apps/backend/src/api/hooks/payment/[provider]/route.ts` | Webhook (HMAC + correlação). |
| `apps/backend/src/api/store/mercadopago/payment-sessions/[id]/route.ts` | Grava dados do Brick na session (allowlist). |
| `apps/backend/src/api/store/mercadopago/payment-sessions/[id]/pix/route.ts` | Prepara/regenera a cobrança Pix. |
| `apps/backend/src/api/store/mercadopago/carts/[id]/pix/route.ts` | Estado da cobrança Pix do cart (polling). |
| `apps/backend/src/api/store/mercadopago/orders/[id]/pix/route.ts` | Dados Pix do pedido. |
| `apps/backend/src/workflows/payment-access/` | Emissão (`issuePixPaymentAccessWorkflow`, regra em `pix-access-binding.ts`) e revogação (`revokePaymentSessionAccessWorkflow`) da capability Pix. |
| `apps/backend/src/api/utils/pix-payment-access.ts` | Anexa a capability emitida aos headers da resposta do prepare. |
| `apps/backend/src/api/store/mercadopago/payment-access/pix/route.ts` | Leitura do Pix autorizada pela capability. |
| `apps/backend/src/modules/mercadopago/pix-access-view.ts` | `toPixAccessDto`: allowlist por estado e deadline. |
| `apps/storefront/src/modules/checkout/components/mercadopago-payment-container/index.tsx` | Brick + `onSubmit`. |
| `apps/storefront/src/modules/order/components/payment-details/pix-payment-panel.tsx` | Painel Pix da Review. |
| `apps/storefront/src/modules/checkout/components/payment-button/index.tsx` | `MercadoPagoPaymentButton` → `placeOrder`. |

## Fluxo: cartão

1. Checkout cria a Payment Session → `initiatePayment` grava `amount`, `currency_code`, `mercadopago_status: 'prepared'` e `mercadopago_idempotency_key`.
2. Brick `onSubmit(param, additionalData)` → `POST /store/mercadopago/payment-sessions/:id` com `card_token`, `payment_method_id`, `payment_type_id` (= `additionalData.paymentTypeId`: `credit_card` ou `debit_card`), `issuer_id`, `installments`, `transaction_amount`, `amount`, `currency_code`, `cart_id`, `payer`. A rota filtra pela allowlist, confere a posse da session e chama `updatePaymentSession` → `updatePayment` (**não autoriza**).
3. "Place order" → `placeOrder` → `sdk.store.cart.complete` → Medusa chama `authorizePayment`.
4. `authorizePayment` revalida `payment_type_id` e cria a Order na Orders API com `payment_method: { id, token, type: <payment_type_id>, installments }` e a idempotency key da session. Sem o campo, ou com valor fora do contrato, recusa sem chamar a API ([ADR-005](../decisions/ADR-005-card-payment-type-from-brick.md)). O status é mapeado por `getStatusFromGateway`.
5. O webhook confirma de forma assíncrona ([webhook.md](webhook.md)).

## Fluxo: Pix

1. Brick `onSubmit` com `formData.payment_method_id === "pix"` → mesma rota do passo 2 do cartão, com `payment_method_id: "pix"`, `amount`, `currency_code`, `cart_id`, `payer`.
2. Na Review, `PixPaymentPanel` chama `POST /store/mercadopago/payment-sessions/:id/pix` uma vez por session. A rota injeta o campo transitório `mercadopago_pix_action` (`prepare` ou `regenerate`) e chama `updatePaymentSession` → `updatePayment` → `preparePixOrder`:
   - Order Pix existente, pagável e com o mesmo valor → reutiliza.
   - Já paga → devolve como está (nunca substitui).
   - Caso contrário → cancela a anterior (se pendente) e cria outra com a próxima "geração" de idempotency key.
   - Toda Order Pix nova é criada com `transactions.payments[].expiration_time: "PT1H"`. A deadline conservadora (`computePixDeadline`) fica em `mercadopago_pix_expires_at` e é o `expires_at` dos DTOs ([ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)).
   - A session continua `pending`. Ver [ADR-003](../decisions/ADR-003-pix-charge-created-at-review.md).
   - Em seguida a rota roda `issuePixPaymentAccessWorkflow` e, se couber, emite uma capability de leitura `pix_payment_view` ([ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)). O token vai **só** nos headers de resposta `x-payment-access-token` e `x-payment-access-expires-at`, nunca no corpo. Falha na emissão não falha o prepare (fica só sem capability).
3. O painel faz polling de `GET /store/mercadopago/carts/:id/pix` (5 s, máx. 180). Enquanto o status não é terminal, a rota lê a Order ao vivo no Mercado Pago (só leitura; não grava na session). Depois de `completed_at` (por exemplo, o webhook concluiu o cart com a Review aberta), a rota responde **410 sem corpo**: o painel esconde QR e ticket, informa que o pedido já foi concluído e libera "Place order", que devolve o pedido existente porque o `completeCartWorkflow` do Medusa 2.20.1 é idempotente (link `order_cart`).
4. "Place order" só é liberado com a cobrança `pending` com dados pagáveis (QR/copia-e-cola/ticket) ou `approved`.
5. `completeCart` → `authorizePayment` → `authorizePix`. Se já existe Order: `reauthorizePixOrder` (lê a Order, confere o valor e mapeia com `resolvePixStatus`). Se não existe: cria a Order (fallback).
6. Pagamento confirmado pelo webhook → evento → `getWebhookActionAndData` → `captured`.
7. Página do pedido lê `GET /store/mercadopago/orders/:id/pix`.

`pending_authorization` é suportado pelo `completeCart` do Medusa 2.20.1: o pedido é criado com o Pix ainda pendente, e o pagamento chega depois pelo webhook (`processPaymentWorkflow`). Evidência E2E em [../status.md](../status.md#evidência-e2e).

### Troca de método e remoção de session

- `updatePayment` sem ação, com Order Pix anexada e session que deixou de ser Pix → cancela a Order Pix (se pendente) e remove os campos Pix.
- `deletePayment` (session removida, provider trocado ou total do cart alterado) → mesma invalidação.
- Order Pix já paga nunca é descartada: lança `NOT_ALLOWED`.

## Discriminação cartão × Pix (`isPixSession` / `getPixSignals`)

- Sinais Pix: `paymentType === 'bank_transfer'`, `payment_method_id === 'pix'`, `payment_method.id === 'pix'`.
- Sinais não-Pix: `payment_method_id` ou `payment_method.id` presentes e diferentes de `'pix'`.
- Os dois presentes → erro `INVALID_DATA` antes de qualquer chamada externa.
- A ausência de campos de cartão **não** é sinal de Pix.
- `hasPixOrderData` distingue uma Order Pix de uma Order de cartão (ambas têm `mercadopago_order_id`) por `mercadopago_order_payment_method === 'pix'` ou pela presença de campos de QR/ticket.

## Mapeamento de status

**Cartão e webhook** — `getStatusFromGateway(paymentStatus, orderStatus)`:

| Mercado Pago | Medusa |
|---|---|
| `processed`, `approved` | `captured` |
| `authorized` | `authorized` |
| `pending`, `in_process` | `pending` |
| `cancelled`, `canceled` | `canceled` |
| `rejected`, `failed`, `error`, `declined` (apenas no status do payment, não da Order) | `error` |
| `in_mediation`, `requires_more` | `requires_more` |
| qualquer outro | `pending` (padrão) |

**Pix** — `normalizePixStatus` (status de apresentação; a Order tem prioridade e o payment é o fallback) → `resolvePixStatus` (status Medusa em `authorizePayment`):

| Mercado Pago | Display | Medusa |
|---|---|---|
| `processed`, `approved`, `accredited` | `approved` | `captured` |
| `action_required` | `pending` | `pending_authorization` |
| `created`, `processing`, `in_process`, `in_review` | `processing` | `pending_authorization` |
| `expired` | `expired` | `canceled` |
| `canceled`, `cancelled` | `canceled` | `canceled` |
| `refunded` / `charged_back` | idem | `canceled` |
| `failed` / `rejected` | idem | `error` |
| qualquer outro | `unknown` | **lança erro** `UNEXPECTED_STATE` |

`toPixPaymentDto` exibe `approved` sempre que a session Medusa já está `authorized`, independentemente do último status Mercado Pago armazenado.

## Campos em `payment_session.data`

- **Escritos pelo cliente (via allowlist):** `card_token`, `payment_method_id`, `payment_type_id` (só `credit_card`/`debit_card`), `issuer_id`, `installments`, `transaction_amount`, `amount`, `currency_code`, `cart_id`, `payer.{email, identification.{type, number}}`.
- **Escritos apenas pelo provider:** todos os `mercadopago_*`, por exemplo `mercadopago_order_id`, `mercadopago_payment_id`, status e detalhes, `mercadopago_external_reference`, `mercadopago_idempotency_key`, `mercadopago_pix_*` (QR, ticket, expiração, idempotency key, geração).
- **Transitório, nunca persistido:** `mercadopago_pix_action`.
- A lista de campos da Order Pix atual está em `PIX_ORDER_FIELDS` (`service.ts`).
- O Payment criado a partir da session guarda uma cópia desses campos em `payment.data`.

### Interno × público

Todos os campos acima continuam gravados, porque têm consumidor no backend: provider, webhook ou rotas `/store/mercadopago/*`. O que chega ao storefront é separado assim:

| Caminho | O storefront recebe |
|---|---|
| Store API genérica (`/store/carts*`, `/store/payment-collections*`, `/store/orders*`) | `data` de sessions e payments do Mercado Pago reduzido a `{ payment_method_id }` (invariante 24, [ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md)). A Review usa esse campo para detectar Pix. |
| `GET /store/mercadopago/carts/:id/pix` | Cart aberto: DTO `toPixPaymentDto` com `status` (display), `charge_ref`, QR, copia e cola, ticket e `expires_at`. `charge_ref` é uma referência opaca da cobrança atual (hash truncado, não é ID do Mercado Pago); o painel a usa para abrir o QR uma vez por cobrança. Cart concluído: 410 sem corpo. |
| `GET /store/mercadopago/orders/:id/pix` | DTO da página do pedido: só `status` (da session) e `ticket_url`, e só quando o pedido tem uma session Pix (`payment_method_id === "pix"`); nos outros casos, 404. Sem QR, copia e cola nem expiração: a página do pedido só informa o resultado. |
| `POST /store/mercadopago/payment-sessions/:id/pix` | Mesmo DTO da rota do cart. A capability Pix vai só nos headers de resposta. |
| `GET /store/mercadopago/payment-access/pix` | Autorizada só pela capability no header `x-payment-access-token` (nunca query string); o cliente não informa `order_id` nem session. DTO `toPixAccessDto`: pendente e antes da deadline → `status`, `order_id`, `charge_ref`, QR, copia e cola, ticket, `expires_at`; pago, final ou depois da deadline → só `status` e `order_id`. Qualquer falha → o mesmo 404 genérico. `order_id` serve só para o Next Server conferir o pedido da página. |

Nunca saem para o storefront: `card_token`, `issuer_id`, `installments`, `payer`, idempotency keys, IDs do Mercado Pago (`mercadopago_order_id`, `mercadopago_payment_id`), `mercadopago_external_reference`, geração Pix, status nativos do Mercado Pago nem o status da session.
