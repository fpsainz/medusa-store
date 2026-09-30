# INV-008: idempotency key do cartão estável durante a Payment Session

> Status: **concluída** (hipótese confirmada por E2E sandbox; corrigida pela estratégia B, [ADR-014](../decisions/ADR-014-card-order-idempotency-key-from-body.md) aceito; regressão E2E sandbox em 2026-09-29; código ainda não commitado) · Aberta em: 2026-09-29 · Commit: `629acfd`

## Achado

A `X-Idempotency-Key` da criação da Order de cartão (`POST /v1/orders`, em `authorizePayment`) é a mesma durante toda a Payment Session. A pergunta é se isso separa corretamente um retry da mesma tentativa de uma nova tentativa de pagamento.

## Fatos

### Projeto

Verificado no código em `629acfd`.

- **Origem.** O Payment Module chama `initiatePayment` com `context.idempotency_key = paymentSession.id`. `getIdempotencyKey` (`service.ts`) usa, nesta ordem:
  1. `data.mercadopago_idempotency_key`;
  2. `context.idempotency_key`;
  3. `data.idempotency_key`;
  4. um hash de `cart_id`/`amount`/`currency`.

  Na criação da session só existe o item 2, então a chave é o **ID da Payment Session** (`payses_…`).
- **Armazenamento.** `initiatePayment` grava a chave em `session.data.mercadopago_idempotency_key`. Dali em diante o item 1 sempre vence: `updatePayment` e `authorizePayment` a regravam sem alteração.
- **O cliente não altera a chave.** `buildAllowedSessionData` não aceita o campo (invariante 2). A rota de update faz `{ ...previousData, ...allowedData }`, então a chave antiga é preservada a cada novo `onSubmit` do Brick. O `payment_type_id` antigo é descartado quando chega um `card_token` novo; a chave, não.
- **Consumo.** Em `authorizePayment` (cartão), `orderClient.create({ body, requestOptions: { idempotencyKey } })`. O body inclui `payment_method.token = card_token`, `installments`, `type`, `payer` e `amount`. Não há `try/catch`: qualquer erro do SDK é propagado.
- **Duração.** A chave vive enquanto a session existir. Ela só muda quando a session é recriada, porque a nova session tem outro ID:
  - novo `initiatePaymentSession`;
  - `refreshPaymentCollectionForCartWorkflow` (mudança do total do cart).

  Detalhes na [INV-007](INV-007-payment-button-first-session.md).
- **Pix.** Usa uma chave própria, `sha256(base:pix:<valor>:<geração>)`, que muda a cada substituição da cobrança (invariante 11). Não é afetado.
- **Reembolso.** Usa `refund.id` (invariante 43). Não é afetado.
- **`cancelPayment` (cartão).** Usa `getIdempotencyKey(data)`, ou seja, **a mesma chave da criação**, em `POST /v1/orders/{id}/cancel`. O cancelamento do Pix, ao contrário, usa uma chave derivada (`sha256(<pix key>:cancel)`).
- **Webhook.** A rota do webhook e `getWebhookActionAndData` só fazem `GET /v1/orders/{id}` e emitem o evento. Nenhum `create` é feito, então nenhuma operação idempotente é repetida.

### Medusa 2.20.1 instalado

- `authorizePaymentSession` (`@medusajs/payment`) retorna o Payment existente se `session.payment && session.authorized_at`, sem chamar o provider. Uma vez autorizada, a session nunca volta a chamar o `create`.
- O status devolvido pelo provider só é gravado quando o provider **retorna**:
  - com status diferente de `authorized`/`captured`, a session fica com esse status (por exemplo `error`) e é lançado `NOT_ALLOWED`;
  - quando o provider **lança**, nada é gravado e a session continua `pending`.
- `authorizePaymentSessionStep` engole o erro que não é `MedusaError`, relê a session e, se ela ainda está `pending`, lança `PAYMENT_AUTHORIZATION_ERROR`. O comentário do core diz: "this usually requires the consumer to create a new payment session". O core não recria a session sozinho.

