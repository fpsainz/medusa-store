# Invariantes do Mercado Pago

> Status: vigente · Última verificação: 2026-09-27 · Commit: `c6beff1`

Regras que o código atual garante e que **não podem ser quebradas** sem uma decisão explícita (novo ADR). Cada regra indica onde é garantida e qual spec a cobre. "Sem teste" significa que a regra está no código, mas nenhum teste a protege.

Specs (caminhos relativos a `apps/backend/src/`):
`S` = `modules/mercadopago/__tests__/service.unit.spec.ts` ·
`W` = `api/hooks/payment/[provider]/__tests__/route.unit.spec.ts` ·
`PS` = `api/store/mercadopago/payment-sessions/[id]/__tests__/route.unit.spec.ts` ·
`PX` = `.../payment-sessions/[id]/pix/__tests__/route.unit.spec.ts` ·
`CX` = `.../carts/[id]/pix/__tests__/route.unit.spec.ts` ·
`R` = `api/utils/__tests__/redact-mercadopago-data.unit.spec.ts` ·
`PA` = `modules/payment-access/__tests__/*.unit.spec.ts` ·
`WB` = `workflows/payment-access/__tests__/pix-access-binding.unit.spec.ts` ·
`J` = `jobs/__tests__/cleanup-payment-access-grants.unit.spec.ts` ·
`PAX` = `api/store/mercadopago/payment-access/pix/__tests__/route.unit.spec.ts` ·
`V` = `modules/mercadopago/__tests__/pix-access-view.unit.spec.ts` ·
`PC` = `modules/mercadopago/__tests__/pix-cancel.unit.spec.ts` ·
`H` = `workflows/hooks/__tests__/order-canceled.unit.spec.ts` ·
`ST` = `workflows/steps/__tests__/cancel-pending-pix-charge.unit.spec.ts` ·
`CW` = `workflows/__tests__/cancel-order-with-pending-pix.unit.spec.ts` ·
`AC` = `api/admin/orders/[id]/cancel/__tests__/route.unit.spec.ts` ·
`RF` = `modules/mercadopago/__tests__/refund.unit.spec.ts`

## Identidade

1. **O token do provider é `pp_mercadopago`.** Não adicionar `id` ao provider em `medusa-config.ts`. — `medusa-config.ts`, `service.ts` (`identifier`). Sem teste que falhe se o `id` for adicionado. [ADR-001](../decisions/ADR-001-provider-identity-pp-mercadopago.md)

## Escrita na Payment Session

2. **O cliente nunca escreve campos `mercadopago_*`, `status`, QR/ticket, expiração nem idempotency keys.** A rota de update aceita só a allowlist de `buildAllowedSessionData`; o `payer` enviado pelo cliente é reduzido a `email` + `identification.{type, number}` (o nome do pagador Pix é acrescentado pelo servidor: invariante 40). — `payment-sessions/[id]/route.ts`. Teste: `PS`.
3. **Toda rota que recebe `payment_session_id` + `cart_id` confere a posse:** a session precisa pertencer ao `payment_collection` do cart informado e ao provider `pp_mercadopago`. — rotas `payment-sessions/[id]` e `payment-sessions/[id]/pix`. Testes: `PS`, `PX`.
4. **Atualizar a session nunca autoriza nem captura.** `updatePayment` e as rotas de update/prepare não chamam `authorizePayment` nem `cart.complete`. — `service.ts`, rotas. Testes: `PS`, `PX`, `S`.
5. **`mercadopago_pix_action` é transitório:** removido no início de `updatePayment`, nunca persistido. A rota de update comum o descarta pela allowlist. Valores: `prepare`/`regenerate` (rota de prepare) e `cancel` (só o step `cancel-pending-pix-charge`, usado pelo workflow `cancel-order-with-pending-pix` e pelo hook `orderCanceled`). — `service.ts`. Testes: `S` (lifecycle Review), `PC`, `ST`.
40. **O nome do pagador do Pix vem somente do `billing_address` do cart, lido no servidor pela rota de update, e só para sessions Pix.** A rota lê `billing_address.first_name`/`last_name` na mesma consulta da verificação de posse e grava em `session.data.payer` apenas valores não vazios (aparados); `first_name`/`last_name` enviados pelo cliente são descartados. Numa session que não é Pix, qualquer nome no `payer` (inclusive herdado de uma seleção Pix anterior) é removido. Sem `payer`, nenhum é criado. — `payment-sessions/[id]/route.ts` (`getBillingName`, `withPayerName`). Teste: `PS`. [ADR-010](../decisions/ADR-010-pix-payer-name-from-billing-address.md)

