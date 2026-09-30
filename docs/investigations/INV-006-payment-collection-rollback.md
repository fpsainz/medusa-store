# INV-006: Payment Collection `canceled` depois de um `cancelOrderWorkflow` revertido

> Status: concluída · Aberta em: 2026-09-29 · Concluída em: 2026-09-29 · Commit: `12c5ff6` (correção da INV-005/ADR-012 e do ADR-013; o E2E da correção rodou com o mesmo código, antes do commit) · Decisão: [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)

Marcadores de origem: [../README.md](../README.md#convenções). **[core 2.20.1]** indica código do Medusa 2.20.1 instalado em `node_modules` (`@medusajs/core-flows`, `@medusajs/payment`, `@medusajs/orchestration`, `@medusajs/workflows-sdk`, `@medusajs/framework`, `@medusajs/utils`, `@mikro-orm/core` 6.6.14). **[sandbox 2026-09-29]** indica leitura da Orders API sandbox. **[MCP 2026-09-29]** indica dados ou documentação do MCP do Mercado Pago (conta de teste).

## Achado

No E2E-2 da [INV-005](INV-005-cancel-order-with-pending-pix.md#e2e-da-correção-sandbox-2026-09-29) (#95, Pix pago antes do webhook), o hook `orderCanceled` recusou o cancelamento, e o pedido voltou a `pending`, mas a payment collection ficou `canceled`. A primeira explicação ("a compensação não restaura `status`") estava incompleta.

## Fatos

### Mecanismo [core 2.20.1]

Ordem do `cancelOrderWorkflow` (`core-flows/dist/order/workflows/cancel-order.js`): `get-order` → `cancel-validate-order` → em paralelo `refund-captured-payments-workflow-as-step`, `delete-reservations-by-line-items`, `cancel-payment-step`, `emit-event-step` (`order.canceled`) → `emit-reservation-item-deleted` → `get-refunded-payment-refunds` → `create-order-refund-credit-lines-as-step` → **`update-payment-collection`** (`status: canceled`) → `cancel-orders` → hook **`orderCanceled`** (único hook do workflow, o último step).

`updatePaymentCollectionStep` (`core-flows/dist/payment-collection/steps/update-payment-collection.js`):

- **Invoke:** o snapshot é `listPaymentCollections(selector, { select })`, com `select` derivado só das chaves do `update` (`getSelectsAndRelationsFromObjectArray([{ status }])` → `["status"]`). Lido na collection do #95 por `medusa exec`: `[{ id, status }]`.
- **Compensation:** `upsertPaymentCollections(prev.map(pc => ({ id, amount: pc.amount, currency_code: pc.currency_code, metadata: pc.metadata })))`. Ela não reenvia `status`, e os outros três campos vêm `undefined` do snapshot.
- O `upsert` vira `update` → `MedusaInternalService.update` carrega a entidade inteira e faz `manager.assign(entity, update, { mergeObjectProperties: true })`, sem `ignoreUndefined`.
- `EntityAssigner.assignProperty` do MikroORM lança erro quando a propriedade existe, não é anulável e o valor é `null`/`undefined`. No modelo `PaymentCollection`, `amount` (bigNumber) e `currency_code` (text) não são anuláveis.
- Resultado: **a compensation lança** `You must pass a non-undefined value to the property amount of entity PaymentCollection.` antes de qualquer escrita. Reproduzido offline com o modelo real (`toMikroORMEntity` + `MikroORM.init({ connect: false })`), sem banco. Mesmo que não lançasse, `status` não seria restaurado.

Orquestrador (`orchestration/dist/transaction/transaction-orchestrator.js`):

- `DEFAULT_RETRIES = 0`: a compensation que falha vira `failed/permanent_failure` na hora.
- `FAILED` está em `canMoveBackwardStates`: os steps anteriores continuam sendo compensados.
- Com um step em falha, o estado final é **`FAILED`**, não `REVERTED`.
- O step que falhou no invoke (o hook) também é marcado para compensação (`PERMANENT_FAILURE`), com entrada `undefined`, a menos que falhe por `StepResponse.permanentFailure(message, compensateInput)`.

Chamador (`workflows-sdk/dist/helper/workflow-export.js`):

- `run()` lança só `errors[0]` de `getErrors(INVOKE)`. **O erro da compensation não chega ao chamador.**
- Só é registrado em log com `logOnError`, que a rota do Admin não passa.

### Origem e estados da collection [core 2.20.1]

- Criada no checkout (`POST /store/payment-collections`, `createPaymentCollectionForCartWorkflow`) com `amount`, `currency_code` e `status` padrão `not_paid`.
- Campos persistidos: `id`, `currency_code`, `amount`/`raw_amount`, `authorized_amount`, `captured_amount`, `refunded_amount` (e `raw_*`), `completed_at`, `status`, `metadata`.
- O status é recalculado só por `maybeUpdatePaymentCollection_` (privado), chamado em `authorizePaymentSession`, `capturePayment` e `refundPayment`. `createPaymentSession`, `updatePaymentSession` e `deletePaymentSession` não recalculam.
- Com Pix pendente, o `completeCart` passa por `authorizePaymentSession` → `pending_authorization` → recálculo → `awaiting` (sessions > 0, nada autorizado ou capturado).
- `cancelOrderWorkflow` → `canceled`. A compensation não restaura (acima).
- Não existe step nativo que restaure `status`, e nenhum helper público recalcula a collection. `updatePaymentCollections` aceita `status`, mas exige saber o valor anterior.

### `payment_status` do pedido [core 2.20.1]

`getLastPaymentStatus` (`core-flows/dist/order/utils/aggregate-status.js`) devolve `canceled` quando todas as collections do pedido estão `canceled` e nada foi capturado. Admin e storefront (`order-details`) mostram esse valor.

## E2E da reprodução: Pix não pago (sandbox, 2026-09-29)

### Método

- Backend local (`medusa develop`), túnel sem backend (webhooks não entregues).
- Checkout pela Store API com as mesmas chamadas do storefront, como na INV-005: cart, endereço de cobrança **não** `APRO`, frete, collection, session `pp_mercadopago`, `POST /store/mercadopago/payment-sessions/:id` (Pix), prepare (`.../pix`), `POST /store/carts/:id/complete`.
- Desvio registrado: o contrato da skill `integration-testing` pede navegador para validar checkout. Aqui o objeto é o `cancelOrderWorkflow`, e o checkout só prepara o estado.
- Cancelamento com o `cancelOrderWorkflow` real (o que a rota do Admin executa), via `medusa exec`, com `throwOnError: false` para ler a transação.
- **Condição de rollback:** `MERCADOPAGO_ACCESS_TOKEN` inválido **só no processo do `medusa exec`** (o `loadEnv` não sobrescreve variáveis já definidas; o script conferiu o valor antes de rodar).
  - O `GET /v1/orders/{id}` do provider falha, e o hook relança o erro, caminho já tratado pelo código ("falha na leitura sem cancelar", invariante 45). Nenhum código foi alterado.
  - Como segurança, o `fetch` do processo bloquearia qualquer chamada não-GET ao Mercado Pago; nenhuma foi tentada.
- Observação de eventos: subscriber `order.canceled` e espiões de `emit`/`releaseGroupedEvents`/`clearGroupedEvents` registrados **só no processo do `medusa exec`** (`LocalEventBusService`). Nenhum logging foi adicionado à aplicação.

### Identificadores

Pedido Medusa #97 `order_01M3Q808SEB67KBM26EN8PA6VA` · cart `cart_01M3Q800Q10J77YRAYYP30FAEK` · collection `pay_col_01M3Q805NYX5RXXZ2XG1FQH7Q1` · session `payses_01M3Q805ZNPJXBR8Q925AB45QK` · Order MP `ORDTST01M3Q80D498XMHDRXXRB0KBS8Q` · R$ 110,00.

### Antes do cancelamento

| Entidade | Estado |
|---|---|
| Prepare (18:49:29Z) | DTO `pending`, QR e ticket; `expires_at` 19:49:27Z; capability emitida |
| Pedido #97 (18:49:31Z) | `pending`, `canceled_at` nulo, versão 1 [banco 2026-09-29] |
| Collection | **`awaiting`**, `amount` 110, `currency_code` `brl`, `metadata` nulo, authorized/captured/refunded 0 [banco 2026-09-29] |
| Session | `pending_authorization`, com `mercadopago_order_id` [banco 2026-09-29] |
| Payments / credit lines / transações | 0 / 0 / 0 [banco 2026-09-29] |
| Order MP | `action_required/waiting_transfer`, transação `action_required/waiting_transfer`, `pix`, `PT1H`, vence 19:49:34Z [sandbox 2026-09-29] |

### Transação do `cancelOrderWorkflow` (18:50:32–34Z)

Chamadas ao Mercado Pago: só `GET /v1/orders/{id}` → **403** (`At least one policy returned UNAUTHORIZED.`). Nenhum `POST`.

| Step | Invoke | Compensate |
|---|---|---|
| `get-order` | done | reverted (sem compensação) |
| `cancel-validate-order` | done | reverted (sem compensação) |
| `refund-captured-payments-workflow-as-step` | done | reverted |
| `delete-reservations-by-line-items` | done | reverted |
| `cancel-payment-step` | done (lista vazia) | reverted (sem compensação) |
| `emit-event-step` (`order.canceled`) | done | reverted |
| `emit-reservation-item-deleted` | done | reverted |
| `get-refunded-payment-refunds` | done | reverted (sem compensação) |
| `create-order-refund-credit-lines-as-step` | done | reverted |
| **`update-payment-collection`** | done | **failed / permanent_failure** |
| `cancel-orders` | done | reverted |
| **`orderCanceled`** (hook) | **failed / permanent_failure** | reverted (compensação vazia) |

- **Estado final: `failed`.**
- Erro de execução normal (`invoke`, o único devolvido por `run()`): `orderCanceled`: `Mercado Pago: order order_01M3Q808SEB67KBM26EN8PA6VA was not canceled because its pending Pix charge could not be canceled (At least one policy returned UNAUTHORIZED.).`
- Erro de compensation (`compensate`, só em `transaction.getErrors()`): `update-payment-collection`: `You must pass a non-undefined value to the property amount of entity PaymentCollection.`

### Depois do rollback

| Entidade | Antes | Depois |
|---|---|---|
| Pedido #97 | `pending`, versão 1 | **`pending`**, `canceled_at` nulo, versão 1 |
| Collection `status` | `awaiting` | **`canceled`** (`updated_at` 18:50:33.199Z, a escrita do invoke) |
| Collection `amount` / `currency_code` / `metadata` | 110 / `brl` / nulo | 110 / `brl` / nulo (inalterados) |
| Session | `pending_authorization` | `pending_authorization` (inalterada) |
| Credit line | nenhuma | 1, valor 0, **apagada** (soft delete, compensada) |
| `order_summary` versão 2 | — | apagada (compensada) |
| Reserva de estoque | ativa | ativa (recriada pela compensação) |
| Order MP | `action_required/waiting_transfer` | `action_required/waiting_transfer` (`last_updated_date` 18:49:35Z, inalterada) |
| `GET /store/orders/:id` | — | `status: pending`, **`payment_status: canceled`** |
| Confirmação (capability) | `pending`, QR e ticket | **`pending`, janela aberta, QR e ticket** para o #97 |

Todas as linhas acima vêm de [banco 2026-09-29], [sandbox 2026-09-29] e da Store API em execução.

**Conclusão da reprodução:** a inconsistência também ocorre com Pix não pago. Pedido ativo (`pending`) com collection `canceled` e `payment_status: canceled`, enquanto o Mercado Pago e a confirmação continuam oferecendo o Pix. Diferente do #95, aqui não há pagamento que dispare o recálculo.

### Evento `order.canceled`

- O `emit-event-step` emitiu `order.canceled` **com `eventGroupId`** (agrupado), como todos os eventos internos da execução (`payment.payment-collection.updated`, `order.order.updated` etc.).
- No fim, com o workflow `failed`, o `workflow-export` chamou **`clearGroupedEvents(eventGroupId)`** (três vezes, nenhuma `releaseGroupedEvents`). O subscriber de `order.canceled` **não recebeu nada** em 5 s de espera.
- Código [core 2.20.1]: `wrappedOnFinish` descarta o grupo se o estado é `FAILED` ou `REVERTED` e só o libera no sucesso.
- Conclusão: **o evento é descartado no rollback.** Nenhum subscriber (notificação ao cliente, por exemplo) vê um cancelamento que não aconteceu.

### Mercado Pago [MCP 2026-09-29]

- `notifications_history`: uma notificação `order` para `ORDTST01M3Q8…` às 18:49 (criação da Order do #97), 1 tentativa, 502 (túnel sem backend). O MCP trunca o ID; é a única Order com esse prefixo no período.
- Nenhuma notificação depois do cancelamento, coerente com a Order MP inalterada. O MCP não mostra o `action`.
- Documentação atual do Pix na Checkout API via Orders ("Cancelar pagamento"): "você pode cancelar um pagamento criado, desde que esteja pendente ou em processamento. Ou seja, com `status=action_required`". A referência "Cancelar order" diz: "cancelamento de uma order já existente, mas que ainda não foi processada". A regra de `status: created` citada na INV-005 é do produto QR e não se aplica aqui.

### Expiração

A Order MP venceu sem pagamento às 19:49:34Z e passou a `canceled/expired` às 19:52:04Z; o Medusa não mudou. Detalhes na seção [Expiração observada](#expiração-observada).

## Chamadores do `cancelOrderWorkflow` [core 2.20.1]

Busca por `cancelOrderWorkflow` em `@medusajs/*` (inclusive `.medusa/server` do plugin `@medusajs/draft-order`) e no projeto:

| Chamador | Tipo |
|---|---|
| `@medusajs/medusa` `api/admin/orders/[id]/cancel/route.js` (`POST /admin/orders/:id/cancel`) | **único chamador em execução**. Chama `cancelOrderWorkflow(req.scope).run({ input: { order_id, canceled_by } })` direto, sem `logOnError` |
| `@medusajs/test-utils` (cópia embutida da mesma rota) | só para testes |
| `core-flows` `cart/workflows/complete-cart.js` | só em comentário JSDoc (exemplo), não é chamada |
| Projeto | só o registro do hook (`src/workflows/hooks/order-canceled.ts`); nenhuma chamada |

O Admin dashboard chega ao workflow só por essa rota. Um plugin ou código futuro poderia chamá-lo direto; hoje nada chama.

## Mecanismos nativos de extensão [core 2.20.1]

| Mecanismo | Existe? | Observação |
|---|---|---|
| Hook de validação antes de `update-payment-collection` no `cancelOrderWorkflow` | **não** | O workflow só expõe `orderCanceled`, depois de `update-payment-collection` e `cancel-orders` |
| `cancelValidateOrder` | sim, exportado | Step reutilizável: não cancelado, não `completed`, fulfillments cancelados |
| Compensação no hook (`hooks.orderCanceled(invoke, compensate)`) | sim | Roda antes da compensation de `update-payment-collection`, mas só tem entrada se o hook falhar com `StepResponse.permanentFailure(msg, compensateInput)`. No momento do hook a collection já está `canceled`, e o `order` do hook não traz o status anterior |
| Restaurar/recalcular status da collection | **não** | `maybeUpdatePaymentCollection_` é privado; `updatePaymentCollections(id, { status })` exige conhecer o valor anterior |
| Middleware de rota (`defineMiddlewares`, `src/api/middlewares.ts`) | sim | Roda depois da autenticação do `/admin` (o `ApiLoader` aplica o auth de `/admin` antes de registrar middlewares e rotas do projeto) e antes do handler do core. Ordem lida no código; **[não validado]** em requisição real |
| Sobrescrever a rota (`src/api/admin/orders/[id]/cancel/route.ts`) | sim | "the route registered afterwards will override the one registered first" (`routes-loader.js`). Precedente no projeto: o webhook (`api/hooks/payment/[provider]/route.ts`) |
| Workflow wrapper com `cancelOrderWorkflow.runAsStep` | sim | Padrão nativo de composição; o hook `orderCanceled` continua registrado dentro dele |

## Comparação das opções

Premissas comuns:

- O cancelamento da Order MP continua em `updatePaymentSession` com a ação `cancel` → provider (`cancelPixOrderForOrderCancellation` → `invalidatePixOrder`), sem outro `POST /v1/orders/{id}/cancel`.
- O cancelamento no Mercado Pago é irreversível; nenhuma opção é atômica com o Medusa.

- **A — pré-validação (só leitura):** middleware no `POST /admin/orders/:id/cancel` lê a Order MP e recusa se estiver paga ou ilegível. O hook atual continua cancelando.
- **B — hook atual:** como está (ADR-012).
- **C — wrapper:** workflow novo `cancelOrderWithPendingPixWorkflow`, com `get-order` → `cancelValidateOrder` → step "cancelar Pix pendente" (a mesma função do hook) → `cancelOrderWorkflow.runAsStep`. Admin coberto por sobrescrita da rota, ou por um middleware que rode só as três primeiras etapas antes do handler do core. O hook fica como rede de segurança: depois do step de Pix a session está `canceled`, e o hook não age.

| Opção | Atomicidade | Admin | Interno | Cartão | Pix | Complexidade | Risco |
|---|---|---|---|---|---|---|---|
| A — pre-validation | Não resolve: corrida entre a leitura e o hook (pagamento nesse intervalo → hook falha → mesmo estado inconsistente). Falha de leitura no hook continua possível (caso #97) | sim (middleware) | não (chamador direto só tem o hook B) | não afetado (sem session Pix pendente) | reduz a janela, não elimina | baixa | médio: duplica a leitura do status fora do provider; regra de negócio em middleware |
| B — hook atual | Pix só cancelado no último step; se o cancelamento no MP funciona, nada depois falha. Mas **qualquer** recusa do hook (pago, 409, falha de leitura, ambiguidade) passa pela compensation quebrada do core → pedido `pending` + collection `canceled` (#95, #97) | sim | sim (qualquer chamador) | não afetado | cancela; recusa deixa inconsistência | já implementado | alto: estado inconsistente visível (`payment_status: canceled` com QR pagável) |
| C — wrapper | O Pix é cancelado **antes** de `update-payment-collection`: pago/409/falha de leitura/ambiguidade recusam sem tocar pedido nem collection. Resta: `cancelOrderWorkflow` falhar depois do Pix cancelado → Pix cancelado (irreversível) com pedido ativo; novo cancelamento conclui (hook não age) | sim (rota sobrescrita ou middleware) | não pelo wrapper; B continua como rede de segurança | não afetado (step só age sobre Pix pendente) | resolve os casos #95 e #97 | média: 1 workflow + 1 step (extraído do hook) + rota/middleware | médio: sobrescrever rota do core (acompanhar mudanças da rota em upgrades) ou middleware com ordem de auth a confirmar |

Restauração no próprio hook (caso 3 do plano) foi avaliada e **não é segura** com os mecanismos nativos:

- o valor anterior do `status` não chega ao hook;
- recalcular exigiria copiar a regra privada `maybeUpdatePaymentCollection_`;
- a escrita seria outra operação do módulo, fora de qualquer transação com a compensation do core, que continuaria falhando (workflow `FAILED`).

## Solução adotada: opção C

Decisão: opção C [decisão humana 2026-09-29], registrada no [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md). A rota sobrescrita foi preferida ao middleware:

- o mecanismo de rota já tem precedente no projeto (webhook);
- a regra fica num workflow, como pedem as skills do projeto;
- a autenticação e as `policies` do core continuam valendo.

Arquivos:

- `src/workflows/steps/cancel-pending-pix-charge.ts`: step `cancel-pending-pix-charge` e `cancelPendingPixChargeForOrder`, com a lógica que estava no hook, sem mudança.
- `src/workflows/cancel-order-with-pending-pix.ts`: `get-order-to-cancel` → `cancelValidateOrder` → `cancel-pending-pix-charge` → `cancelOrderWorkflow.runAsStep`.
- `src/api/admin/orders/[id]/cancel/route.ts`: sobrescreve a rota do core e executa o wrapper.
- `src/workflows/hooks/order-canceled.ts`: continua registrado e delega à mesma função do step, `cancelPendingPixChargeForOrder` (rede de segurança).
- `src/modules/mercadopago/service.ts`: só comentários (novo chamador da ação `cancel`).

Inspeção feita antes de implementar [core 2.20.1]:

- **`cancelValidateOrder`** (`createStep("cancel-validate-order", ({ order }) => …)`): recusa pedido `canceled` (`INVALID_DATA`), `completed` (`NOT_ALLOWED`) e fulfillment não cancelado. Lê só `status`, `fulfillments.canceled_at` e `id`.
- **`runAsStep`**: cria o step `cancel-order-as-step`, que roda o workflow aninhado (síncrono, `throwOnError` padrão, `preventReleaseEvents`: os eventos só saem se o pai terminar bem). O erro do core chega ao wrapper e ao `run()` da rota.
- **Precedência da rota**: `ApiLoader` recebe `[@medusajs/medusa/dist/api, …plugins]`, e `getResolvedPlugins` põe o `src/` do projeto por último. `RoutesLoader.registerRoute` indexa por `matcher` + método, então o último registro vence.
- **Autenticação e policies**: o auth de `/admin` (`bearer`, `session`, `api-key`) é aplicado antes de registrar middlewares e rotas. `validateAndTransformQuery` e `policies` do core são middlewares por caminho e seguem valendo.
- **Resposta do core**: `{ order }` com `req.queryConfig.fields`, status 200. Erros vêm do `throw` do `run()` pelo error handler.
- **`get-order` no wrapper**: necessário. O core só lê o pedido dentro do próprio workflow, e o wrapper precisa validar antes de cancelar o Pix.

## E2E da correção (sandbox, 2026-09-29)

### Método

- Backend local (`medusa develop`) com o código novo.
- Checkout pela Store API como na reprodução. Cartão tokenizado em `POST /v1/card_tokens` com a public key, como o Brick, usando o cartão oficial de teste MLB (Visa crédito, titular `APRO`).
- Cancelamento pela **rota real** `POST /admin/orders/:id/cancel`, autenticada com uma secret API key temporária criada por `createApiKeysWorkflow` e **revogada** no fim (`apk_01M3Q9AYTYE0DKGYF9WAJSWBEB`; o token não foi registrado).
- **Chamadas ao Mercado Pago**: contadas no processo real do backend por um `--require` externo (scratchpad, via `NODE_OPTIONS`) que registra método, caminho e status de cada `fetch` para `api.mercadopago.com`, sem headers nem corpo. Nenhum logging foi adicionado à aplicação.
- **Condição do cenário C**: backend reiniciado só para esse cancelamento com `MERCADOPAGO_ACCESS_TOKEN` inválido no ambiente do processo (conferido em `/proc/<pid>/environ`) e reiniciado depois com o token válido.
- Webhooks não entregues: o túnel não aponta para este backend.

### Resultados

| Caso | Pedido / Order MP | Chamadas ao Mercado Pago no cancelamento | Rota | Resultado |
|---|---|---|---|---|
| A: Pix pendente | #98 `order_01M3Q9F0KB6VJEXR9T1KNADWDE` / `ORDTST01M3Q9F4GPNBPC97H96RQ1VVK8` | `GET` 200 → `POST …/cancel` 200 (19:15:13.036Z, antes do `canceled_at` do pedido, 19:15:13.969Z) | 200 `{ order }` | ✅ Order MP `canceled/canceled` (transação `canceled/canceled_transaction`); session `canceled`; collection `canceled`; pedido `canceled`; `payment_status: canceled`; confirmação `canceled` sem QR nem ticket; 0 Payments; 1 pedido para o cart |
| B: Pix pago (`APRO`) antes do webhook | #99 `order_01M3Q9G38BA764P94QVR5KEH2Q` / `ORDTST01M3Q9G7JDFFJWK72D6PSWMK0X` | só `GET` 200; nenhum `POST` | 400 `not_allowed`: "…could not be canceled (Mercado Pago: this Pix charge has already been paid and cannot be discarded.)" | ✅ Order MP continua `processed/accredited`, 0 reembolsos; pedido `pending`, versão 1 (o core não rodou); collection **`awaiting`** (no #95 ficou `canceled`); session `pending_authorization`; nenhum Payment, Refund ou credit line |
| C: falha no `GET` (condição do #97) | #100 `order_01M3Q9H5KFRSS25828QZ2H19SR` / `ORDTST01M3Q9H9WR4Y60QXXVKK67DY2Z` | só `GET` **403**; nenhum `POST` | 500 `unexpected_state`: "…could not be canceled (At least one policy returned UNAUTHORIZED.)" | ✅ pedido `pending`, versão 1; collection **`awaiting`**, `payment_status: awaiting` (no #97: `canceled`); `updated_at` de pedido, collection e session iguais aos do checkout; nenhuma credit line criada; Order MP intacta |
| C: nova tentativa com o token válido | #100 | `GET` 200 → `POST …/cancel` 200 | 200 | ✅ tudo `canceled`, confirmação sem QR |
| D: cartão capturado | #101 `order_01M3Q9NWA671WJNF9TVRTMHT1M` / `ORDTST01M3Q9P3BYMGB6V8SH830XBCFN` | só `POST …/refund` 201 (reembolso do core pelo provider) | 200 | ✅ nenhuma chamada Pix; 1 Refund de R$ 110; Order MP `refunded/refunded`; collection `canceled` com `refunded_amount` 110; pedido `canceled`; `payment_status: refunded`; session do cartão inalterada (`authorized`) |

Todas as linhas acima vêm de [banco 2026-09-29], [sandbox 2026-09-29], da Store/Admin API em execução e do registro de chamadas do backend.

- **Duplicação:** no período inteiro, o backend fez 4 `POST /v1/orders` (1 por checkout), 2 `POST …/cancel` (A e a nova tentativa de C, em Orders diferentes) e 1 `POST …/refund` (D). Nenhuma segunda cobrança nem segundo cancelamento. No A, o hook não chamou o Mercado Pago depois do wrapper.
- **Autenticação:** a rota respondeu 401 `Unauthorized` sem credencial (antes e depois dos testes) e 404 `not_found` do core para pedido inexistente com credencial.
- **MCP:** `notifications_history` mostra quatro notificações `order` para `ORDTST01M3Q9…` entre 19:15 e 19:19 (404/502, túnel sem este backend) [MCP 2026-09-29]. O MCP trunca o ID e não mostra o `action`: não serve para casar cada notificação com uma Order.

### #97 explicado pela ordem das operações

- No #97, a leitura da Order MP (403) aconteceu no hook, depois de `update-payment-collection`. A recusa passou pela compensation quebrada do core, e a collection ficou `canceled`.
- No #100, com a mesma falha, a leitura acontece no step `cancel-pending-pix-charge`, antes do `cancelOrderWorkflow`. O core não roda, e nenhuma compensation do core é necessária.
- O mesmo vale para a corrida do #95, reproduzida no #99.

## Hipóteses [não validado]

- Uma falha de infraestrutura dentro do `cancelOrderWorkflow` depois do Pix cancelado deixa o pedido ativo sem cobrança pagável; um novo cancelamento conclui. Não reproduzido.
- Com Pix pendente e collection `canceled` (pedidos anteriores à correção, como o #97), um pagamento posterior recalcularia a collection para `completed` pelo webhook (caminho do #95, disparado à mão na INV-005, não por webhook real).

## Perguntas em aberto

- O #97 ficou `pending` com collection `canceled` (dados de teste, não alterados). O #99 ficou `pending` com o Pix pago e sem Payment no Medusa até um webhook ser processado; também não foi alterado.
- A compensation quebrada do core afeta qualquer falha depois de `update-payment-collection`, não só a do Pix. Fora do escopo desta integração.

## Resultado

- ✅ Reproduzido com Pix não pago (#97): workflow `failed`; erro de `invoke` no hook e de `compensate` em `update-payment-collection`; pedido `pending`; collection `awaiting` → `canceled`.
- ✅ `order.canceled` descartado no rollback (`clearGroupedEvents`).
- ✅ Não existe hook nativo antes de `update-payment-collection`; o único chamador em execução é a rota do Admin.
- ✅ Opção C implementada e validada (testes unitários e E2E A/B/C/D pela rota real), [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md).

## Expiração observada

Order MP do #97 (`ORDTST01M3Q80D498XMHDRXXRB0KBS8Q`), criada com `expiration_time: "PT1H"`, `date_of_expiration` 19:49:34.709Z. Leitura a cada 2 min de 18:51Z a 19:52Z (`GET /v1/orders/{id}` e consulta read-only), mais uma leitura final.

| Momento | Order MP | Medusa |
|---|---|---|
| 18:51Z → 19:49:57Z (30 leituras) | `action_required/waiting_transfer` | collection `canceled`, session `pending_authorization`, pedido `pending` |
| 19:51:58Z | **`canceled/expired`**, transação **`expired/expired`** | inalterado |
| 19:52:12Z (leitura final) | `canceled/expired`, `last_updated_date` 19:52:04.163Z (~2,5 min depois do prazo) | session `pending_authorization` (`updated_at` 18:49:30Z), collection `canceled`, pedido `pending`, `payment_status: canceled` |

Fontes: [sandbox 2026-09-29] [banco 2026-09-29].

- Confirmação (capability, 19:52:13Z): `status: canceled`, `payment_window_closed: true`, sem QR nem ticket.
- [MCP 2026-09-29] `notifications_history` registra uma notificação `order` para `ORDTST01M3Q8…` às 19:52 (1 tentativa, 404: túnel sem este backend). É a única Order com esse prefixo no período; o MCP trunca o ID e não mostra o `action`.
- Mesmo entregue, a notificação não mudaria o Medusa: `canceled`/`expired` vira `not_supported` em `getWebhookActionAndData` ([webhook.md](../mercadopago/webhook.md#processamento-no-provider)), e nada recalcula a collection. O #97 fica como exemplo permanente do estado inconsistente anterior à correção: pedido `pending` e collection `canceled`, agora sem cobrança pagável.
- Diferente do Pix vencido de 2026-09-27, cuja Order passou a `canceled`: aqui o `status_detail` da Order e o status da transação ficaram `expired`.

## Regressão depois de `6f5acdd` (sandbox, 2026-09-30)

Objetivo: confirmar o caso D (cartão capturado) com o código da reconciliação da tentativa de cartão (INV-009, `6f5acdd`). Nenhum código foi alterado.

**Método:** o mesmo da [seção acima](#método), com três diferenças:
- pedido **#124** (`order_01M3SEBGSDTWWVTJ3KYHS3JF97`), já existente, criado pelo caminho da tentativa: Order MP `ORDTST01M3SEBAYCCRSE785K9FA82RXS`, `processed/accredited`, R$ 510 capturados, sem reembolso;
- secret API key temporária `apk_01M3SF9WR6KGZN94MJD6C72E5S`, revogada no fim (token não registrado);
- túnel ativo: as notificações chegaram ao backend.

**Resultado: ✅ aprovado** [banco 2026-09-30] [sandbox 2026-09-30]:
- a rota respondeu 401 sem credencial; com a credencial, `POST /admin/orders/:id/cancel` → 200, pedido `canceled` (versão 2);
- chamadas do backend ao Mercado Pago durante a rota: **1** `POST /v1/orders/{id}/refund` sem body → 201 (reembolso total do core pelo provider). Não houve `POST …/cancel`, `POST /v1/orders` nem chamada do caminho Pix;
- houve também 1 `GET /v1/orders/{id}` 200 no mesmo intervalo. Ele vem da notificação real dessa Order (`POST /hooks/payment/mercadopago`, 200), que chegou ao backend enquanto a rota ainda respondia, depois do reembolso. O webhook sempre lê a Order por `GET`. A atribuição vem da ordem no log e da coincidência de horário; não há rastreio por requisição;
- Medusa:
  - 1 Refund de R$ 510 (`ref_01M3SF9XPD9B3ZR8E4FJ2Y0SJV`);
  - o Payment continua com 1 captura e sem `canceled_at`;
  - collection `canceled`, com `refunded_amount` 510;
  - session do cartão inalterada (`authorized`, mesmo `updated_at`).
- Mercado Pago: Order `refunded/refunded`, payment `refunded/refunded`, 1 reembolso `processed` de R$ 510. Nenhuma cobrança nova.

O resultado é igual ao do #101: o cartão capturado só é reembolsado pelo core, e o wrapper do ADR-013 não age sobre o cartão.