### SDK `mercadopago` 3.6.1 instalado

- Resposta não 2xx → lança um `MercadoPagoError` tipado. `402` → `MPPaymentError` (comentário do SDK: "transaction processing error (AP/Orders)").
- Retry interno em `429, 500, 502, 503, 504`, até 3 vezes, com backoff e **a mesma** `idempotencyKey` informada.

### Mercado Pago (documentação oficial, via MCP `search_documentation`, 2026-09-29)

- "O header `X-Idempotency-Key` é obrigatório nas operações de criação, cancelamento e reembolso de orders. Ele garante que uma requisição repetida com a mesma chave retorne o resultado original sem processar a operação novamente."
- "Se a mesma `X-Idempotency-Key` for reutilizada com um body diferente, a API retornará o erro `idempotency_key_already_used`. Gere uma nova chave para cada operação distinta." Erro: `409 idempotency_key_already_used`, "já foi utilizado com uma requisição distinta nas últimas 24 horas".
- Erros de integração da Orders API: `402 failed`, "There was an error processing one of the transactions". Os status de transação `failed` incluem `rejected_by_issuer`, `insufficient_amount`, `bad_filled_card_data`, `high_risk` etc.
- Também documentados: `423 resource_locked` (chave temporariamente travada: repetir) e `500 idempotency_validation_failed` ("Try resending the request with a new and unique idempotency key").

## Fluxo real da chave

```text
POST /store/payment-collections/:id/payment-sessions
  → createPaymentSession: context.idempotency_key = payses_X
  → initiatePayment: data.mercadopago_idempotency_key = payses_X          (origem + armazenamento)
Brick onSubmit (cada envio gera um card_token novo)
  → POST /store/mercadopago/payment-sessions/:id → { ...previousData, ...allowed }
  → updatePayment: mantém payses_X                                           (reutiliza)
Place order → completeCart → authorizePaymentSession
  → authorizePayment → POST /v1/orders, X-Idempotency-Key: payses_X, body com o card_token atual   (consome)
  → SDK: retry em 429/5xx com payses_X                                      (reutiliza, correto)
  → 201: status gravado; captured → Payment; failed/rejected → session "error"
  → 402 (recusa): SDK lança → nada gravado → session pending, chave payses_X
webhook → GET /v1/orders/{id} → processPaymentWorkflow                      (não consome a chave)
nova session (troca de provider, mudança do total) → payses_Y              (regenera)
```

## Casos

| Evento | Mesma chave? | Nova chave? | Correto? | Motivo |
|---|---|---|---|---|
| A — retry da mesma operação (timeout/5xx/429, retry interno do SDK ou novo Place order com os mesmos dados) | sim | não | ✅ | Mesmo body e mesma chave: o Mercado Pago devolve o resultado original e não cobra de novo. É para isso que a chave existe. |
| B — recusa (402) e o cliente envia **outro cartão** pelo Brick na mesma session | sim | não | ❌ | O body muda (token novo) com a mesma chave → `409 idempotency_key_already_used` (janela documentada de 24 h). A nova tentativa legítima é bloqueada. **Confirmado no E2E de 2026-09-29.** |
| B' — recusa (402) e o cliente clica Place order de novo sem reenviar o cartão | sim | não | ✅ | É um retry: o Mercado Pago devolve a mesma recusa, e o token de cartão é de uso único. |
| Recusa devolvida como 2xx com `failed` | sim | — | ✅ na prática | A session fica `error`. `Payment` e o Brick só usam session `pending` ([INV-007](INV-007-payment-button-first-session.md)), então o cliente precisa escolher o método de novo, o que cria uma session nova e, com ela, uma chave nova. |
| C — nova Payment Session | não | sim | ✅ | A chave é o ID da session. |
| D — webhook duplicado ou tardio | — | — | ✅ | O webhook não faz `create`. Um `authorizePaymentSession` repetido depois da autorização retorna o Payment existente sem chamar o provider. |
| Nova cobrança legítima na mesma session (novo cartão, novas parcelas) | sim | não | ❌ | É o caso B: toda nova submissão do Brick é uma operação distinta para a Orders API, mas reutiliza a chave. |

