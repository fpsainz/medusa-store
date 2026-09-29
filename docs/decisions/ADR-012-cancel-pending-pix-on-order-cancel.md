# ADR-012: Cancelar o Pix pendente no hook `orderCanceled` do `cancelOrderWorkflow`

> Status: substituído em parte pelo [ADR-013](ADR-013-cancel-order-wrapper-cancels-pix-first.md) (o Pix passa a ser cancelado antes do `cancelOrderWorkflow`; este hook continua como rede de segurança) · Data: 2026-09-29 · Commits: correção sobre `0821822`, ainda não commitada

Investigação e evidências: [INV-005](../investigations/INV-005-cancel-order-with-pending-pix.md). Regras: invariantes 8 e 45 em [../mercadopago/invariants.md](../mercadopago/invariants.md). Escolha do mecanismo [decisão humana 2026-09-29].

## Contexto

- No cenário A, o pedido Medusa nasce com o Pix pendente: session `pending_authorization`, Order Mercado Pago `action_required/waiting_transfer`, nenhum Payment.
- `cancelOrderWorkflow` (Medusa 2.20.1) só age sobre Payments: cancela os não capturados (`cancelPaymentStep` → provider `cancelPayment`) e reembolsa os capturados. Não lê nem altera Payment Sessions. Sem Payment, nenhum método do provider é chamado.
- Comprovado no sandbox (pedido #93, INV-005): pedido e collection `canceled`, Order MP intacta e pagável, confirmação ainda com QR. Um pagamento posterior capturaria dinheiro num pedido cancelado (pelo código).
- O Mercado Pago permite cancelar a Order Pix em `action_required` (`POST /v1/orders/{id}/cancel`, `X-Idempotency-Key`; `409 cannot_cancel_order`/`order_already_canceled`) e recomenda cancelar cobranças não pagas.
- O workflow expõe o hook `orderCanceled`, executado como step depois de `cancelOrdersStep`. Se o hook lança erro, a execução falha, os steps anteriores são compensados e os eventos agrupados (`order.canceled`) são descartados (`workflow-export`: `clearGroupedEvents`).

## Decisão

1. **Onde:** handler de `cancelOrderWorkflow.hooks.orderCanceled` em `src/workflows/hooks/order-canceled.ts` (`cancelPendingPixCharge`). Nenhum subscriber, nenhuma mudança no core.
2. **Qual session:** as do pedido (`order → payment_collections → payment_sessions`) com provider `pp_mercadopago`, `payment_method_id: "pix"`, status `pending_authorization` e `mercadopago_order_id`. Nenhuma → nada a fazer (cartão, sem pagamento, Pix pago ou já cancelado seguem só o core). Mais de uma → erro `NOT_ALLOWED`, sem escolher.
3. **Como:** `paymentModule.updatePaymentSession` com a ação transitória `mercadopago_pix_action: "cancel"`, que o provider trata em `updatePayment` → `cancelPixOrderForOrderCancellation` → `invalidatePixOrder` (a mesma regra da troca de método e da remoção de session). Sem outro `POST /cancel` no projeto. A ação só é definida no servidor; a rota do cliente a descarta pela allowlist.
4. **Estado lido antes de agir:** `GET /v1/orders/{id}` imediatamente antes. Pago (`processed`/`approved`/`accredited`) → `NOT_ALLOWED`, sem cancelar; já não pagável (`expired`, `canceled`, `failed`, `rejected`, `refunded`, `charged_back`) → nada a cancelar; desconhecido → `UNEXPECTED_STATE` (invariante 9), sem cancelar; `action_required` → cancela; `created`/`processing`/`in_review` → tenta cancelar, e uma recusa do Mercado Pago propaga.
5. **Resultado na session:** status `canceled` e o status real da Order MP em `data` (a confirmação passa a mostrar o Pix cancelado, sem QR).
6. **Transação:** qualquer erro no hook (Pix pago, ambiguidade, recusa ou falha do Mercado Pago) é relançado com o motivo; o `cancelOrderWorkflow` falha e é compensado, e o pedido não fica cancelado. Corrida pagamento × cancelamento: se o Pix foi pago e o webhook ainda não chegou, o cancelamento é recusado; o reembolso fica para o fluxo normal depois que o pagamento for processado. O hook não reembolsa.
7. **Idempotência:** a convenção existente `sha256(<mercadopago_pix_idempotency_key>:cancel)`: estável para a mesma Order MP (um retry reusa a key) e diferente das keys de criação, session e reembolso.

## Alternativas consideradas

- **`cancelOrder` → `cancelPayment` do provider:** no cenário A não há Payment; exigiria substituir o workflow ou a rota do core. Descartada.
- **Subscriber de `order.canceled`:** assíncrono; não impede cancelar um pedido cujo Pix acabou de ser pago, e uma falha fica fora do cancelamento. Descartada como mecanismo principal [decisão humana 2026-09-29].
- **`deletePaymentSession`** (também chega a `invalidatePixOrder`): apagaria a session; a confirmação responderia 404 em vez de "cancelado", e a correlação do webhook perderia a session. Descartada.
- **Chamar a Orders API direto no hook:** duplicaria a regra de `invalidatePixOrder`. Descartada.

## Consequências

- Pedido cancelado e cobrança Pix pendente ficam consistentes: validado no sandbox (INV-005: #94 cancelado com a Order MP `canceled`; #95 com Pix pago recusado e revertido; #96 com Payment capturado reembolsado pelo core sem chamar o hook).
- Quando o rollback acontece, a payment collection fica `canceled` com o pedido não cancelado: a compensação de `updatePaymentCollectionStep` do Medusa 2.20.1 falha (snapshot só com `{ id, status }`) e o workflow termina `FAILED` ([INV-006](../investigations/INV-006-payment-collection-rollback.md)). No caso de Pix pago, corrige-se no próximo evento de pagamento (`maybeUpdatePaymentCollection_`), observado no #95. Não tratado aqui.
- Um cancelamento pode falhar por indisponibilidade do Mercado Pago: nesse caso o pedido não é cancelado e o erro chega a quem pediu.