## Pix

6. **A cobrança Pix é criada na Review, pela rota `prepare`,** não pelo botão "Place order". `authorizePayment` só cria a Order como fallback, quando não há `mercadopago_order_id`. — `preparePixOrder`, `authorizePix`. Teste: `S`. [ADR-003](../decisions/ADR-003-pix-charge-created-at-review.md)
7. **Uma cobrança Pix paga nunca é descartada, substituída nem regenerada.** `invalidatePixOrder` lança `NOT_ALLOWED`, `preparePixOrder` devolve a Order paga como está, a rota `prepare` não chama o provider se a session já está `authorized`, e o storefront só oferece regenerar em `expired`/`canceled`/`failed`/`rejected`. Testes: `S`, `PX`.
8. **Nenhuma Order Pix fica pagável sem uma session:** ao trocar de método (`updatePayment`) ou remover a session (`deletePayment`), a Order pendente é cancelada na Orders API. Teste: `S` (`deletePayment`, lifecycle). O cancelamento do pedido Medusa com o Pix pendente é coberto pelo invariante 45.
9. **Status Pix desconhecido nunca vira `pending`:** `normalizePixStatus` → `unknown`, e `resolvePixStatus` lança `UNEXPECTED_STATE`. Teste: `S`.
10. **O valor da Order Pix precisa bater com o da session** (comparação em 2 casas decimais) para reutilizar (`preparePixOrder`) ou autorizar (`reauthorizePixOrder`, que lança `INVALID_DATA` se divergir). Teste: `S`.
11. **Idempotency key do Pix:** derivada da key base + valor + "geração". Cada substituição incrementa a geração, então uma Order nova nunca reaproveita a key da anterior. Cancelamento usa `sha256(<pix key>:cancel)`. — `getPixIdempotencyKey`, `createPixOrder`, `invalidatePixOrder`. Teste: `S`.
12. **Sinais Pix e não-Pix ao mesmo tempo na session lançam erro** antes de qualquer chamada externa. A ausência de campos de cartão não indica Pix. — `isPixSession`. Teste: `S` (Pix discriminator).
13. **Rotas de leitura do Pix não gravam na session.** A session só muda via webhook, `completeCart` ou a rota `prepare`. — `carts/[id]/pix`, `payment-access/pix`. Testes: `CX`, `PAX`.
25. **Toda cobrança Pix é criada com prazo explícito e deadline conservadora.** `createPixOrder` envia `transactions.payments[].expiration_time: "PT1H"` e grava em `mercadopago_pix_expires_at` a menor entre início da requisição + 1 h, `created_date` + 1 h e qualquer data absoluta válida da resposta; durações e valores inválidos são ignorados. Uma nova tentativa de criação usa o mesmo corpo e a mesma idempotency key. — `createPixOrder`, `computePixDeadline`. Teste: `S`. [ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)
26. **O `cart_id` deixa de ser credencial depois da conclusão:** `GET /store/mercadopago/carts/:id/pix` responde 410 sem corpo quando o cart tem `completed_at`, sem ler a session nem chamar o Mercado Pago. — `carts/[id]/pix/route.ts`. Teste: `CX`. [ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)
39. **Depois da deadline local, a Review não recebe nada pagável, e o status continua o do provider.** A partir de `mercadopago_pix_expires_at`, `toPixPaymentDto` (`carts/:id/pix` e prepare) omite `qr_code`, `qr_code_base64` e `ticket_url` e devolve `payment_window_closed: true`; o `status` não é convertido em `expired`/`canceled`. Sem deadline armazenada, nada muda. — `toPixPaymentDto`. Testes: `S`, `CX`. [ADR-008](../decisions/ADR-008-pix-payment-window-hides-artifacts.md)
41. **O body de `createPixOrder` depende só de `session.data` persistida e de constantes:** mesma idempotency key ⇒ mesmo body. Prepare, nova tentativa depois de falha (nada é gravado quando o provider lança) e o fallback `authorizePix` reconstroem a mesma geração com o mesmo body. A rota de prepare não lê endereço nem monta `payer`: repassa `session.data`. — `createPixOrder`, `getPixIdempotencyKey`, `payment-sessions/[id]/pix/route.ts`. Testes: `S`, `PX`. [ADR-010](../decisions/ADR-010-pix-payer-name-from-billing-address.md)