**Resposta à pergunta central:** a chave deve ser a mesma para qualquer repetição **do mesmo body** (retry do SDK, novo Place order com os mesmos dados) e mudar sempre que o body mudar, ou seja, a cada nova submissão do Brick (novo `card_token`). A chave atual representa uma **entidade do Medusa** (a Payment Session), não **uma operação da Orders API**.

## Por que a session continua pendente depois da recusa

1. O Mercado Pago responde `402` à recusa (documentação oficial).
2. O SDK lança.
3. `authorizePayment` não trata o erro.
4. O Payment Module não grava nada.
5. A session continua `pending` com a mesma chave.
6. O storefront volta a renderizar o Brick para a mesma session (`MercadoPagoPaymentContainer` usa a session `pending`).
7. `Payment.handleSubmit` não recria a session, porque o provider é o mesmo (`checkActiveSession`).

## Hipóteses

- **H1: CONFIRMADA** [sandbox 2026-09-29]. Cartão recusado na criação → `402`, `errors[0].code = "failed"`.
- **H2: CONFIRMADA** [sandbox 2026-09-29]. Mesma chave com outro token → `409 idempotency_key_already_used`.
- **H3** [não validado]. `POST /v1/orders/{id}/cancel` com a mesma chave usada no `POST /v1/orders` conflita (o escopo da chave por endpoint não está documentado). Isso afetaria `cancelPayment` (cartão), que não tem testes nem E2E (status.md, item 9). **Ponto separado**, fora da correção proposta.

## Por que um E2E agrega evidência

O código determina o caminho de forma inequívoca **se** H1 e H2 forem verdadeiras. As duas dependem do comportamento real da API, que o código não mostra. Pela regra do projeto, um achado sem evidência não vira correção direta.

O E2E mínimo, no sandbox, sem alterar código:

1. Checkout de cartão com o nome do titular de recusa (`OTHE` ou equivalente da lista oficial de cartões de teste do Brasil) → Place order. Observar HTTP (`402`?) e session (`pending`, mesma chave?) [banco read-only].
2. Na mesma session, reenviar pelo Brick com o nome de aprovação (`APRO`) → Place order. Observar: `409 idempotency_key_already_used`?
3. Registrar a Order Mercado Pago recusada (ID truncado, status).

O E2E cria até duas Orders de sandbox e nenhuma alteração administrativa. Pode ser feito com o storefront ou, como no E2E da capability, com o payload do `onSubmit` enviado por HTTP.

## E2E sandbox (2026-09-29)

### Método

- **Caminho real, sem alterar o repositório:** `medusa exec` com um script fora do repositório.
  - O cart foi montado com os workflows do core, os mesmos das rotas da Store: `createCartWorkflow`, `addShippingMethodToCartWorkflow`, `createPaymentCollectionForCartWorkflow` e `createPaymentSessionsWorkflow` com `pp_mercadopago`.
  - O `onSubmit` do Brick foi substituído pelo `POST` real da rota `payment-sessions/[id]/route.ts`, importada e chamada com o mesmo payload (`card_token`, `payment_method_id`, `payment_type_id`, `installments`, `amount`, `cart_id`, `payer`).
  - O Place order foi o `completeCartWorkflow`.
