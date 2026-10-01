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
- Reembolso (`refundPayment`): total sem body, parcial com `transactions[{ id, amount }]`, uma idempotency key por reembolso (`refund.id`). Testes unitários e E2E no sandbox (2026-09-29, cartão e Pix). Regras: invariantes 42–44; decisão: [ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md); evidências: [INV-004](../investigations/INV-004-refund-payment-amount-and-idempotency.md).
- Cancelamento (`cancelPayment`): implementado, com testes unitários (`cancel-payment.unit.spec.ts`; invariante 48). Exercitado no sandbox em 2026-09-30 só por chamada direta ao provider, numa Order de cartão com captura manual. O checkout não cria Order de cartão cancelável: [status.md](../status.md#cancelpayment-do-cartão-2026-09-30).

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `apps/backend/src/modules/mercadopago/service.ts` | Provider: ciclo de vida da session, criação de Orders, status, Pix. |
| `apps/backend/src/api/hooks/payment/[provider]/route.ts` | Webhook (HMAC + correlação). |
| `apps/backend/src/api/store/mercadopago/payment-sessions/[id]/route.ts` | Grava dados do Brick na session (allowlist). |
| `apps/backend/src/api/store/mercadopago/payment-sessions/[id]/pix/route.ts` | Prepara/regenera a cobrança Pix. |
| `apps/backend/src/api/store/mercadopago/carts/[id]/pix/route.ts` | Estado da cobrança Pix do cart (polling). |
| `apps/backend/src/workflows/payment-access/` | Emissão (`issuePixPaymentAccessWorkflow`, regra em `pix-access-binding.ts`) e revogação (`revokePaymentSessionAccessWorkflow`) da capability Pix. |
| `apps/backend/src/api/admin/orders/[id]/cancel/route.ts` | Sobrescreve `POST /admin/orders/:id/cancel` do core para executar o workflow abaixo; mesma entrada, resposta e autenticação ([ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)). |
| `apps/backend/src/workflows/cancel-order-with-pending-pix.ts` | Workflow de cancelamento de pedido: `cancelValidateOrder` → cancela o Pix pendente → `cancelOrderWorkflow.runAsStep` ([ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)). |
| `apps/backend/src/workflows/steps/cancel-pending-pix-charge.ts` | Step compartilhado: seleciona o Pix pendente do pedido e o cancela pela ação `cancel` do provider. |
| `apps/backend/src/workflows/hooks/order-canceled.ts` | Hook `orderCanceled` do `cancelOrderWorkflow`: rede de segurança para chamadas diretas ao workflow, com a mesma função do step (`cancelPendingPixChargeForOrder`) ([ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md)). |
| `apps/backend/src/modules/mercadopago-card-attempt/` | Módulo `mercadopagoCardAttempt` (tabela `mercadopago_card_attempt`, migration `Migration20260930030200`), declarado em `dependencies` do payment module ([ADR-015](../decisions/ADR-015-card-ambiguous-order-reconciliation.md), aceito). Máquina de estados (`transitions.ts`, `service.ts`) e criptografia do token (`card-token-crypto.ts`, AES-256-GCM). Usado pelo provider, pela rota de update da session e pelo fallback do webhook. |
| `apps/backend/src/api/utils/pix-payment-access.ts` | Anexa a capability emitida aos headers da resposta do prepare. |
| `apps/backend/src/api/store/mercadopago/payment-access/pix/route.ts` | Leitura do Pix autorizada pela capability. |
| `apps/backend/src/modules/mercadopago/pix-access-view.ts` | `toPixAccessDto`: allowlist por estado e deadline. |
| `apps/storefront/src/modules/checkout/components/mercadopago-payment-container/index.tsx` | Brick + `onSubmit`. |
| `apps/storefront/src/modules/order/components/payment-details/pix-payment-panel.tsx` | Painel Pix da Review. |
| `apps/storefront/src/modules/checkout/components/payment-button/index.tsx` | `MercadoPagoPaymentButton` → `placeOrder`. |

## Fluxo: cartão

1. Checkout cria a Payment Session → `initiatePayment` grava `amount`, `currency_code`, `mercadopago_status: 'prepared'` e `mercadopago_idempotency_key`.
2. Brick `onSubmit(param, additionalData)` → `POST /store/mercadopago/payment-sessions/:id` com `card_token`, `payment_method_id`, `payment_type_id` (= `additionalData.paymentTypeId`: `credit_card` ou `debit_card`), `issuer_id`, `installments`, `transaction_amount`, `amount`, `currency_code`, `cart_id`, `payer`. A rota filtra pela allowlist, confere a posse da session e chama `updatePaymentSession` → `updatePayment` (**não autoriza**). Para cartão, o `card_token` vai só para `submitAttempt` do módulo `mercadopagoCardAttempt` (cifrado, [ADR-015](../decisions/ADR-015-card-ambiguous-order-reconciliation.md)), e `session.data` guarda só o `card_attempt_id`. Com tentativa `authorizing`/`unknown`/`expired`, qualquer update é recusado (`card_attempt_pending` / `card_attempt_manual_review`), e a troca para Pix libera a tentativa `submitted`.
3. "Place order" → `placeOrder` → `sdk.store.cart.complete` → Medusa chama `authorizePayment`.
4. `authorizePayment` revalida `payment_type_id` e cria a Order na Orders API com `payment_method: { id, token, type: <payment_type_id>, installments }` e uma idempotency key derivada da chave base da session e do body canônico: o mesmo body (retry) reutiliza a chave e uma nova tentativa na mesma session usa outra ([ADR-014](../decisions/ADR-014-card-order-idempotency-key-from-body.md), invariante 47). Sem o campo, ou com valor fora do contrato, recusa sem chamar a API ([ADR-005](../decisions/ADR-005-card-payment-type-from-brick.md)). O status é mapeado por `getStatusFromGateway`.
5. O webhook confirma de forma assíncrona ([webhook.md](webhook.md)).

## Fluxo: Pix

1. Brick `onSubmit` com `formData.payment_method_id === "pix"` → mesma rota do passo 2 do cartão, com `payment_method_id: "pix"`, `amount`, `currency_code`, `cart_id`, `payer`.
2. Na Review, `PixPaymentPanel` chama `POST /store/mercadopago/payment-sessions/:id/pix` uma vez por session. A rota injeta o campo transitório `mercadopago_pix_action` (`prepare` ou `regenerate`; `cancel` é reservado ao cancelamento do pedido, pelo step `cancel-pending-pix-charge`) e chama `updatePaymentSession` → `updatePayment` → `preparePixOrder`:
   - Order Pix existente, pagável e com o mesmo valor → reutiliza.
   - Já paga → devolve como está (nunca substitui).
   - Caso contrário → cancela a anterior (se pendente) e cria outra com a próxima "geração" de idempotency key.
   - Toda Order Pix nova é criada com `transactions.payments[].expiration_time: "PT1H"`. A deadline conservadora (`computePixDeadline`) fica em `mercadopago_pix_expires_at` e é o `expires_at` dos DTOs ([ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)).
   - A session continua `pending`. Ver [ADR-003](../decisions/ADR-003-pix-charge-created-at-review.md).
   - Em seguida a rota roda `issuePixPaymentAccessWorkflow` e, se couber, emite uma capability de leitura `pix_payment_view` ([ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)). O token vai **só** nos headers de resposta `x-payment-access-token` e `x-payment-access-expires-at`, nunca no corpo. Falha na emissão não falha o prepare (fica só sem capability).
3. O painel faz polling de `GET /store/mercadopago/carts/:id/pix` (5 s, máx. 180). Enquanto o status não é terminal, a rota lê a Order ao vivo no Mercado Pago (só leitura; não grava na session). Depois de `completed_at` (por exemplo, o webhook concluiu o cart com a Review aberta), a rota responde **410 sem corpo**: o painel esconde QR e ticket, informa que o pedido já foi concluído e libera "Place order", que devolve o pedido existente porque o `completeCartWorkflow` do Medusa 2.20.1 é idempotente (link `order_cart`).
4. "Place order" só é liberado com a cobrança `pending` com dados pagáveis (QR/copia-e-cola/ticket) ou `approved`. Depois da deadline local não há dados pagáveis (ADR-008): o painel informa que o prazo acabou e oferece "Generate new Pix".
5. `completeCart` → `authorizePayment` → `authorizePix`. Se já existe Order: `reauthorizePixOrder` (lê a Order, confere o valor e mapeia com `resolvePixStatus`). Se não existe: cria a Order (fallback).
6. Pagamento confirmado pelo webhook → evento → `getWebhookActionAndData` → `captured`.
7. A página do pedido lê o Pix com a capability do browser: `retrieveOrderPixPayment` (Server Action) → `readPixPaymentAccess` (server-only, cookie HttpOnly) → `GET /store/mercadopago/payment-access/pix`. O `order_id` da URL só é comparado com o pedido da capability. `OrderPixPayment` mostra o status e, enquanto pagável, o QR/copia e cola/ticket num modal, com polling pelo mesmo Server Action. Sem capability válida para aquele pedido (outro browser, capability expirada), a página não mostra dados Pix.

`pending_authorization` é suportado pelo `completeCart` do Medusa 2.20.1: o pedido é criado com o Pix ainda pendente, e o pagamento chega depois pelo webhook (`processPaymentWorkflow`). Evidência E2E em [../status.md](../status.md#evidência-e2e).

### Troca de método e remoção de session

- `updatePayment` sem ação, com Order Pix anexada e session que deixou de ser Pix → cancela a Order Pix (se pendente) e remove os campos Pix.
- `deletePayment` (session removida, provider trocado ou total do cart alterado) → mesma invalidação.
- Order Pix já paga nunca é descartada: lança `NOT_ALLOWED`.
- **Cancelamento do pedido Medusa com Pix pendente** (cenário A, sem Payment): o `cancelOrderWorkflow` do core não chama o provider e, se revertido depois de `updatePaymentCollectionStep`, deixa a collection `canceled` ([INV-006](../investigations/INV-006-payment-collection-rollback.md)). Por isso `POST /admin/orders/:id/cancel` executa `cancel-order-with-pending-pix`: valida o pedido como o core, cancela o Pix pendente pelo provider (ação `cancel` → `invalidatePixOrder`) e só então roda o `cancelOrderWorkflow`. Pix já pago sem webhook processado, ou falha ao ler/cancelar no Mercado Pago → o cancelamento é recusado antes do core (pedido e collection intactos). Pix com Payment capturado → o core reembolsa, sem ação Pix. Session termina `canceled`, e a confirmação mostra o Pix cancelado. O hook `orderCanceled` usa a mesma função do step (`cancelPendingPixChargeForOrder`) para chamadas diretas ao workflow. Invariantes 45 e 46, [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md) (substitui em parte o [ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md)), evidências na [INV-005](../investigations/INV-005-cancel-order-with-pending-pix.md) e na [INV-006](../investigations/INV-006-payment-collection-rollback.md).

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

- **Escritos pelo cliente (via allowlist):** `payment_method_id`, `payment_type_id` (só `credit_card`/`debit_card`), `issuer_id`, `installments`, `transaction_amount`, `amount`, `currency_code`, `cart_id`, `payer.{email, identification.{type, number}}`.
- **Recebido do cliente e nunca persistido em `data`:** `card_token`, que vai cifrado para a tentativa do módulo `mercadopagoCardAttempt`. A rota grava em `data` só o `card_attempt_id` (o cliente não o escreve) e remove um `card_token` antigo.
- **Escritos pela rota de update, a partir do cart (só Pix):** `payer.first_name`/`payer.last_name`, lidos do `billing_address` do cart; o cliente não os fornece (invariante 40, [ADR-010](../decisions/ADR-010-pix-payer-name-from-billing-address.md)). O `createPixOrder` os envia porque envia `session.data.payer` (invariante 41).
- **Escritos apenas pelo provider:** todos os `mercadopago_*`, por exemplo `mercadopago_order_id`, `mercadopago_payment_id`, status e detalhes, `mercadopago_external_reference`, `mercadopago_idempotency_key`, `mercadopago_pix_*` (QR, ticket, expiração, idempotency key, geração).
- **Transitório, nunca persistido:** `mercadopago_pix_action`.
- A lista de campos da Order Pix atual está em `PIX_ORDER_FIELDS` (`service.ts`).
- O Payment criado a partir da session guarda uma cópia desses campos em `payment.data`.

### Prazo da tentativa de cartão (implementação atual)

Conferido no código do working tree sobre `e822f52` (2026-09-30, sem commit). Decisão: [ADR-016](../decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md), que substitui em parte a decisão 12 do [ADR-015](../decisions/ADR-015-card-ambiguous-order-reconciliation.md). O prazo é `created_at + 24 h`, avaliado pelo relógio do PostgreSQL (`PAST_DEADLINE_SQL`, `attempt-states.ts`).

- **O prazo controla o replay, a decifração e a retenção do ciphertext. Ele não encerra a tentativa.** Nenhum caminho do código leva uma tentativa a `expired` pelo prazo: a regra 10 continua na tabela (`transitions.ts`), mas nada a chama. Não existe job para tentativas; o único job do projeto é `cleanup-payment-access-grants`.
- **Retenção.** Um Place order depois do prazo anula o ciphertext sem transição (`destroyCardTokenForRetention`), antes de qualquer outra coisa. `readCardToken` e `beginAuthorization` depois do prazo também o anulam e recusam. Tentativas abandonadas (sem Place order depois do prazo) continuam com o ciphertext; a limpeza periódica é decisão posterior (ADR-016).
- **`submitted` depois do prazo:** nenhuma transição. O Place order responde como recusa ("the card must be submitted again"); só um novo envio do Brick a substitui (regra 2).
- **`unknown`, ou `authorizing` parada, depois do prazo, sem Order registrada:** o provider resolve pela busca da Order (`resolveCardAttemptAfterDeadline`, `service.ts`), só com `GET`, nunca `POST`.
  - `authorizing` recente: `card_attempt_in_progress`, sem busca. Parada: vai antes a `unknown` (regra 8, `markUnknownIfStale`).
  - `Q` (30 min desde `authorizing_at`) ainda não atingido: `card_attempt_pending`, sem busca.
  - A busca usa o `external_reference` exato e a janela `[authorization_started_at − 1 h, min(now, authorizing_at + 1 h)]`.
  - 1 Order coerente (mesmo `external_reference` na busca e no `GET`, mesmo valor, com payment): associada por `recordOrder`. Se estiver paga ou `failed`/`canceled`, segue `settleKnownCardOrder` (regras 12 e 9); em status não final, a tentativa continua bloqueante (`card_attempt_pending`).
  - `total = 0`: só encerra a tentativa pela regra 13 (`failUnknownWithoutOrder`) com `H` aprovado e a última tentativa de `POST` mais nova que `H`. **`H` não tem valor aprovado** (`CARD_ATTEMPT_SEARCH_HORIZON_HOURS = null`), então hoje responde `card_attempt_manual_review` sem escrever nada.
  - Erro da API, resposta estruturalmente inválida ou `total ≠ data.length`: `card_attempt_pending`. `total > 1`, `external_reference` ou valor divergentes: `card_attempt_manual_review`. Nenhum desses resultados escreve.
  - Depois de um compare-and-set com 0 linhas, a decisão vem só do estado relido (`afterLostCardAttemptRace`), nunca da busca anterior.
- **Tentativa encerrada:** o Place order corrente termina sem autorizar um cartão novo. Um novo pagamento exige um novo envio do Brick, que cria uma tentativa nova (novo token, `card_attempt_id`, `external_reference`, body e idempotency key), sempre numa Payment Session `pending`:
  - **regra 9** (Order `failed`/`canceled`): `settleKnownCardOrder` devolve `status: error`, o Payment Module grava a session como `error` e a rota `complete` responde 400 `not_allowed`. Uma session `error` nunca é reutilizada (o `completeCartWorkflow` não a processa). O storefront inicia uma **nova** Payment Session (`initiatePaymentSession`, `POST /store/payment-collections/:id/payment-sessions`); o core remove a antiga pelo `deletePayment`, que aceita a tentativa `failed` sem mudança, e o Brick vai para a nova session. Comprovado no E2E 2b [sandbox 2026-10-01] (1 `POST` novo, 1 Payment, 1 Capture, 1 pedido);
  - **regra 13** (`total = 0`, hoje desligada porque `H = null`): o provider lança um erro simples, a session continua `pending` e o core responde 200 `PAYMENT_AUTHORIZATION_ERROR`. Pelo código; não exercitado em runtime.
- **`expired`** (tentativas antigas, expiradas antes do ADR-016): continuam só com o operador (regra 11).
- **Webhook:** sem mudança. O fallback por tentativa e a regra 12 não conferem o prazo nem usam o token.
- **Contrato com o storefront:** [ADR-016, seção 4.6](../decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md#46-contrato-mínimo-com-o-storefront). O storefront ainda não trata esses códigos.

### Interno × público

Todos os campos acima continuam gravados, porque têm consumidor no backend: provider, webhook ou rotas `/store/mercadopago/*`. O que chega ao storefront é separado assim:

| Caminho | O storefront recebe |
|---|---|
| Store API genérica (`/store/carts*`, `/store/payment-collections*`, `/store/orders*`) | `data` de sessions e payments do Mercado Pago reduzido a `{ payment_method_id }` (invariante 24, [ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md)). A Review usa esse campo para detectar Pix. |
| `GET /store/mercadopago/carts/:id/pix` | Cart aberto: DTO `toPixPaymentDto` com `status` (display), `charge_ref`, QR, copia e cola, ticket e `expires_at`; depois da deadline local, sem QR/copia e cola/ticket e com `payment_window_closed: true`, mantendo o status do provider ([ADR-008](../decisions/ADR-008-pix-payment-window-hides-artifacts.md)). `charge_ref` é uma referência opaca da cobrança atual (hash truncado, não é ID do Mercado Pago); o painel a usa para abrir o QR uma vez por cobrança. Cart concluído: 410 sem corpo. |
| `POST /store/mercadopago/payment-sessions/:id/pix` | Mesmo DTO da rota do cart. A capability Pix vai só nos headers de resposta. |
| `GET /store/mercadopago/payment-access/pix` | Autorizada só pela capability no header `x-payment-access-token` (nunca query string); o cliente não informa `order_id` nem session. DTO `toPixAccessDto`: `status` do provider + `payment_window_closed` + `order_id` sempre; com `pending` e janela aberta também `charge_ref`, QR, copia e cola, ticket e `expires_at`; com a janela fechada nada pagável, qualquer que seja o status ([ADR-009](../decisions/ADR-009-payment-access-keeps-provider-status.md)). Qualquer falha → o mesmo 404 genérico. `order_id` serve só para o Next Server conferir o pedido da página. |

Nunca saem para o storefront: `card_token`, `issuer_id`, `installments`, `payer` (inclusive o nome), idempotency keys, IDs do Mercado Pago (`mercadopago_order_id`, `mercadopago_payment_id`), `mercadopago_external_reference`, geração Pix, status nativos do Mercado Pago nem o status da session.