## Exposição de dados ao storefront

14. **O storefront recebe apenas DTOs** (`toPixPaymentDto`, `toPixAccessDto`): nunca `session.data` completo, payer, identificação ou idempotency keys. `toPixPaymentDto` devolve só `status`, `charge_ref` (hash opaco), QR, copia e cola, ticket e `expires_at`: nunca IDs nem status nativos do Mercado Pago. Não existe rota Pix acessível só com o ID do pedido (a antiga `orders/:id/pix` foi removida). — Testes: `CX`, `V`, `PAX`.
24. **A Store API genérica nunca devolve o `data` do provider Mercado Pago.** Nas respostas de `/store/carts*`, `/store/payment-collections*` e `/store/orders*`, todo `payment_sessions[].data` e `payments[].data` do Mercado Pago, em qualquer profundidade e também com `?fields=`, sai reduzido a `{ payment_method_id }`. Um item sem `provider_id` é reconhecido pelas chaves `mercadopago_*`. O armazenamento não muda, e outros providers não são tocados. — `api/middlewares.ts`, `api/utils/redact-mercadopago-data.ts`. Teste: `R`. [ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md)
15. **Respostas de estado Pix usam `Cache-Control: no-store`.** — rotas `prepare`, `carts/[id]/pix`, `payment-access/pix`. Testes: `PX`, `CX`, `PAX`.

## Capability de pagamento (`paymentAccess`)

