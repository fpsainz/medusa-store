# INV-004: `refundPayment` — valor, idempotency key e reembolso total × parcial

> Status: concluída · Aberta em: 2026-09-29 · Concluída em: 2026-09-29 · Commit: `fb5d9a0` (correção não commitada) · Decisão: [ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md)

Marcadores de origem: [../README.md](../README.md#convenções). **[MCP 2026-09-29]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data. **[core 2.20.1]** indica código do Medusa 2.20.1 instalado em `node_modules`, lido nessa data. **[sandbox 2026-09-29]** indica resultado observado na Orders API sandbox nesta investigação.

A correção está implementada, coberta por testes unitários e validada no sandbox (cartão e Pix, total e parcial). Os pontos que o sandbox não mostrou estão em [Perguntas em aberto](#perguntas-em-aberto-não-validado).

## Achado

A revisão do ciclo de vida do Pix (Fase 1, 2026-09-29) encontrou, só pela leitura do código, três pontos em `refundPayment` (`service.ts`):

- **E1:** o valor chega como objeto e vira `NaN`.
- **E2:** todos os reembolsos de um Payment usam a mesma idempotency key.
- **E3:** o reembolso total é enviado no formato do parcial.

## Contrato do Mercado Pago [MCP 2026-09-29]

Fontes: `checkout-api-orders/payment-management/refunds-cancellations`, `checkout-api-orders/integration-model`, `checkout-api-orders/payment-management/integration-errors`. As tabelas de resposta e de status de reembolso vêm de `qr-code/migrate-instore-orders-to-orders`, que descreve a mesma Orders API para outro produto; para pagamentos online elas são apoio, não prova.

- Endpoint único para os dois casos: `POST /v1/orders/{order_id}/refund`.
- **Total:** "não deverá ser indicado o valor a ser reembolsado no `body` da requisição, que deve ser enviado vazio".
- **Parcial:** "deverá ser especificada a quantia a ser reembolsada no `body` da requisição junto com o ID da transação": `transactions[{ id, amount }]`, com `id` = `transactions.payments[].id` da Order.
- A Order só fica totalmente reembolsada quando todas as transações forem estornadas por completo.
- `X-Idempotency-Key` obrigatório, de 1 a 128 caracteres, único por requisição. Chave repetida com requisição diferente → `409 idempotency_key_already_used`; chave temporariamente bloqueada → `423 resource_locked`.
- Outros erros de reembolso: `400 refund_amount_exceeds`, `409 cannot_refund_order`, `409 order_already_refunded`, `409 order_refund_already_in_process`.
- Pré-condições: até 180 dias após a aprovação; saldo suficiente na conta do vendedor. Pix é devolvido na conta do pagador.
- Depois do reembolso (documentação de QR): total → Order `refunded/refunded`; parcial → `processed/partially_refunded`. `transactions.refunds[].status`: `processing`, `processed` ou `failed`.
- Particularidade de Pix documentada **só para a Payments API** (`/v1/payments/{id}/refunds`): o reembolso pode ficar em contingência (comunicação com o Bacen) e ser reportado como `400`, a menos que se envie `X-Render-In-Process-Refunds: true`. Para a Orders API, não há documentação equivalente.

O SDK `mercadopago` 3.6.1 (`Order.refund`) segue o mesmo contrato: "Omit the body for a full refund"; sem `body`, a requisição sai sem corpo.

## Contrato do Medusa [core 2.20.1]

- `PaymentModuleService.refundPayment` grava o `Refund` primeiro (`refundPayment_`), sob lock da linha do Payment, e recusa quando `já reembolsado + valor > capturado`. Depois chama o provider (`refundPaymentFromProvider_`) com `{ data: payment.data, amount: refund.raw_amount, context: { idempotency_key: refund.id } }`. Se o provider lançar erro, o `Refund` é apagado e o erro propaga. Se der certo, `payment.data` é substituído pelo `data` devolvido.
- `refund.raw_amount` é o valor bruto do `MikroOrmBigNumberProperty`: `{ value, precision }` (por exemplo `{ value: "10", precision: 20 }`). O tipo declarado é `BigNumberInput` (`RefundPaymentInput.amount`).
- `context.idempotency_key` é documentado em `PaymentProviderContext` como a chave da requisição. O provider oficial de Stripe 2.20.1 converte o valor com `BigNumber` e usa `context.idempotency_key` no reembolso.
- Cada reembolso é um `Refund` separado do mesmo Payment. Como o Pix e o cartão são capturados por inteiro, um reembolso igual ao valor total do Payment só passa pelo guard quando nada foi reembolsado antes.

## Reprodução (antes da correção)

Teste: `apps/backend/src/modules/mercadopago/__tests__/refund.unit.spec.ts` (`RF`), escrito com o comportamento esperado e executado contra o `service.ts` de `fb5d9a0`, sem alterações: **16 de 20 testes falharam**, e a variante de E2 com valores numéricos, acrescentada em seguida, também falhou. Nenhuma chamada real ao Mercado Pago (o SDK é substituído por mock).

- **E1 reproduzido.** Com `amount = { value: "10", precision: 20 }`, `refundPayment` lançou `Mercado Pago: refund amount must be a positive number.` sem chamar a API: `getAmount` faz `Number(input.amount)`, e `Number({ value, precision })` é `NaN`. Consequência: todo reembolso pedido pelo Medusa falhava antes de chegar ao Mercado Pago.
- **E2 reproduzido.** Com valores numéricos (que o código antigo aceitava) e `context.idempotency_key` `ref_01A` e `ref_01B`, os dois reembolsos saíram com a mesma key, a `mercadopago_idempotency_key` da session: `getIdempotencyKey` devolve essa chave antes de olhar o contexto.
- **Achado extra.** Sem `amount`, o código antigo não falhava: usava `data.amount` e reembolsava o valor total da session.
- **E3.** O código antigo sempre enviava `transactions[{ id, amount }]`, também para o valor total.

## Correção (não commitada, sobre `fb5d9a0`)

Só `refundPayment` mudou (`service.ts`); `getIdempotencyKey` e as outras operações ficaram como estavam.

- **Valor:** `toPositiveDecimalString` converte qualquer `BigNumberInput` com o `BigNumber` do Medusa e formata com 2 casas. Valor ausente, inválido, zero ou negativo é recusado antes da chamada. Não existe mais fallback para `data.amount`.
- **Idempotency key:** sempre `context.idempotency_key` (`refund.id`). Ausente, vazia ou com mais de 128 caracteres → recusa antes da chamada. A key da session e a de criação do Pix nunca são usadas.
- **Total × parcial:** total quando o valor pedido é igual a `payment.data.amount` (comparação em 2 casas) → `POST /v1/orders/{id}/refund` sem body. Qualquer outro valor, inclusive o restante depois de reembolsos parciais, é parcial com `transactions[{ id: mercadopago_payment_id, amount }]`. Sem `data.amount`, nunca é total.
- **Sem leitura prévia da Order:** o guard do Medusa já garante que "igual ao total" só ocorre sem reembolso anterior registrado no Medusa.
- Erro da API propaga sem tratamento, para o Payment Module apagar o `Refund`.

Testes (`RF`, 22): E1 com valor bruto, número, string e precisão longa; valor zero, negativo e ausente; E2 com dois reembolsos e duas keys (também com valores numéricos); key ausente, vazia e longa demais; nenhuma key da session nem de criação do Pix; total sem body; parcial com o ID da transação; restante como parcial; sem `data.amount`; sem `mercadopago_payment_id`; sem `mercadopago_order_id`; cartão; nenhuma leitura da Order; erro da API propagado.

## E2E sandbox (2026-09-29)

### Método

- **Caminho:** `refundPaymentWorkflow` do core, o mesmo que a rota `POST /admin/payments/:id/refund` executa, rodado com `medusa exec` a partir de um script fora do repositório (`created_by: "e2e-inv-004"`, `note: "INV-004 E2E sandbox"`). A camada HTTP/autenticação do Admin **não** foi exercitada; o resto (workflow → Payment Module → provider → SDK → Orders API) é o caminho real.
- **Captura da requisição:** o script substituiu o `fetch` global do processo por um wrapper que registrou método, URL, `X-Idempotency-Key`, presença e conteúdo do body, status HTTP e corpo da resposta. O header `Authorization` não foi registrado.
- **Leituras:** `GET /v1/orders/{id}` antes, logo depois e ~6 min depois; consultas read-only ao banco.
- **Pedidos:** só Orders `ORDTST` (sandbox), `processed/accredited` e sem reembolso anterior no Mercado Pago e no Medusa [sandbox 2026-09-29] [banco 2026-09-29].
- O backend e o túnel estavam desligados: as notificações de reembolso não foram recebidas.

### Resultados [sandbox 2026-09-29]

| Pedido | Método | Pedido ao Medusa | Requisição enviada | HTTP | Resposta | Order depois (`GET`, imediato e ~6 min) |
|---|---|---|---|---|---|---|
| #85 | cartão (visa) | total R$ 110 | `POST /v1/orders/{id}/refund`, **sem body**, key = `refund.id` | 201 | Order `refunded/refunded`; 1 reembolso `processed` R$ 110,00 | `refunded/refunded`; payment `refunded/refunded`, `refunded_amount` 110,00 |
| #80 | cartão (visa) | parcial R$ 35 de R$ 135 | `{"transactions":[{"id":"PAY…","amount":"35.00"}]}`, key = `refund.id` | 201 | `processed/partially_refunded`; reembolso `processed` R$ 35,00 | `processed/partially_refunded`; `refunded_amount` 35,00 |
| #91 | Pix | parcial R$ 30 de R$ 110 | `{"transactions":[{"id":"PAY…","amount":"30.00"}]}`, key A = `refund.id` | 201 | `processed/partially_refunded`; reembolso `processed` R$ 30,00 | `processed/partially_refunded`; `refunded_amount` 30,00 |
| #91 | Pix | parcial R$ 80 (restante) | `{"transactions":[{"id":"PAY…","amount":"80.00"}]}`, key B = `refund.id` ≠ A | 201 | `refunded/refunded`; 2 reembolsos `processed` (30,00 e 80,00) | `refunded/refunded`; `refunded_amount` 110,00 |
| #92 | Pix | total R$ 160 | **sem body**, key = `refund.id` | 201 | `refunded/refunded`; reembolso `processed` R$ 160,00 | `refunded/refunded`; `refunded_amount` 160,00 |
| #91 | Pix | mais R$ 1 (acima do capturado) | nenhuma | — | Medusa: `You are not allowed to refund more than the captured amount` (`invalid_data`) | inalterada; nenhum `Refund` criado |

- Em todos os reembolsos enviados, a key foi exatamente o `id` do `Refund` criado pelo Medusa, diferente da `mercadopago_idempotency_key` da session e, no Pix, da `mercadopago_pix_idempotency_key`.
- Os reembolsos de Pix trazem `e2e_id` na resposta; os de cartão, não.
- A resposta do reembolso traz só `id`, `status`, `status_detail` e `transactions.refunds` (sem `transactions.payments`).
- Nenhum reembolso apareceu em `processing` ou `failed`: todos já vieram `processed` na resposta 201 e continuaram assim ~6 min depois.

### Lado Medusa [banco 2026-09-29]

- Um `Refund` por reembolso (5), com os valores pedidos.
- Payment collection `completed`, com `refunded_amount` = soma dos reembolsos (110, 35, 110, 160).
- `order_transaction` de referência `refund` com o valor negativo de cada reembolso.
- Credit lines de reembolso criadas pelo core (`createOrderRefundCreditLinesWorkflow`), versionadas por versão do pedido: no #91, a versão atual (3) tem 30 + 80 = 110; a linha de 30 da versão 2 é a do estado anterior.
- `payment.data`: `mercadopago_order_status`/`_detail`, `mercadopago_refund_id` e `mercadopago_refunded_amount` (último reembolso) atualizados.

### Classificação

| Ponto | Resultado |
|---|---|
| E1 — valor `{ value, precision }` convertido | ✅ teste unitário · ✅ E2E (5 reembolsos chegaram ao Mercado Pago com o valor certo) |
| E2 — key por `Refund` | ✅ teste unitário · ✅ E2E (key = `refund.id`; A ≠ B no mesmo Payment) |
| Total sem body | ✅ teste unitário · ✅ E2E (cartão #85, Pix #92) |
| Parcial com `transactions[{ id, amount }]` | ✅ teste unitário · ✅ E2E (cartão #80, Pix #91) |
| Dois parciais somando o total | ✅ E2E (#91: `partially_refunded` → `refunded`) |
| Acumulado acima do capturado | ✅ E2E: recusado pelo Medusa, sem chamada ao Mercado Pago |
| Key ausente/inválida → sem chamada | ✅ teste unitário (não exercitável pelo core, que sempre envia `refund.id`) |
| Mesma key em retry da mesma operação | ⚠ não observado em E2E. Pelo código, o retry interno do SDK (`RestClient.retryWithExponentialBackoff`) reenvia os mesmos headers; um novo pedido de reembolso no Medusa é um novo `Refund`, com nova key |
| Estado do reembolso | ✅ E2E: `processed` na resposta e ~6 min depois, cartão e Pix. ⚠ `processing`/`failed` não observados |
| `payment.data.mercadopago_payment_status`/`mercadopago_status_detail` depois do reembolso | ⚠ ambíguo, sem bug funcional: continuam `processed/accredited`, enquanto a transação no Mercado Pago passou a `refunded`/`partially_refunded`. Nenhum código lê esses campos em `payment.data`. Ver [Semântica de `payment.data` depois do reembolso](#semântica-de-paymentdata-depois-do-reembolso) |

## Semântica de `payment.data` depois do reembolso

Auditoria de 2026-09-29 sobre o código com a correção (não commitada, sobre `fb5d9a0`), o Medusa 2.20.1 instalado e os pedidos do E2E. Sem alteração de código nem de dados. Pergunta: `mercadopago_payment_status`/`mercadopago_status_detail` continuarem `processed/accredited` depois de um reembolso é um erro, ou esses campos representam o pagamento original?

### Escritores (`service.ts`)

Todos copiam `transactions.payments[0].status`/`status_detail` da resposta que a função acabou de receber do Mercado Pago. Nenhum usa `Order.status` nem `transactions.refunds`.

| Função | Momento | Resposta de origem | Grava em |
|---|---|---|---|
| `mergePixOrderData` (via `createPixOrder`, `reauthorizePixOrder`, `preparePixOrder`) | Pix: prepare, criação, autorização | `POST /v1/orders` ou `GET /v1/orders/{id}` | session (e depois o Payment, que copia a session na autorização) |
| `authorizePayment` (cartão) | Place order | `POST /v1/orders` | session → Payment |
| `retrievePayment`, `getPaymentStatus` | nunca chamados pelo core 2.20.1 para este provider | `GET /v1/orders/{id}` | só no retorno |
| `refundPayment` | reembolso | `POST /v1/orders/{id}/refund` | Payment. `payment?.status ?? valor anterior`: a resposta de reembolso não traz `transactions.payments` [sandbox 2026-09-29], então o valor anterior é mantido |
| `withoutPixOrder` (`PIX_ORDER_FIELDS`) | troca de método, `deletePayment`, regenerate | — | remove os dois campos da session |

O webhook não escreve nesses campos: lê `payment.status` ao vivo (`GET /v1/orders/{id}`) e o passa no payload do evento.

### Leitores

| Campo | Leitor | Arquivo | Finalidade | Lê de | Interpreta como |
|---|---|---|---|---|---|
| ambos | `toPixPaymentDto` → `normalizePixStatus` | `service.ts`; rotas `carts/:id/pix`, prepare, `payment-access/pix` | status Pix exibido no storefront | **session**, não Payment | status da transação, só como fallback quando falta `mercadopago_order_status` (a Order tem prioridade) |
| `mercadopago_payment_status`, `mercadopago_status_detail` | `refundPayment` | `service.ts` | manter o valor anterior quando a resposta não traz `payments` | Payment | cópia; nenhuma decisão |

- Nenhum leitor de `payment.data.mercadopago_payment_status`/`mercadopago_status_detail` toma decisão: não há uso em autorização, captura, reembolso, webhook ou estado do pedido.
- O core 2.20.1 só repassa `payment.data` ao provider (captura, reembolso, cancelamento) e grava o `data` devolvido; nunca chama `retrievePayment`/`getPaymentStatus` deste provider.
- O dashboard do Admin 2.20.1 não referencia `payment.data`.
- A Store API reduz `payments[].data` a `{ payment_method_id }` (invariante 24), e as rotas `/store/mercadopago/*` usam só a session. Os campos não chegam ao storefront.
- O reembolso não altera a session: nos quatro pedidos, a session continua `authorized` com `processed` [banco 2026-09-29].

### Modelo do Mercado Pago [MCP 2026-09-29] [sandbox 2026-09-29]

- Order e transação têm cada uma `status`/`status_detail`, com os mesmos pares: `processed/accredited`, `processed/partially_refunded`, `refunded/refunded` (`checkout-api-orders/payment-management/status/order-status` e `.../transaction-status`).
- Cada reembolso é um objeto em `transactions.refunds[]`, com `status` `processing`/`processed`/`failed` (documentação da Orders API para QR).
- O reembolso **muda o status da transação**: depois dos reembolsos, `GET /v1/orders/{id}` mostra `transactions.payments[0]` `processed/partially_refunded` (#80) e `refunded/refunded` (#85, #91, #92). Logo, no Mercado Pago, `transactions.payments[].status` é o estado atual da transação, não o do pagamento original.

### Modelo do Medusa 2.20.1 [core 2.20.1]

- `Payment` é o pagamento (valor, `captured_at`, `captures`); cada reembolso é um `Refund` ligado a ele; `PaymentCollection.refunded_amount` soma os reembolsos; cada reembolso gera uma `OrderTransaction` `refund` com valor negativo.
- O único mecanismo nativo que atualiza `payment.data` depois do reembolso é gravar o `data` devolvido por `refundPayment` (`refundPaymentFromProvider_`).

### Pedidos do E2E (leitura de 2026-09-29 17:16Z)

| Pedido | `payment.data` status | `payment.data` status da Order | Order MP | Transação MP | Reembolsos MP | Refunds Medusa / OrderTransactions |
|---|---|---|---|---|---|---|
| #85 cartão | `processed/accredited` | `refunded/refunded` | `refunded/refunded` | `refunded/refunded`, 110,00 | 110,00 `processed` | 110 / −110 |
| #80 cartão | `processed/accredited` | `processed/partially_refunded` | `processed/partially_refunded` | `processed/partially_refunded`, 35,00 | 35,00 `processed` | 35 / −35 |
| #91 Pix | `processed/accredited` | `refunded/refunded` | `refunded/refunded` | `refunded/refunded`, 110,00 | 30,00 + 80,00 `processed` | 30 + 80 / −30, −80 |
| #92 Pix | `processed/accredited` | `refunded/refunded` | `refunded/refunded` | `refunded/refunded`, 160,00 | 160,00 `processed` | 160 / −160 |

### Conclusão: ⚠ ambíguo, sem bug

- **Caso A (pagamento original) não se sustenta:** os escritores copiam o status atual da transação a cada leitura, e o próprio Mercado Pago muda esse status no reembolso. O valor `processed/accredited` é o último status da transação que o provider leu, anterior ao reembolso.
- **Caso B (bug) não se configura:** nenhum consumidor lê esses campos em `payment.data` para decidir algo ou para exibir.
- O estado do reembolso já está representado por `Refund`, `OrderTransaction`, `PaymentCollection.refunded_amount` e, em `payment.data`, por `mercadopago_order_status`/`mercadopago_order_status_detail` (atualizados pela resposta do reembolso), `mercadopago_refund_id` e `mercadopago_refunded_amount` (último reembolso).
- **Semântica documentada:** `mercadopago_payment_status`/`mercadopago_status_detail` = status de `transactions.payments[0]` na última resposta do Mercado Pago que trouxe a transação. Não são o estado atual depois de um reembolso.
- Nenhuma correção nem campo novo. Só vira mudança se aparecer um consumidor que precise do estado atual da transação em `payment.data`.

### Notificação de reembolso

- **Evento:** a lista de ações do tópico Order para pagamentos online não foi encontrada pelo MCP [não validado]. `order.refunded` aparece só na documentação de Point/QR.
- **Handler e efeito, pelo código:** a rota do webhook lê a Order ao vivo. `refunded/refunded` → `getStatusFromGateway` → `pending` → `not_supported`, e o core ignora. `processed/partially_refunded` → `captured` → `processPaymentWorkflow` sobre um Payment já capturado: `capturePayment_` não cria Capture e `addOrderTransactionStep` deduplica, sem efeito além de um novo evento `payment.captured`.
- As notificações dos reembolsos do E2E não foram recebidas (backend e túnel desligados) e não foram observadas.

## Perguntas em aberto [não validado]

- Um reembolso pode ficar em `processing` (por exemplo, contingência de Pix com o Bacen, documentada só para a Payments API) ou falhar depois com `failed`? No sandbox, todos vieram `processed` de imediato. Hoje o provider devolve sucesso assim que a API aceita a operação; se isso for observado, vira investigação própria antes de qualquer mudança.
- Recusa do Mercado Pago (`409`/`400`) chegando ao Admin, com o `Refund` apagado pelo core: coberto por teste unitário, não observado em E2E.
- Reembolso feito fora do Medusa seguido de um total pedido pelo Medusa: esperado `order_already_refunded`/`refund_amount_exceeds`.
- Notificações de reembolso: não recebidas (backend e túnel desligados). Pelo código, `refunded` → `not_supported` e `processed/partially_refunded` → `captured` sobre um Payment já capturado, sem efeito (Fase 1). O Mercado Pago tende a reenviar as notificações não entregues.
- Rota HTTP do Admin (`POST /admin/payments/:id/refund`) não exercitada; ela só executa o mesmo `refundPaymentWorkflow`.

## Resultado

Concluída. E1 e E2 reproduzidos por teste, corrigidos no código e validados no sandbox; total sem body e parcial com `transactions` observados na Orders API real, para cartão e Pix. Decisão registrada no [ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md); regras nos invariantes 42–44. Pendências menores: a semântica ambígua de `mercadopago_payment_status`/`mercadopago_status_detail` em `payment.data` (⚠, sem consumidor, sem bug) e os itens não observados acima.
