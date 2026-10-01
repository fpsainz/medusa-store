# INV-010: o upgrade para o Medusa 2.21.2 preserva o comportamento validado no 2.20.1?

> Status: concluída (análise de código e regressão mínima em runtime: 5 de 5 PASS) · Aberta em: 2026-10-01 · Concluída em: 2026-10-01 · Commit: `bdefe51`

Marcadores de origem: [../README.md](../README.md#convenções). **[core 2.21.2]** indica a comparação dos pacotes 2.20.1 e 2.21.2 instalados em `node_modules/.pnpm` (`dist`), lidos em 2026-10-01; não é execução. **[sandbox 2026-10-01]** indica a regressão em runtime descrita em [Validação em runtime](#validação-em-runtime-sandbox-2026-10-01).

## Achado

O commit `bdefe51` atualiza o core do Medusa de 2.20.1 para 2.21.2 [commit `bdefe51`]. Toda a evidência E2E e boa parte das afirmações sobre o core nas investigações e nos ADRs foram obtidas no 2.20.1. Até que seja revalidada, ela não vale automaticamente para o 2.21.2.

## Fatos

### Pacotes

- Backend: todos os `@medusajs/*` em 2.21.2; `@medusajs/ui` 4.2.6. Storefront: `@medusajs/js-sdk`, `@medusajs/ui-preset` e `@medusajs/types` em 2.21.2. Raiz: `@medusajs/eslint-plugin` 2.21.2 [commit `bdefe51`].
- **Exceção:** `@medusajs/icons` continua em 2.20.1 no storefront; é o único `@medusajs` 2.20.1 no `pnpm-lock.yaml`. O motivo não está registrado.

### Comparação do core nos pontos de que o projeto depende [core 2.21.2]

| Ponto | Resultado | Evidência |
|---|---|---|
| `pending_authorization` no `complete-cart` | não mudou | `core-flows`: `cart/workflows/complete-cart.js`, `cart/steps/validate-cart-payments.js`, `payment/steps/authorize-payment-session.js` idênticos |
| `createPaymentSessionsWorkflow` (remoção das sessions anteriores) | não mudou | `payment-collection/workflows/create-payment-session.js` idêntico |
| `cancelOrderWorkflow` e sua compensação | não mudou | `order/workflows/cancel-order.js` e `payment-collection/steps/update-payment-collection.js` idênticos; o defeito de compensação da [INV-006](INV-006-payment-collection-rollback.md) continua no código |
| Caminho até `cancelPayment` | não mudou | `payment/steps/cancel-payment.js` idêntico; `cancelPayment` do `@medusajs/payment` (`services/payment-module.js`) sem diff |
| `refundPaymentWorkflow` | não mudou | `payment/workflows/refund-payment.js` idêntico |
| `completeCartAfterPaymentStep` | não mudou | `payment/steps/complete-cart-after-payment.js` idêntico |
| `processPaymentWorkflow` | **mudou** | `payment/workflows/process-payment.js`: no ramo de auto-captura (`PaymentActions.SUCCESSFUL` sem Payment), a captura passou para um `when` próprio (`capture-payment-autocapture-condition`) e só roda se `authorizePaymentSessionStep` devolver um Payment. No 2.20.1 ela usava `payment.id` sem essa checagem |

Outras diferenças relevantes para o projeto:

- **`capturePayment`** (`@medusajs/payment`, `services/payment-module.js`): passa a gravar `created_by` (coluna da `capture` desde `Migration20240225134525`) em vez de `captured_by`. Nenhum código do projeto lê ou grava esses campos.
- **`getWebhookActionAndData`** (`services/payment-module.js`): aceita `provider` já com o prefixo `pp_`. A rota `src/api/hooks/payment/[provider]/route.ts` emite o evento com o `provider` do path (`mercadopago`), que continua resolvido como `pp_mercadopago`.
- **Store API** (`@medusajs/medusa`, `api/store/{carts,orders,payment-collections}/query-config.js`): a validação de `?fields=` passou de lista de campos proibidos para lista de campos permitidos (`allowed_fields`). `payment_collection.payment_sessions.data` (carts) e `payment_sessions.data` (payment-collections) continuam permitidos.
- **`GET /store/orders/:id`**: só mudou o comentário (rota sem autenticação por decisão do core); o comportamento descrito na [INV-002](INV-002-store-order-retrieve-without-auth.md) não mudou no código.
- **`@medusajs/link-modules`**: novo link só leitura `order-shipping-option`; o link `order-payment-collection` usado pelo [ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md) não mudou.
- `cart/workflows/create-carts.js`: `currency_code` informado precisa ser o da região (BRL aqui).

### Migrations [banco 2026-10-01]

- Únicas migrations novas do 2.21.2: `Migration20260903085616` e `Migration20260911115931`, do `@medusajs/search` (tabela `search_index_version`; colunas de `search_index` e `search_index_sync`). Nenhuma toca pagamento, cart ou pedido. Os scripts de migration são os mesmos do 2.20.1.
- As duas foram executadas em 2026-10-01 02:08Z pelo `db:migrate` [decisão humana 2026-10-01]. Depois disso, nenhuma migration pendente nos módulos carregados pelo projeto (nomes no disco × `mikro_orm_migrations`; só `SELECT`). Os não executados são de módulos que o projeto não carrega (`index`, `locking-postgres`, `rbac`, `translation`, `workflow-engine-redis`) e do script `create-super-admin-role` (só com o feature flag `rbac`).

### Verificação automatizada (2026-10-01, `bdefe51`)

Backend com 23 suítes e 569 testes; `tsc --noEmit` limpo; `medusa build` passando (lint com 0 erros e os 2 warnings conhecidos); `next build` passando.

## Impacto nos documentos

O que cada documento afirma sobre o core foi verificado no 2.20.1. Situação no 2.21.2:

| Documento | Dependência do core | 2.21.2: código | 2.21.2: runtime |
|---|---|---|---|
| [webhook.md](../mercadopago/webhook.md#estados-depois-de-uma-order-paga) | auto-captura do `processPaymentWorkflow` | **mudou**; no caminho do projeto (`authorizePayment` devolve `captured`), o Payment existe e a captura continua | ✅ #146 (cenário 3) |
| [ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md), invariante 24 | campos padrão e `?fields=` da Store API | **mudou** a política de campos; `data` das sessions continua permitido, então a redação continua necessária | ✅ cenário 4 |
| [INV-007](INV-007-payment-button-first-session.md) | `createPaymentSessionsWorkflow` | não mudou | não revalidado (fora do plano) |
| [README do Mercado Pago](../mercadopago/README.md), [ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md) | `pending_authorization` no `complete-cart` | não mudou | ✅ #147 (cenário 5) |
| [ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md), [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md), [INV-005](INV-005-cancel-order-with-pending-pix.md), [INV-006](INV-006-payment-collection-rollback.md) | `cancelOrderWorkflow`, compensação, rota do Admin sobrescrita | não mudou | ✅ caminho feliz #145, #147 (cenário 5); compensação com falha não reproduzida |
| [ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md), [INV-004](INV-004-refund-payment-amount-and-idempotency.md) | `refundPaymentWorkflow`, `refundPayment` do módulo | não mudou | ✅ reembolso total pelo cancelamento #145; parcial não revalidado |
| [ADR-015](../decisions/ADR-015-card-ambiguous-order-reconciliation.md), [ADR-016](../decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md), [INV-009](INV-009-card-ambiguous-order-reconciliation.md) | `completeCartWorkflow`, `authorizePaymentSession`, `dependencies` do payment module | não mudou nos workflows lidos | ✅ caminho feliz #145 (tentativa `resolved`); cenários ambíguos e de prazo não revalidados |
| [ADR-001](../decisions/ADR-001-provider-identity-pp-mercadopago.md) | token `pp_mercadopago` | `getWebhookActionAndData` aceita o prefixo; token inalterado | ✅ webhooks reais resolvidos para `pp_mercadopago` (cenários 2, 3, 5) |
| [INV-002](INV-002-store-order-retrieve-without-auth.md) | `GET /store/orders/:id` | só comentário | não revalidado (fora do plano) |

## Hipóteses

- H1: o fluxo de pagamento do projeto (cartão, Pix, webhook, reembolso, cancelamento) se comporta no 2.21.2 como no 2.20.1. **Confirmada** nos caminhos da regressão mínima [sandbox 2026-10-01].
- H2: a mudança do `processPaymentWorkflow` não afeta o projeto, porque o provider nunca devolve autorização adiada no ramo de auto-captura. **Confirmada** no caminho Pix pago pelo webhook (#146) [sandbox 2026-10-01].
- H3: a redação do ADR-006 continua efetiva com a nova política de campos da Store API. **Confirmada** [sandbox 2026-10-01].

## Plano de validação

Regressão mínima no sandbox, sem repetir os cenários das INVs:

1. Boot do backend em 2.21.2 sem erros.
2. Pedido com cartão (Place order, 1 Payment, 1 Capture).
3. Pix pago concluído pelo webhook, sem Place order (H2).
4. `GET /store/carts/:id` e `?fields=` com sessions do Mercado Pago (H3).
5. Cancelamento pelo Admin de um pedido com Payment capturado.

## Critério de decisão

H1 a H3 confirmadas → a investigação é concluída e o baseline 2.21.2 passa a valer como evidência. Qualquer divergência → registro aqui e decisão antes de alterar código.

## Validação em runtime (sandbox, 2026-10-01)

### Método

- Backend `medusa develop` (Medusa CLI e Medusa 2.21.2, `bdefe51` + só documentação no working tree), iniciado do zero às 12:59Z, com um `--require` externo no scratchpad (via `NODE_OPTIONS`, conferido em `/proc/<pid>/environ` no processo da porta 9000) que registra método, caminho e status de cada `fetch` para `api.mercadopago.com`, sem headers, corpo nem query. Nenhum código da aplicação foi alterado.
- Checkout pela Store API com as mesmas chamadas e o mesmo payload do storefront, como na [INV-006](INV-006-payment-collection-rollback.md#método-1) e na [INV-009](INV-009-card-ambiguous-order-reconciliation.md#método-1): cart (R$ 110, BRL), endereço, frete, collection, session `pp_mercadopago`, `POST /store/mercadopago/payment-sessions/:id`. Cartão Visa de teste oficial do MLB tokenizado em `POST /v1/card_tokens` com a public key, como o Brick. Desvio registrado: a skill `integration-testing` pede navegador; aqui o objeto é o core, não a UI.
- Webhooks **reais** do Mercado Pago, entregues pelo túnel ngrok que já estava em execução antes desta validação (processo iniciado às 11:41Z), apontando para `localhost:9000`; o host não é registrado. A entrega foi comprovada pelo log do backend.
- Cancelamento pela rota real `POST /admin/orders/:id/cancel`, com uma secret API key temporária criada por `createApiKeysWorkflow` e revogada no fim (`apk_01M3VRZW5TRZZ2VGTBKNBXZBRA`; o token não foi registrado).
- Validação só por leitura: banco em transação `READ ONLY`, `GET /v1/orders/{id}` e log do backend.

### Resultados

| # | Cenário | Resultado | Evidência |
|---|---|---|---|
| 1 | Boot do backend | **PASS** | `Server is ready on port: 9000` em ~7 s; módulos carregados de `@medusajs/*@2.21.2`; lint 0 erros; único aviso: `Local Event Bus installed` (esperado em desenvolvimento); sem aviso do loader das chaves do `card_token`; `GET /health` → `OK`; nenhuma linha de erro no log da sessão inteira |
| 2 | Checkout com cartão | **PASS** | pedido **#145** (`order_01M3VRTRCANN5AR5JWFFXQGR0J`); 1 `POST /v1/orders` → 201 (`ORDTST01M3VRTZP9CDD6V96RXQAR35TJ`, `processed/accredited`, `credit_card`); session `authorized`; 1 Payment com `captured_at`, 1 Capture; collection `completed` (110/110); tentativa `mpca_01M3VRTQPYAW26QB0H2PZ4NDSN` `resolved`, ciphertext anulado, token destruído; nenhum `card_token` em `payment_session.data` nem em `payment.data`; Store API `payment_status: captured`. O webhook real `order.processed` do cart já concluído respondeu 200 sem criar nada |
| 3 | Pix pago pelo webhook, sem Place order | **PASS** | billing `APRO`; prepare 13:01:10Z (`POST /v1/orders` 201, `ORDTST01M3VRW1672DFF13NRGTDGWH4X`); 2 notificações reais → 200; o provider releu a Order (`GET` às 13:01:19.671Z) e o cart foi concluído às 13:01:20Z, pedido **#146** (`order_01M3VRW71D9B19AF8X3DARG3B1`), sem `POST /store/carts/:id/complete`; session `authorized` (13:01:19.685Z); 1 Payment com `captured_at` (13:01:19.788Z), 1 Capture; collection `completed` (110/110); Order MP `processed/accredited`; execução `complete-cart` `done`. É o ramo de auto-captura do `processPaymentWorkflow` (`SUCCESSFUL` sem Payment), que mudou no 2.21.2 |
| 4 | Store API com a política de campos permitidos | **PASS** | cart aberto com Pix pendente (session com `payer`, QR, ticket e idempotency keys no banco): `GET /store/carts/:id` padrão, `*payment_collection.payment_sessions`, `payment_collection.payment_sessions.data` sem `provider_id`, `+payment_collection.payment_sessions.data` e `payment_collection.payment_sessions.*` → 200 e só `data: { payment_method_id }`. Pedido #145 (`payment.data` com 21 chaves no banco, 10 `mercadopago_*`): padrão, `*payment_collections.payment_sessions` e `*payment_collections.payments` → só `{ payment_method_id }`. Nenhuma chave sensível em nenhuma resposta |
| 5 | Cancelamento pelo Admin | **PASS** | sem credencial → 401 nos dois. **#147** (Pix pendente, `OTHE`; concluído por Place order com a session `pending_authorization`, sem Payment): 200; `GET` + 1 `POST /v1/orders/{id}/cancel` → 200 às 13:03:31.672Z, antes do `canceled_at` do pedido (13:03:32.513Z); pedido, collection e session `canceled`; Order MP `canceled/canceled`. **#145** (cartão capturado): 200; 1 `POST /v1/orders/{id}/refund` → 201, nenhuma chamada do caminho Pix; 1 Refund de R$ 110; collection `canceled` com `refunded_amount` 110; Order MP `refunded/refunded`; Store API `payment_status: refunded` |

Contagem final [banco 2026-10-01]: 1 pedido por cart; #145: 1 Payment, 1 Capture, 1 Refund; #146: 1 Payment, 1 Capture; #147: nenhum Payment. Chamadas ao Mercado Pago no backend: 14, todas listadas acima ou leituras (`GET`) do provider; nenhuma duplicada.

### Observações (diferenças de 2.20.1 e dados novos)

- **Campos fora da lista permitida são descartados em silêncio** pela Store API (`AllowedFieldFilter` em `@medusajs/framework` `http/utils/get-query-config.js`), com HTTP 200: `customer.password_hash`, `sales_channel.*`, `payment_collection.payments.data` e `payment_collection.payment_sessions.raw_amount` no cart, e `payment_collections.payments.data`/`payment_collections.payment_sessions.data` sem a relação no pedido, voltaram sem esses campos. No 2.20.1, os pedidos de `.data` sem `provider_id` chegavam à redação do projeto ([ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md)); agora o core os remove antes. Sem vazamento nos dois casos; a redação continua necessária para as relações permitidas.
- **`capture.created_by`** ficou `null` nas duas capturas automáticas (#145, #146): o core passa `captured_by` indefinido nesse caminho. Nenhum código do projeto lê o campo.
- **Webhooks de reembolso e de cancelamento entregues:** depois do reembolso do #145 e do cancelamento do Pix do #147, chegaram notificações reais das Orders, respondidas com 200, sem Payment, Capture, Refund ou pedido novos.

### Limites

- Não revalidado no 2.21.2: cenários ambíguos e de prazo da tentativa de cartão (INV-009, ADR-016), reembolso parcial, capability de pagamento (ADR-007) além da emissão do header, cenário B do Pix, compensação com falha do `cancelOrderWorkflow` (INV-006; código do core idêntico), `createPaymentSessionsWorkflow` (INV-007) e `GET /store/orders/:id` (INV-002).
- Cartão de crédito apenas; débito continua não validável no sandbox ([INV-001](INV-001-debit-card-sent-as-credit-card.md)).

## Resultado

**Concluída** em 2026-10-01. A análise de código e a regressão mínima em runtime confirmam H1 a H3: o upgrade para o 2.21.2 não mudou o comportamento do fluxo de pagamento nos caminhos testados. Os caminhos listados em [Limites](#limites) continuam com evidência só do 2.20.1. Sem mudança de código.