27. **A capability é opaca e só o hash é persistido.** Token = `pat_` + 32 bytes aleatórios em base64url, nunca JWT. A tabela guarda só o SHA-256 (`token_hash`). Um valor fora do formato é recusado antes de qualquer consulta. — `modules/payment-access/grants.ts`, `service.ts`. Teste: `PA`. [ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md)
28. **Uma capability só vale para o próprio propósito, sem revogação e antes de `expires_at`;** qualquer falha devolve `null`, sem motivo. — `isGrantUsable`, `findUsableGrant`. Teste: `PA`.
29. **No máximo 3 capabilities Pix ativas por payment session:** cada emissão revoga as mais antigas (`superseded`), e emissões concorrentes convergem para o mesmo conjunto. — `issueGrant`, `selectGrantsToSupersede`, `PIX_PAYMENT_VIEW_POLICY`. Teste: `PA`.
38. **Capabilities só são apagadas depois de 7 dias inutilizáveis:** expiradas ou revogadas há 7 dias ou mais. Uma capability utilizável nunca é apagada (a regra é conferida em código mesmo depois do filtro do banco). O job diário `cleanup-payment-access-grants` apaga em lotes, é idempotente e registra só a quantidade removida. — `isGrantPurgeable`, `purgeExpiredGrants`, `purgeExpiredPaymentAccessWorkflow`, `jobs/cleanup-payment-access-grants.ts`, `PAYMENT_ACCESS_RETENTION_MS`. Testes: `PA`, `J`.
30. **A capability Pix só é emitida pelo prepare, a partir da posse do `cart_id` com o cart aberto.** O workflow relê cart e session e só emite quando: cart existe e não tem `completed_at`; a session pertence ao payment collection do cart, é `pp_mercadopago` e Pix, e já tem cobrança; há `mercadopago_pix_expires_at`; e deadline + 15 min ainda está no futuro. Expira em deadline + 15 min. Não existe rota pública de emissão. — `pix-access-binding.ts`, `issuePixPaymentAccessWorkflow`, `payment-sessions/[id]/pix/route.ts`. Testes: `WB`, `PX`.
31. **O token nunca vai no corpo da resposta:** só nos headers `x-payment-access-token`/`x-payment-access-expires-at`. Falha na emissão não falha o prepare. — `api/utils/pix-payment-access.ts`. Teste: `PX`.
32. **Trocar a session de Pix para outro método revoga as capabilities dela** (`payment_method_changed`). Falha na revogação é registrada e não falha a atualização. — `payment-sessions/[id]/route.ts`, `revokePaymentSessionAccessWorkflow`. Teste: `PS`.
33. **A leitura do Pix por capability não aceita identificadores do cliente.** Token só no header `x-payment-access-token` (valor único), nunca na query string. Session, collection e order vêm da capability e são revalidados: session existe, é `pp_mercadopago`, está na mesma collection, é Pix e tem cobrança. Qualquer falha (token ausente, desconhecido, expirado, revogado, de outro propósito, provider/método diferente, session inexistente ou alterada) → o mesmo 404 `Payment not found.`. — `payment-access/pix/route.ts`. Teste: `PAX`.
34. **Na leitura por capability, `status` é o do provider e a janela vem à parte.** `status` nunca é reescrito pela deadline local; `payment_window_closed` (sempre presente) é `true` depois da deadline ou sem deadline conhecida. Artefatos pagáveis (`qr_code`, `qr_code_base64`, `ticket_url`, `charge_ref`, `expires_at`) só com `status: "pending"` e janela aberta. Nunca `data`, payer, e-mail, CPF, card token, idempotency keys, IDs do Mercado Pago, IDs de session/collection/cart/grant nem o access token. — `toPixAccessDto`. Testes: `V`, `PAX`. [ADR-009](../decisions/ADR-009-payment-access-keeps-provider-status.md)
35. **A leitura por capability usa `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.** — `payment-access/pix/route.ts`. Teste: `PAX`.
36. **O token da capability nunca chega ao browser.** O prepare o recebe em header de resposta e o grava em cookie HttpOnly (`SameSite=Lax`, `Path=/`, `Secure` e prefixo `__Host-` em produção); o Server Action devolve só `toClientPixCharge` (allowlist). A leitura usa `fetch` nativo em módulo `server-only`, com o token em header: o logger de debug do SDK imprime headers de requisição e só oculta `authorization`. — `pix-client.ts`, `cart.ts` (`preparePixPayment`), `cookies.ts`, `payment-access.ts`. Teste: `apps/storefront/src/lib/util/__tests__/pix-client.test.mjs` (só a fronteira pura). E2E 2026-09-27: HTML de produção sem o token; **em `next dev` o payload RSC de debug contém os valores dos cookies**.
37. **A confirmação do pedido nunca usa o `order_id` como credencial para o Pix.** O Pix vem de `readPixPaymentAccess` (capability do cookie); o `order_id` da URL só é comparado com o pedido da capability e nunca é enviado ao backend. Sem capability válida para aquele pedido → nenhum dado Pix. A exibição usa `status` + `payment_window_closed` (ADR-009), nunca `expired` como sinal da deadline. — `orders.ts` (`retrieveOrderPixPayment`), `payment-details/index.tsx`, `order-pix-payment.tsx`. Sem teste automatizado; E2E HTTP 2026-09-27 (com cookie, sem cookie, cookie inválido).

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

47. **Cartão: a idempotency key enviada ao `POST /v1/orders` é uma função determinística da chave base da session e do body da operação.** O mesmo body (retry do SDK ou novo Place order com os mesmos dados) usa sempre a mesma chave; qualquer diferença de body (novo `card_token`, parcelas, payer, tipo, valor) usa outra; a ordem das chaves do `data` persistido não altera a chave. A chave base (`mercadopago_idempotency_key`) continua gravada e nunca é enviada como chave da Order de cartão; a chave derivada não é gravada. — `service.ts` (`authorizePayment`, `getCardOrderIdempotencyKey`). Teste: `S`. [ADR-014](../decisions/ADR-014-card-order-idempotency-key-from-body.md)

## Cancelamento do pedido

45. **Cancelar um pedido Medusa com Pix pendente cancela a Order Pix antes do core, ou não cancela o pedido.** O step `cancel-pending-pix-charge` age só sobre a session `pp_mercadopago` + Pix + `pending_authorization` + `mercadopago_order_id` do pedido (mais de uma → erro), via `updatePaymentSession` com a ação `cancel`: lê a Order MP; paga → `NOT_ALLOWED`; status desconhecido → `UNEXPECTED_STATE`; já não pagável → nada; pendente → `POST /cancel` com `sha256(<pix key>:cancel)`; session termina `canceled`. No workflow `cancel-order-with-pending-pix` ele roda depois de `cancelValidateOrder` e **antes** de `cancelOrderWorkflow`: qualquer erro chega ao chamador sem que o core altere pedido ou payment collection, e o Pix cancelado nunca é "descancelado" se o core falhar depois. Cartão, Pix autorizado (o core reembolsa o Payment) e pedidos sem session seguem só o core. O hook `orderCanceled` chama a mesma função do step (`cancelPendingPixChargeForOrder`) como rede de segurança para chamadas diretas ao `cancelOrderWorkflow` (lá, um erro reverte o cancelamento, mas a collection fica `canceled`: INV-006); depois do wrapper ele não encontra Pix pendente e não chama o Mercado Pago de novo. — `workflows/steps/cancel-pending-pix-charge.ts`, `workflows/cancel-order-with-pending-pix.ts`, `workflows/hooks/order-canceled.ts`, `service.ts` (`cancelPixOrderForOrderCancellation`). Testes: `ST`, `CW`, `H`, `PC`. [ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md), [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)
46. **`POST /admin/orders/:id/cancel` executa o workflow `cancel-order-with-pending-pix`,** não o `cancelOrderWorkflow` direto. A rota do projeto sobrescreve a do core (mesmo caminho e método; o `src/` do projeto é registrado depois), com o mesmo input (`order_id`, `canceled_by = actor_id`), a mesma resposta (`{ order }` com `req.queryConfig.fields`) e sem desligar a autenticação padrão do `/admin`. — `api/admin/orders/[id]/cancel/route.ts`. Teste: `AC`. [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)

## Captura

22. **A captura é automática** (`processing_mode: 'automatic'`); `capturePayment` lança erro de propósito. — `service.ts`. Sem teste. [ADR-002](../decisions/ADR-002-orders-api-automatic-capture.md)

## Reembolso

Decisão: [ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md). Evidências, inclusive o E2E no sandbox de 2026-09-29 (cartão e Pix, total e parcial): [INV-004](../investigations/INV-004-refund-payment-amount-and-idempotency.md).

Semântica em `payment.data` (não é invariante, só registro): `mercadopago_payment_status`/`mercadopago_status_detail` são o status de `transactions.payments[0]` na última resposta do Mercado Pago que trouxe a transação; a resposta do reembolso não a traz, então eles ficam com o valor anterior. O estado do reembolso fica em `Refund`/`OrderTransaction`/`refunded_amount` e em `mercadopago_order_status`/`_detail`, `mercadopago_refund_id` e `mercadopago_refunded_amount`. Nenhum código lê os dois campos em `payment.data`.

42. **O valor do reembolso é o `amount` que o Payment Module envia, convertido como `BigNumberInput`,** nunca com `Number()` e nunca substituído por `data.amount`. Ausente, inválido, zero ou negativo → recusa sem chamar a API. — `refundPayment`, `toPositiveDecimalString`. Teste: `RF`.
43. **Cada reembolso usa `context.idempotency_key` (o `refund.id`) como `X-Idempotency-Key`.** Nunca `mercadopago_idempotency_key` nem `mercadopago_pix_idempotency_key`. Ausente, vazia ou com mais de 128 caracteres → recusa sem chamar a API. — `refundPayment`. Teste: `RF`.
44. **Total × parcial:** valor igual a `payment.data.amount` (2 casas) → `POST /v1/orders/{id}/refund` sem body; qualquer outro valor → `transactions[{ id: mercadopago_payment_id, amount }]`. Sem `data.amount`, nunca é total. Parcial sem `mercadopago_payment_id` ou qualquer reembolso sem `mercadopago_order_id` → recusa sem chamar a API. — `refundPayment`. Teste: `RF`.