- **Não exercitados:** navegador, iframe do Brick e camada HTTP da Store.
- **Cartões:** tokenizados por `POST /v1/card_tokens`, com os cartões de teste oficiais do MLB. Titular `OTHE` (recusa) na tentativa 1 e `APRO` (aprovação) na tentativa 2. Números e tokens não registrados; só o prefixo do SHA-256 de cada token.
- **Captura:** um wrapper do `fetch` global do processo registrou, para `/v1/orders`, o `X-Idempotency-Key`, o body (token substituído pelo hash), o hash do body, o HTTP e a resposta. `Authorization` não foi registrado. A session foi lida pelo Payment Module do processo (`listPaymentSessions` com `payment` e `payment.captures`).
- **Dados:** cart `cart_01M3QTD53360B93NB4WCJ5Z5GQ` (R$ 110,00), collection `pay_col_01M3QTD85PV497BSQM9PWZXQ0P`. Nenhum pedido existente (#97–#101 inclusive) foi usado.

### Resultados [sandbox 2026-09-29]

| Item | Tentativa 1 | Tentativa 2 |
|---|---|---|
| Payment Session | `payses_01M3QTD8FRTDZQC8KSERMJQP42` | **a mesma** |
| idempotency key | `payses_01M3QTD8FRTDZQC8KSERMJQP42` | **a mesma** |
| card token (sha256) | `d06b58be8f29` | `e3c2f7994a0a` |
| body | `visa`, token 1 (hash do body `721994dd08e9bcc9`) | `master`, token 2 (hash do body `f6e3ca1f4aa1e0dd`); resto idêntico |
| HTTP Mercado Pago | **402** | **409** |
| resposta | `failed`: "The following transactions failed", `PAY01M3QTDH2E15SGGKAC5FXXVC9Z: rejected_by_issuer` | `idempotency_key_already_used`: "X-Idempotency-Key already used. Please retry with a different value." |
| erro no Medusa | `authorize-payment-session-step`: `payment_authorization_error` "Payment authorization failed" (log: `MPPaymentError`) | o mesmo (log: `MPIdempotencyError`) |
| Payment criado | não | não |
| captura | não | não |
| session depois | `pending`, sem nenhum campo `mercadopago_order_*`/`payment_*` gravado | `pending`, idem; `data` com o token 2 |
| cart | aberto | aberto |

Em cada tentativa houve exatamente uma chamada a `POST /v1/orders`. O SDK não repetiu, porque 402 e 409 não estão em `retryOn`.

**Teste C (nova session):** `createPaymentSessionsWorkflow` na mesma collection criou `payses_01M3QTDEM50861FFZK75DWFQQW`, com `mercadopago_idempotency_key = payses_01M3QTDEM50861FFZK75DWFQQW`. A session anterior foi apagada, e a collection ficou só com a nova. Nenhuma compra foi concluída.

| Session | Idempotency key |
|---|---|
| Session antiga | `payses_01M3QTD8FRTDZQC8KSERMJQP42` |
| Nova session | `payses_01M3QTDEM50861FFZK75DWFQQW` |

### Limitações

- A resposta 402 não traz o ID da Order Mercado Pago, só o do payment recusado. A busca read-only de Orders por `external_reference` foi bloqueada por um hook de segurança do ambiente (plugin Mercado Pago) e não foi contornada. Por isso, não está comprovado se a tentativa 1 deixou uma Order `failed` registrada no Mercado Pago. A tentativa 2 (409) não foi processada, segundo a documentação ("retorne o resultado original sem processar a operação novamente" vale para o mesmo body; com body diferente, só o erro).
- A página do storefront e o Brick real não foram exercitados. O comportamento do storefront depois da recusa (Brick de novo para a session `pending`) vem da leitura do código ([INV-007](INV-007-payment-button-first-session.md)).
- O cart e a session do teste C ficaram abertos, como dados de sandbox.

## Resultado (técnico)

**Conclusão C, CONFIRMADA** por E2E sandbox em 2026-09-29, com parte de **D**. A chave deveria mudar a cada nova submissão do cartão (novo `card_token`) e não muda. A estabilidade é correta para retries (caso A) e para sessions novas (caso C). O excesso está no ponto de consumo: `authorizePayment` usa a chave da **session** como chave da **operação** `POST /v1/orders`. Evidência: código, contrato oficial e E2E sandbox (402 → session `pending` com a mesma chave → novo cartão → 409).

### Proposta inicial (histórico; substituída pelo ADR-014)

Registro da proposta feita antes da decisão. **Não é o que foi implementado:** a estratégia adotada deriva a chave do body canônico inteiro, e a chave derivada não é gravada. Ver "Correção e regressão" abaixo.


- **Ponto de correção:** só `authorizePayment` (cartão). Derivar a chave da operação, sem substituir a base: `sha256("<mercadopago_idempotency_key>:card:<sha256(card_token)>")`. É o mesmo padrão do Pix (invariante 11).
  - Mesmo token → mesma chave: retry seguro (A, B').
  - Token novo → chave nova: nova tentativa (B).
  - `mercadopago_idempotency_key` continua sendo a base, e a chave derivada é gravada em um campo próprio (por exemplo `mercadopago_card_idempotency_key`).
- **Alternativa:** derivar do hash canônico do body inteiro. É mais fiel ao contrato ("mesma chave ⇔ mesmo body") e cobre mudança de parcelas ou de payer sem token novo. Na prática o Brick gera um token novo a cada `onSubmit`, então o token basta.
- **Impactos:**
  - **Cartão:** destrava a nova tentativa na mesma session.
  - **Retries:** continuam idempotentes.
  - **Pix:** nenhum, porque usa outra chave.
  - **Sessions antigas:** compatíveis, porque a base continua em `data`.
- **Risco a registrar:** hoje, depois de um timeout ambíguo em que o Mercado Pago chegou a cobrar, um novo cartão recebe `409`, o que por acaso evita uma segunda cobrança. Com a correção, um novo cartão cria uma nova Order. A primeira, paga e sem session, recebe `503` no webhook (invariante 20) e fica órfã.
- **Testes unitários necessários:**
  - mesmo token → mesma chave;
  - token novo → chave nova;
  - a base não muda;
  - erro do SDK propagado sem gravar nada;
  - Pix inalterado.

## Correção e regressão (2026-09-29)

Decisão: [ADR-014](../decisions/ADR-014-card-order-idempotency-key-from-body.md). Foi adotada a estratégia do hash do body canônico, e não a do token (comparação no ADR). Mudou só `authorizePayment` (cartão), com a derivação centralizada em `getCardOrderIdempotencyKey` + `canonicalJson`. A chave base continua em `data`.

**Testes unitários:** 14 novos em `service.unit.spec.ts`:
- mesmo body → mesma chave;
- fórmula exata da chave;
- a base é preservada e nunca enviada como chave;
- token novo → chave nova;
- parcelas, payer, tipo ou valor diferentes → chave nova;
- a ordem de chaves do `jsonb` não altera a chave;
- outra session → chave nova;
- 402 e 409 propagados, sem nada para gravar;
- retry depois de falha → mesma chave e mesmo body;
- Pix com a chave anterior.

Uma mutação que volta a enviar a chave base derruba 7 dos 14 testes. O reembolso continua coberto pelos testes `RF` (chave = `refund.id`).

Backend: 18 suítes, 350 testes; `tsc` limpo; lint com 0 erros e os mesmos 2 warnings.

**E2E de regressão [sandbox 2026-09-29]:** mesmo método do E2E acima, com o código corrigido.

| Passo | Session | Chave (prefixo) | Body (hash) | HTTP | Resultado |
|---|---|---|---|---|---|
| A: Visa `OTHE` | `payses_01M3QV409ZPE58EH9GK1M1QYBE` | `5356f182c9cf0f42` | `5b451f849d3fde29` | 402 | `rejected_by_issuer`, payment `PAY01M3QV48RDN7Z1V61E6DAHS7E2`; session `pending`, nada gravado |
| Retry: mesmo request (Place order de novo) | a mesma | `5356f182c9cf0f42` | `5b451f849d3fde29` | 402 | **mesmo** payment `PAY01M3QV48RDN7Z1V61E6DAHS7E2`: resultado original devolvido, sem nova operação |
| B: Visa `APRO`, token novo, mesma session | a mesma | `f6cc3355ab9d318a` | `c5ad51b025695ec4` | **201** | Order `ORDTST01M3QV4DR1NTR0FW912SPCYVNC` `processed/accredited` (confirmada por `GET`), `external_reference` = cart |

Estado final:
- session `authorized`, `mercadopago_idempotency_key` = `payses_01M3QV409ZPE58EH9GK1M1QYBE` (base preservada);
- 1 Payment `pay_01M3QV48FENN5VGBM102Q7B2HG`, capturado, com 1 Capture;
- collection `completed`;
- cart `cart_01M3QV3WZ32ZDPD0QKE4T0CPA7` concluído, pedido Medusa `order_01M3QV46MG12TSSQCYWSP3RS5F`.

Nenhum 409 e nenhuma cobrança duplicada: 3 chamadas, 1 Order aprovada.

**Limitação do sandbox:** o cartão Mastercard de teste oficial do MLB com `APRO`, tokenizado por `POST /v1/card_tokens` com o access token, recebeu `422 unprocessable_content`:
- como segunda tentativa, na mesma session (cart `cart_01M3QV1E9W4S0TVW25YDV8XMN4`, com chave nova e sem 409);
- **e também como primeira tentativa num cart novo** (controle, cart `cart_01M3QV30A74ZZ2798WQCH7XKD8`).

O 422 não depende da correção nem da recusa anterior. A causa não foi investigada: Visa aprova, como nos E2E #79, #80 e #85. Os carts e sessions desses dois testes ficaram abertos, como dados de sandbox.

**Timeout ambíguo:** não reproduzido, porque o ambiente não controla a perda da resposta. A chave garante a idempotência da **mesma** operação, não a reconciliação de uma operação cujo resultado externo é desconhecido. Não há mecanismo automático de reconciliação. O risco de segunda cobrança com um cartão novo depois de um timeout está registrado no ADR-014 como limitação conhecida.

**Regressão do caminho Pix [sandbox 2026-09-29], pedido #111.** Objetivo: mostrar que a nova chave do cartão não alterou o Pix. Mesmo mecanismo do E2E acima, com as rotas reais de update e de prepare do Pix e o código corrigido carregado.

- Cart `cart_01M3QWA4G7HA8Y3228T6TBRF5Q` (R$ 110,00), session `payses_01M3QWA7ZX58P5NC4MZFEWEZ1Y`, nome de cobrança `APRO`.
- **Criação:** prepare → `POST /v1/orders` **201**, Order `ORDTST01M3QWAFJW88H4M204ER2PQYVN` `action_required/waiting_transfer`, com QR.
- **Chave do Pix inalterada:** a chave enviada e a gravada em `mercadopago_pix_idempotency_key` são iguais a `sha256("<base>:pix:110.00:0")`, a fórmula anterior (invariante 11). A base continua sendo o ID da session.
- **Isolamento:** um contador instalado na instância do provider registrou **0** chamadas a `getCardOrderIdempotencyKey` durante todo o fluxo. No código, `authorizePayment` desvia para `authorizePix` antes de montar o body do cartão.
- **Pagamento:** `processed/accredited` cerca de 4 s depois da criação (confirmado por `GET /v1/orders/{id}`).
- **Conclusão do cart:** pelo Place order (`completeCartWorkflow` → `authorizePix` → `GET` da Order existente, sem nova criação).
  - Session `authorized`, 1 Payment `pay_01M3QWNCPQ1FD8D35RPXK204N2` capturado, 1 Capture, collection `completed`.
  - Pedido Medusa #111 (`order_01M3QWNBS824Q9KSBQWN1XBXMV`).
- **Sem duplicação:** 1 `POST /v1/orders` no fluxo inteiro, 1 Order, 1 Payment, 1 Capture, 1 pedido.
- **Webhook desta execução: não observado.** O cart não foi concluído pelo webhook em 6 min, e não havia evidência de túnel ativo nem de URL de entrega configurada no ambiente. O `notifications_history` do MCP não listou essa Order. É uma **limitação do ambiente**, não uma falha demonstrada da implementação: a mudança não toca no webhook, na correlação nem na chave do Pix, e o fluxo pelo webhook já foi validado de ponta a ponta no #92 ([E2E-B-2026-09-29](E2E-B-2026-09-29.md)).

**Fora do escopo:** `cancelPayment` (cartão) continua usando a chave base (H3, [não validado]). É um achado separado, sem investigação aberta nesta etapa.
