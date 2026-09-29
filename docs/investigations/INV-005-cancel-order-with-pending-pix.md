# INV-005: cancelar um pedido Medusa com o Pix ainda pendente

> Status: concluída · Aberta em: 2026-09-29 · Concluída em: 2026-09-29 · Commit: `0821822` (E2E com a correção ainda fora de commit; correção publicada em `12c5ff6` [commit `12c5ff6`]) · Decisão: [ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md)

Marcadores de origem: [../README.md](../README.md#convenções). **[MCP 2026-09-29]** indica documentação oficial ou dados do MCP do Mercado Pago (conta/aplicação de teste) consultados nessa data. **[core 2.20.1]** indica código do Medusa 2.20.1 instalado em `node_modules`. **[sandbox 2026-09-29]** indica resultado observado na Orders API sandbox nesta investigação.

## Achado

A revisão do ciclo de vida do Pix (Fase 1, 2026-09-29) indicou, só pela leitura do código, que cancelar um pedido Medusa criado com o Pix pendente (cenário A) não chama o provider, e a cobrança Mercado Pago continuaria pagável.

## Código [core 2.20.1]

`POST /admin/orders/:id/cancel` executa só `cancelOrderWorkflow({ order_id, canceled_by })`. O workflow:

1. valida o pedido (`cancelValidateOrder`): não cancelado, não `completed`, fulfillments cancelados;
2. lê `payment_collections.payments` com `captures` e `refunds`;
3. em paralelo: `refundCapturedPaymentsWorkflow` (Payments capturados), `deleteReservationsByLineItemsStep`, `cancelPaymentStep({ paymentIds })` só para **Payments** sem Capture, e o evento `order.canceled`;
4. `createOrderRefundCreditLinesWorkflow` com o valor reembolsado agora;
5. `updatePaymentCollectionStep` → collection `canceled`;
6. `cancelOrdersStep`;
7. hook `orderCanceled` (ponto de extensão nativo do workflow).

- O provider só é alcançado por `cancelPaymentStep` → `PaymentModuleService.cancelPayment(paymentId)` → provider `cancelPayment`. Payment Sessions não são lidas nem alteradas.
- No cenário A o Pix está `pending_authorization`: não existe Payment, então a lista de `cancelPaymentStep` é vazia e nenhum método do provider é chamado. Erros de `cancelPayment` são só registrados em log, sem falhar o cancelamento.
- `maybeUpdatePaymentCollection_` recalcula o status da collection a partir de sessions e captures; um pagamento posterior sobrescreveria `canceled`.

## Provider

`cancelPayment` (`service.ts`): exige `mercadopago_order_id` em `payment.data`, chama `POST /v1/orders/{id}/cancel` com `getIdempotencyKey(data, context)` (que prefere `mercadopago_idempotency_key` da session ao `context.idempotency_key`), não confere o status antes e devolve `mercadopago_order_status`/`_detail` da resposta. Não trata `processed`, `canceled` ou Order inexistente: o erro da API propaga (e o core só o registra em log). Não é chamado no cenário A.

O cancelamento de Pix pendente existente no projeto é outro caminho: `invalidatePixOrder`, usado em `updatePayment` (troca de método) e `deletePayment` (session removida), que cancela só `pending`/`processing` e recusa Pix pago (invariantes 7 e 8).

## Contrato do Mercado Pago [MCP 2026-09-29]

- Checkout API Orders (`payment-management/refunds-cancellations`): cancelamento só com `status` `action_required`; depois do vencimento sem pagamento, o cancelamento é automático e o status final é `canceled` ou `expired`. `integration-model`: "Cancelar order … já existente, mas que ainda não foi processada".
- Página do Pix: pode ser cancelado "desde que esteja pendente ou em processamento. Ou seja, com `status=action_required`"; o Mercado Pago recomenda cancelar pagamentos não realizados dentro do vencimento.
- Erros (`payment-management/integration-errors`): `409 cannot_cancel_order`, `409 order_already_canceled`.
- A documentação de QR (outro produto na mesma Orders API) diz que Orders só podem ser canceladas com `status: created`; resposta do cancelamento: Order `canceled/canceled`, transação `canceled/canceled_by_api`. Para o Pix online, vale `action_required`.
- Eventos do tópico Order para pagamentos online: não encontrados pelo MCP; `order.canceled` foi observado neste projeto (#86, 2026-09-27) depois de um cancelamento via API.

## E2E da reprodução (sandbox, 2026-09-29)

### Método

- Backend local (`medusa develop`), sem túnel: webhooks não entregues.
- Checkout pela Store API, como o storefront: cart, endereço de cobrança **não** `APRO` (o sandbox não aprova), frete, payment collection, session `pp_mercadopago`, `POST /store/mercadopago/payment-sessions/:id` (Pix), prepare (`.../pix`), `POST /store/carts/:id/complete`.
- Cancelamento com `cancelOrderWorkflow` via `medusa exec` (o que a rota do Admin executa, sem a camada HTTP/autenticação), com o `fetch` do processo registrado para capturar qualquer chamada ao Mercado Pago.
- Leituras: `GET /v1/orders/{id}`, consultas read-only ao banco, `GET /store/mercadopago/payment-access/pix` com a capability emitida no prepare, MCP `notifications_history`.

### Identificadores

Pedido Medusa #93 `order_01M3Q4RJ2TYY65FKGCBD2CAEBB` · cart `cart_01M3Q4R84ZZ358RBCX4A22ED0C` · collection `pay_col_01M3Q4REMVG0HJ75M584XK37HT` · session `payses_01M3Q4RF03WQN91VYYXNGD2SHK` · Order MP `ORDTST01M3Q4RP89B568SXDH5CK1318T` · R$ 110,00.

### Resultados

| Etapa | Resultado |
|---|---|
| Prepare (17:52:49Z) | DTO `pending`, QR e ticket; deadline local 18:52:49Z (`PT1H`); capability emitida (até 19:07:49Z) |
| Place order (17:52:52Z) | pedido #93 `pending`; cart concluído; session `pending_authorization`; collection `awaiting`; 0 Payments [banco 2026-09-29] |
| Order MP antes | `action_required/waiting_transfer`; transação `action_required/waiting_transfer` [sandbox 2026-09-29] |
| Confirmação antes (capability) | 200, `pending`, janela aberta, QR e ticket |
| `cancelOrderWorkflow` (17:53:43–44Z) | concluído sem erro; **nenhuma chamada de rede** ao Mercado Pago |
| Medusa depois | pedido `canceled` (`canceled_at` 17:53:44Z); collection `canceled`; session **`pending_authorization`**, ainda com `mercadopago_order_id`; 0 Payments; credit line de valor 0 (versão 2); nenhuma OrderTransaction [banco 2026-09-29] |
| Order MP depois (17:53:45Z) | **`action_required/waiting_transfer`**, inalterada (`last_updated_date` 17:52:57Z) [sandbox 2026-09-29] |
| Confirmação depois (capability, 17:53:46Z) | **200, `pending`, janela aberta, QR e ticket**, `order_id` = pedido cancelado; a capability não foi revogada |
| Notificações [MCP 2026-09-29] | 1 notificação `order` para essa Order, às 17:52 (criação), respondida 404 (host de túnel sem backend). Nenhuma no cancelamento Medusa. O MCP não mostra o `action` |
| Duplicação | geração Pix 0 (uma Order MP), 1 session, 1 pedido para o cart, nenhum Payment criado pelo cancelamento |

### Pagamento depois do cancelamento

**Não reproduzível no sandbox.** Um Pix sem o nome `APRO` não é pago pelo sandbox ([testing.md](../mercadopago/testing.md#pix-no-sandbox)); com `APRO`, é aprovado em segundos, antes de qualquer cancelamento. Nenhum pagamento foi forçado.

Caminho pelo código [não validado], se a Order MP fosse paga depois do cancelamento Medusa:

1. webhook `order.processed` → a rota resolve a session pela Order exata (não filtra status da session, da collection nem do pedido) → evento;
2. `getWebhookActionAndData` → `captured` → `processPaymentWorkflow`, ramo de autocaptura (sem Payment para a session);
3. `authorizePaymentSession` (não confere collection nem pedido) → provider `authorizePayment` → `reauthorizePixOrder` → `captured` → session `authorized`, Payment criado e capturado, Capture;
4. `maybeUpdatePaymentCollection_` → collection `completed`, sobrescrevendo `canceled`;
5. `capturePaymentWorkflow` → OrderTransaction `capture` no pedido **cancelado**; como o pedido já existe, `completeCartAfterPaymentStep` não roda.

Resultado esperado: pedido cancelado com pagamento capturado (dinheiro recebido sem pedido ativo), sem aviso a ninguém; exigiria reembolso manual.

### Expiração da cobrança

Registro, sem mudança: a Order MP foi criada com `expiration_time: "PT1H"`; deadline local `mercadopago_pix_expires_at` 18:52:49Z; capability válida até 19:07:49Z. Até a deadline, o pedido cancelado continua com um Pix pagável. Observado com `GET /v1/orders/{id}` a cada 60 s [sandbox 2026-09-29]: a Order continuou `action_required/waiting_transfer` até 18:54:54Z e às 18:55:55Z estava **`canceled/expired`**, com a transação `expired/expired` (`last_updated_date` 18:55:45Z, ~3 min depois do prazo). Antes, em 2026-09-27, um Pix vencido passou a `canceled` 2–7 min depois do prazo ([testing.md](../mercadopago/testing.md#pix-no-sandbox)); o `status_detail` não foi registrado naquela vez.
- Notificação [MCP 2026-09-29]: uma notificação `order` para `ORDTST01M3Q4…` às 18:55, respondida 502 (túnel desligado). O MCP mostra o ID truncado e não mostra o `action`; pelo prefixo e pelo horário, é a expiração desta Order. Pelo código, a rota leria `canceled/expired` → `getStatusFromGateway` → `canceled` → `not_supported`, sem efeito no Medusa.

## Conclusão (reprodução, pedido #93)

⚠ **Inconsistência confirmada** entre Medusa e Mercado Pago antes da correção: o pedido Medusa foi cancelado, e a cobrança Pix continuou `action_required/waiting_transfer`, pagável, e exibida com QR na confirmação até o fim da janela. Não é defeito do core (o `cancelOrderWorkflow` só trata Payments por projeto); era uma lacuna da integração no cenário A.

## Correção (sobre `0821822`, publicada em `12c5ff6`)

> Atualização 2026-09-29: o hook abaixo continua existindo, mas `POST /admin/orders/:id/cancel` passou a cancelar o Pix **antes** do `cancelOrderWorkflow` (workflow `cancel-order-with-pending-pix`, [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)), porque uma recusa do hook deixava a collection `canceled` ([INV-006](INV-006-payment-collection-rollback.md)). A lógica descrita aqui foi movida para `src/workflows/steps/cancel-pending-pix-charge.ts`, sem mudança de comportamento.

Mecanismo escolhido: hook `cancelOrderWorkflow.hooks.orderCanceled` [decisão humana 2026-09-29]; detalhes e alternativas no [ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md).

- `src/workflows/hooks/order-canceled.ts` (`cancelPendingPixCharge`, `selectPendingPixSessions`): lê as sessions do pedido; só age sobre `pp_mercadopago` + Pix + `pending_authorization` + `mercadopago_order_id`; mais de uma → erro; uma → `paymentModule.updatePaymentSession` com `mercadopago_pix_action: "cancel"`; qualquer erro é relançado com o motivo, e o workflow é revertido.
- `service.ts`: `updatePayment` aceita a ação `cancel` → `cancelPixOrderForOrderCancellation`: `GET /v1/orders/{id}`, status desconhecido → `UNEXPECTED_STATE`, depois `invalidatePixOrder` (pago → `NOT_ALLOWED`; não pagável → nada; pendente → `POST /cancel` com `sha256(<pix key>:cancel)`); devolve session `canceled` com o status real da Order. `invalidatePixOrder` passou a devolver a resposta do cancelamento (antes `void`); os outros chamadores a ignoram.

Testes: `modules/mercadopago/__tests__/pix-cancel.unit.spec.ts` (12: pendente cancelado com a key esperada, key estável e distinta das outras, pago recusado sem cancelar, `expired`/`canceled`/`failed`/`refunded` sem cancelar, status desconhecido recusado, recusa 409 propagada, falha na leitura sem cancelar, Pix sem Order, cartão recusado) e `workflows/hooks/__tests__/order-canceled.unit.spec.ts` (13: registro no hook, cancelamento via payment module, nenhuma ação para sem session, cartão, Pix autorizado, Pix cancelado, sem Order MP, outro provider, sessão pendente não Pix; ambiguidade recusada; Pix pago e erro 409 relançados). Backend: 15 suítes, 310 testes.

## E2E da correção (sandbox, 2026-09-29)

Mesmo método da reprodução (Store API com backend local, `cancelOrderWorkflow` via `medusa exec` com o `fetch` registrado), com a correção carregada (o `WorkflowLoader` carrega `src/workflows`, inclusive `hooks/`, também no `medusa exec`). A regra de status desconhecido foi acrescentada depois destes E2E e não é percorrida por eles.

| Caso | Pedido / Order MP | Chamadas ao Mercado Pago no cancelamento | Resultado |
|---|---|---|---|
| E2E-1 Pix pendente (nome não `APRO`) | #94 / `ORDTST01M3Q5MJ9AGM1V9C2AAFQ963PN` | `GET /v1/orders/{id}` 200 → `POST .../cancel` 200 (com key) | ✅ Order MP `canceled/canceled` (transação `canceled/canceled_transaction`); pedido `canceled`; session `canceled` com o status real; collection `canceled`; confirmação (capability): `status: canceled`, sem QR nem ticket |
| E2E-2 corrida: Pix pago (`APRO`) antes do webhook | #95 / `ORDTST01M3Q5P2NB4NM66Q3859E7D7J1` | `GET` 200; nenhum cancel | ✅ hook recusou (`NOT_ALLOWED`: "already been paid"); workflow revertido: pedido `pending`, `canceled_at` nulo, credit line de 0 compensada; Order MP continua `processed/accredited`. ⚠ collection ficou `canceled` (ver abaixo) |
| E2E-3 Pix pago com Payment capturado | #96 / `ORDTST01M3Q5RRXR7FSQJ8VN8VS9DP6G` | só `POST .../refund` 201 (fluxo do core) | ✅ hook não agiu (session `authorized`); 1 Refund de R$ 110; Order MP `refunded/refunded`; pedido `canceled` |

- Em nenhum caso houve `POST /v1/orders` novo, segundo Payment ou segundo pedido para o mesmo cart.
- No E2E-2 o Pix foi criado em `processing/in_process` (prepare sem QR) e aprovado ~30 s depois; o Place order ocorreu antes da aprovação.

### Compensação da payment collection (Medusa 2.20.1)

- A compensation de `updatePaymentCollectionStep` **falha**: o snapshot dos dados anteriores guarda só os campos do `update` (`{ id, status }`), e a compensação reenvia `amount`, `currency_code` e `metadata` (sem `status`) a partir dele. `amount` e `currency_code` chegam `undefined`, e o MikroORM recusa: `You must pass a non-undefined value to the property amount of entity PaymentCollection`. O orquestrador segue compensando os steps anteriores, e o workflow termina **`FAILED`** (não `REVERTED`): a Order é revertida, mas a Payment Collection permanece `canceled`. O erro da compensation não chega ao chamador (só erros de `invoke` são lançados). Análise e reprodução em [INV-006](INV-006-payment-collection-rollback.md).
- Observado no E2E-2: depois do rollback, pedido `pending` e collection `canceled`.
- Recuperação: rodando `processPaymentWorkflow` (`captured`) para a session, como faz o subscriber do core depois da correlação do webhook, a collection foi recalculada por `maybeUpdatePaymentCollection_` para `completed`, com 1 Payment capturado; o pedido segue `pending` (pago). Ou seja, o estado se corrige no primeiro evento de pagamento.
- Afeta qualquer rollback do `cancelOrderWorkflow`, não só este hook. Sem correção nesta etapa.

## Perguntas em aberto [não validado]

- Pagamento de Pix depois de um cancelamento que **não** passou pelo hook (pedidos cancelados antes da correção, como o #93): o caminho pelo código continua o descrito acima; sem reprodução no sandbox.
- Cancelamento com a Order MP em `created`/`processing`: o hook tenta cancelar, e o comportamento real do Mercado Pago nesses estados não foi observado (a documentação online só cita `action_required`).
- Qual `action` o Mercado Pago usa na notificação de vencimento (`order.canceled` ou `order.expired`): houve notificação (#93, 18:55), mas o MCP não mostra o `action`, e o túnel estava desligado.
- Com a duração futura de 24 h (investigação separada), a janela de corrida pagamento × cancelamento aumenta.
