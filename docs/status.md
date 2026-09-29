# Status do projeto

> Status: vigente · Última verificação: 2026-09-29 · Commit: `6e4579b` · Branch: `rebuild/mercadopago-pix-storefront`

Retrato atual. Atualizar ao fim de cada etapa relevante. Histórico fica no Git, não aqui. Marcadores de origem: [README.md](README.md#convenções).

**Próxima sessão começa por:** registrar o hash do commit da correção do cancelamento (INV-005/ADR-012 e [INV-006](investigations/INV-006-payment-collection-rollback.md)/[ADR-013](decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)) nos cabeçalhos que ainda dizem "não commitado"; decidir o commit da consolidação do webhook (`mercadopago/webhook.md` e o item 3 de Alta) e da linha de status do ADR-011, que ficaram fora desse commit.

Legenda: ✅ comprovado · ⚠ pendente ou comprovado só antes do hardening · 🔍 investigação aberta · 🛠 dívida técnica · ❌ não existe · — sem registro

## Git

- Branch atual `rebuild/mercadopago-pix-storefront`. Este status cobre as alterações até o commit `6e4579b`. Commits posteriores só de documentação ficam registrados no histórico do Git (`git log main..HEAD`). Commits relevantes sobre a `main`: `81f5caf` Pix backend, `c41d686` Pix Review/storefront, `0326748` endurecimento do webhook Pix, `3a56150` correção da INV-001, `01991a0` documentação do E2E do webhook, `c6beff1` redação do `data` do Mercado Pago na Store API, `1749309` resposta mínima de `orders/:id/pix`, `780b740` prazo explícito do Pix, `87587f6` `carts/:id/pix` fechado após a conclusão, `86b8ed0` módulo `paymentAccess`, `93abe1f` emissão/revogação da capability, `d5a4b23` leitura por capability, `9884ba5` cookie no storefront, `4de8ace` confirmação por capability, `f2ceb7c` correção do `next dev`, `6b92141` remoção de `orders/:id/pix`, `536d00e` limpeza de capabilities, `5ccd353` janela de pagamento na Review, `6e4579b` status real na capability. O Pix não está na `main`.
- Existe a branch local `recovery/base-81f5caf`, que aponta para `81f5caf`.

## Matriz de evidências

"Teste unitário" = specs do backend (157 testes passando em 2026-09-27, com a correção do ADR-006). "E2E real" = checkout real em sandbox; os números são pedidos Medusa. O E2E Pix #75–#78 foi executado **antes** do hardening do webhook (`0326748`) [decisão humana 2026-09-27]; #79 em diante, depois.

| Área | Implementado | Teste unitário | E2E real | Estado |
|---|---|---|---|---|
| Pix preparado na Review | ✅ | ✅ | ✅ | Validado |
| QR / copia e cola | ✅ | ✅ | ✅ | Validado |
| A — Pix pendente → Place order | ✅ | ✅ | ✅ #75, #78 (antes); #81, #82, #84, #86 (depois) | Validado |
| B — Place order → webhook depois | ✅ | ✅ | ✅ #76 (antes); ⚠ depois: NÃO REPRODUZIDO em 2026-09-29 ([E2E-B](investigations/E2E-B-2026-09-29.md)): aprovação em ~3,5 s, cart concluído pelo webhook antes do Place order | Validado só antes do hardening |
| B' — webhook (pago) → usuário na Review → Place order | ✅ | ✅ | ✅ #91 (2026-09-29, [E2E-B-PRIME](investigations/E2E-B-PRIME-2026-09-29.md)) | Validado (CONFIRMADO) |
| C — Pix pago → webhook → aba fechada, sem Place order | ✅ | parcial¹ | ✅ #77 (antes); ✅ #83 (depois, webhook real) | Validado |
| Bloqueio do Place order (Pix) | ✅ | ❌ storefront sem testes | ✅ | Validado em E2E |
| Webhook: assinatura, `GET /v1/orders`, correlação exata | ✅ | ✅ | ✅ webhooks reais de 2026-09-27 | Validado depois do hardening |
| Webhook: notificação duplicada/tardia de cart já completo | ✅ | ✅ | ✅ #80 | Validado |
| Webhook: Order paga de outra cobrança não atinge a session | ✅ | ✅ | ✅ teste negativo com Order sandbox `APRO` | Validado |
| Cartão (crédito) | ✅ `payment_type_id = credit_card` | parcial² | ✅ #79 (antes), #80 (regressão após a correção) | Validado (2026-09-27) |
| Cartão (débito) | ✅ `payment_type_id = debit_card` → `type: debit_card` (ADR-005) | ✅ | ⚠ inviável no sandbox: o único débito de teste oficial é classificado como `prepaid_card` | Corrigido; E2E de débito não validável no sandbox atual |
| `refundPayment` | ✅ corrigido sobre `fb5d9a0`, não commitado ([INV-004](investigations/INV-004-refund-payment-amount-and-idempotency.md), [ADR-011](decisions/ADR-011-mercadopago-refund-contract.md)) | ✅ `RF` | ✅ sandbox 2026-09-29: total cartão #85, parcial cartão #80, total Pix #92, dois parciais Pix #91 | Validado no sandbox |
| `cancelPayment` | existe no código | ❌ | — | Não validado |
| `retrievePayment` | existe no código | ❌ | — | Não validado |
| `getPaymentStatus` | existe no código | ❌ | — | Não validado |

¹ Os testes cobrem a emissão do evento pelo webhook para a session correta. Completar o carrinho sem o navegador é do core do Medusa e só está coberto pelo E2E.
² `authorizePayment` no caminho de cartão tem testes; `initiatePayment` e a integração com o Brick, não.

## Evidência E2E

### Pix

Fonte: execução real relatada pelo responsável, antes de `0326748` [decisão humana 2026-09-27].

```text
A  — Pix pendente → Place order                          ✅ #75  ✅ #78
     cobrança Pix existente reutilizada; nenhuma segunda cobrança; Order Medusa criada
B  — Place order → webhook depois                        ✅ #76
B' — webhook (pago) → permanece na Review → Place order  ⚠ não validado isoladamente
C  — Pix pago → webhook → cliente fecha a aba            ✅ #77
     sem clicar Place order; o Medusa criou a Order
Bloqueio do Place order
     bloqueado com a cobrança em processing              ✅
     habilitado com a cobrança pending + QR disponível   ✅
```

**B' é diferente de C.** Nesse registro (antes do hardening) B' não foi validado isoladamente. O primeiro E2E isolado de B' é o de 2026-09-29 ([abaixo](#e2e-b-depois-do-adr-010-2026-09-29-a4aae37--adr-010-não-commitado)).

### Webhook real depois do hardening (2026-09-27, código `3a56150`)

Fonte: notificações reais do Mercado Pago (sandbox, `live_mode=false`) observadas no inspetor do túnel e no log do backend, `GET /v1/orders/{id}` com o access token de teste e consultas read-only [banco 2026-09-27]. Todas as notificações tinham `x-signature` e `type=order`, e nenhuma recebeu 401.

```text
C  — cart de 2026-09-25, Pix já pago, completado só pelo webhook         ✅ #83
     notificação  order.processed · data.id = Order MP do cart · x-request-id cb2fc86b-…
     Order MP     processed/accredited · payment processed/accredited · pix/bank_transfer · R$ 135,00
                  external_reference = cart_01M3BHMWYZ1S8CGGJ6B6W5XX07
     session      payses_01M3BHNCDYHRY1CY983X68Q5M4 — única session do cart; mercadopago_order_id == data.id
                  pending → authorized
     Payment      pay_01M3HQ06QS1KKVEFJ1BSB62XS8 · R$ 135 · capture capt_01M3HQ06THK5SVJ1PDZ070VHWE
     Order Medusa order_01M3HQ07RP9GWZ9B9TS40Q2MEX (#83) · cart completed_at 15:16:11Z
     sem chamada a /store/carts/:id/complete para esse cart; Payments 32 → 33 (só este)
     O pagamento foi feito em 2026-09-25 08:14Z; a notificação só chegou em 2026-09-27 (túnel fora do ar no intervalo).

Duplicada/tardia — order.processed da Order MP da #80 (cartão), cart já completo   ✅
     200 · session exata encontrada · evento processado · nenhum Payment, Capture ou Order novos

Negativa — Order MP "A" criada via API no sandbox (payer.first_name APRO), mesmo
     external_reference e valor de um cart aberto cuja session guarda a Order "B"   ✅
     order.action_required → 200 "not held by any payment session", sem processar
     order.processed       → 503 "paid order … has no payment session holding it" (MP reenvia)
     session/cart/payment collection do cart idênticos antes e depois; nenhum Payment novo

Criação de Pix (order.action_required) × 4 carts novos                           ✅
     200 · session exata · session continua pending · cart não completado
```

As Orders Mercado Pago das #81, #82 e #84 (cenário A) nunca foram pagas: antes do ADR-010, o Pix criado pelo checkout não era aprovável no sandbox ([testing.md](mercadopago/testing.md#pix-no-sandbox)). A Order "A" do teste negativo é uma cobrança sandbox paga e sem session, criada de propósito.

### Aprovação de Pix no sandbox (INV-003, 2026-09-29, código `a4aae37`)

Fonte: [INV-003](investigations/INV-003-pix-sandbox-approval.md). Uma única Order criada direto na Orders API sandbox, sem nada no Medusa e sem escrita no banco. Nenhum arquivo do projeto foi alterado.

```text
corpo real do createPixOrder + payer.first_name "APRO"   → HTTP 201, external_reference preservado   ✅
action_required/waiting_transfer → processed/accredited   automático, ≤ ~3,8 s (timestamps do Mercado Pago)   ✅
webhook da aprovação                                      backend/túnel desligados                    ⚠ não comprovado
```

A Order de teste (`ORDTST01M3PGG6E3JDZAMFAHE2ZNN0GV`) está paga e não pertence a nenhum cart. Se uma notificação dela chegar a um backend ligado, a resposta esperada é 503, e o Mercado Pago tende a reenviar (invariante 20). ⚠ Nenhuma notificação dela chegou em ~45 min com o túnel ligado, nos E2E B' e B: **não comprovado** ([E2E-B-2026-09-29](investigations/E2E-B-2026-09-29.md#order-órfã-da-inv-003)). O 503 continua não comprovado para ela.

### E2E B' depois do ADR-010 (2026-09-29, `a4aae37` + ADR-010 não commitado)

Fonte e evidências completas: [E2E-B-PRIME-2026-09-29](investigations/E2E-B-PRIME-2026-09-29.md). Resultado: **CONFIRMADO**, 15 de 15 critérios. A primeira classificação foi PARCIAL, porque o critério 11 original ("session `captured`") estava errado; ele foi substituído [decisão humana 2026-09-29]. Session `authorized` com Payment capturado é o comportamento do Medusa 2.20.1 ([webhook.md](mercadopago/webhook.md#processamento-no-provider)).

```text
billing APRO → session.data.payer (first_name/last_name) → prepare → Order MP     ✅  cart_01M3PPM9VWY5ZM7BVNXHBW9HTK
Order MP action_required/waiting_transfer → processed/accredited (~93 s)         ✅  ORDTST01M3PPT9WBAF8EGKDS7P6GHEWN
order.action_required · order.processed — x-signature, HMAC, correlação exata, 200   ✅  sem retry
session pending → authorized · 1 Payment capturado · 1 Capture · collection completed   ✅  [banco 2026-09-29]
webhook concluiu o cart → pedido #91; Place order depois: 200, nada novo criado   ✅
Review "Payment approved" sem QR · confirmação "We received your Pix payment"     ✅  [decisão humana 2026-09-29]
```

Observação, não bug: o tempo de aprovação com `APRO` variou (~3,8 s na INV-003, ~93 s aqui, ~3,5 s no [E2E B](investigations/E2E-B-2026-09-29.md#tempo-de-aprovação-com-apro)); a causa não foi determinada.

### E2E B depois do ADR-010 (2026-09-29): NÃO REPRODUZIDO

Fonte: [E2E-B-2026-09-29](investigations/E2E-B-2026-09-29.md).

```text
billing APRO → session.data.payer → prepare → Order MP action_required           ✅  cart_01M3PS2ZAWVZYQ423NTNMV2RJE
Order MP → processed/accredited em ~3,5 s                                        ✅  ORDTST01M3PS7RD34MPPRDQ0TQBZ7RFV
order.action_required · order.processed — x-signature, correlação exata, 200     ✅  sem retry
webhook concluiu o cart → pedido #92 antes de qualquer Place order               ✅  sem POST /complete
session authorized · 1 Payment captured_at · 1 Capture · collection completed    ✅  [banco 2026-09-29]
Place order com a Order ainda pendente (B)                                       —   não reproduzido
```

### Cartão

Executado em 2026-09-27, com evidências completas na [INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md#5-evidência-e2e-sandbox-2026-09-27).

```text
Crédito (Visa)  — Brick → session → authorizePayment (type credit_card) → MP processed/accredited → Order #79   ✅
Débito          — o cartão oficial "Elo Débito" é classificado como prepaid_card e o Brick o recusa antes do onSubmit   ❌
                  Orders API: debelo + credit_card → 400 (validação de esquema); debelo + debit_card → 400 not_allowed_for_collector
```

Runtime do Brick: `paymentType`, `selectedPaymentMethod` e `additionalData.paymentTypeId` = `"credit_card"` (snake_case; os tipos do `sdk-react` 1.0.7 dizem `'creditCard'`).

### Regressão depois do ADR-006 (2026-09-27)

```text
Cartão (guest, crédito) — Brick → session → Place order → authorizePayment → Order #85   ✅
     session authorized · credit_card/visa · Payment capturado · webhook 200
     card_token e payer continuam em session.data e payment.data [banco 2026-09-27]
     GET /store/carts/:id desse cart → data: { payment_method_id }
Pix (guest) — Review detecta Pix e mostra o QR                                   ✅
     cart_01M3HSEWDKY0BJV5P2TPFHQ3CG · QR exibido na tela [decisão humana 2026-09-27]
     log: POST .../payment-sessions/:id/pix (prepare) e polling GET /store/mercadopago/carts/:id/pix,
          só chamados pelo PixPaymentPanel, que a Review só mostra com data.payment_method_id === "pix"
     session pending, payment_method_id pix; payer e QR continuam em session.data [banco 2026-09-27]
     GET /store/carts/:id → data: { payment_method_id } · DTO Pix do cart com QR/ticket/status
Pix — Place order depois da correção (cenário A)                                 ✅ #86
     mesmo cart: item removido → session apagada e cobrança Pix cancelada (deletePayment) →
     webhook order.canceled 200 "not held" → nova session Pix → nova cobrança → Place order
     session pending_authorization com a cobrança nova; 0 Payments; página do pedido leu o DTO Pix
```

## Comportamentos validados

- **Pix em `pending_authorization` é suportado pelo fluxo do Medusa 2.20.1.** O `complete-cart` e o `authorize-payment-session` do `@medusajs/core-flows` 2.20.1 instalado tratam esse status. Na prática, o cenário A mostrou o pedido sendo criado com o Pix pendente.
- **Pagamento assíncrono completa o carrinho sem o navegador**, pelo mecanismo nativo `processPaymentWorkflow` → `completeCartAfterPaymentStep` → `completeCartWorkflow`. Os três existem no `@medusajs/core-flows` 2.20.1 instalado, e o cenário C comprovou o fluxo de ponta a ponta.
- **Hardening do webhook** (`0326748`): a correlação passou a ser `data.id` → `GET /v1/orders/{data.id}` → `mercadopago_order_id` → Payment Session exata → cart → evento → `processPaymentWorkflow`. ✅ Correlação validada por teste unitário. ✅ Correlação validada por webhook real (2026-09-27, [evidência](#webhook-real-depois-do-hardening-2026-09-27-código-3a56150)).
- Migração de identidade do provider concluída [banco 2026-09-25] (resultado em [runbooks/provider-id-migration.md](runbooks/provider-id-migration.md)).
- Em 2026-09-27, no commit `3a56150`: 141 testes unitários passando (6 suítes); `tsc --noEmit` limpo no backend e no storefront; `medusa build` e `next build` passando.
- Em 2026-09-27, com a correção do ADR-006: 157 testes (7 suítes), `tsc` nos dois apps, `medusa build`, `next build` e `git diff --check` passando. O lint do backend mostra os mesmos 2 warnings de antes.
- Lint, executado pela primeira vez em 2026-09-27, sem baseline anterior: no backend, 0 erros e 2 warnings (`updatePaymentSession` chamado direto em rota; ver dívida "lógica fora de workflows"); no storefront, 12 erros e 3 warnings, todos em código que não foi alterado nesta etapa (`no-explicit-any`, `no-unused-vars`, `ban-ts-comment`, `exhaustive-deps`). Não corrigidos.

## Pendências funcionais (por prioridade)

Nenhuma delas deve virar alteração de código sem passar pelo fluxo de investigação ([investigations/README.md](investigations/README.md)).

### Alta

1. **[INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md)**: débito enviado como `credit_card`.
   - ✅ causa confirmada;
   - ✅ correção implementada, [ADR-005](decisions/ADR-005-card-payment-type-from-brick.md), commit `3a56150`;
   - ✅ crédito validado, com regressão E2E #80;
   - ⚠ débito não validável no sandbox atual.
   - Sessions de cartão antigas, sem `payment_type_id`, são recusadas com erro controlado e exigem novo preenchimento.
2. ✅ ~~E2E real de cartão~~: crédito validado (#79); débito coberto pela INV-001.
3. ✅ ~~E2E real do webhook depois do hardening~~: correlação, duplicidade, caso negativo e cenário C validados (#83). ⚠ Depois do hardening, B' foi confirmado e **B** não foi reproduzido (abaixo); B continua pendente. Os dois precisam de um Pix criado pelo checkout e pago no sandbox, o que o ADR-010 tornou possível ([testing.md](mercadopago/testing.md#pix-no-sandbox)).
   - ✅ Causa confirmada pela [INV-003](investigations/INV-003-pix-sandbox-approval.md) (concluída em 2026-09-29): o sandbox aprova automaticamente com `payer.first_name = "APRO"`, e o checkout não envia esse campo.
   - ✅ [ADR-010](decisions/ADR-010-pix-payer-name-from-billing-address.md) implementado em 2026-09-29 e commitado em `fb5d9a0` [commit `fb5d9a0`]. Para sessions Pix, o `payer` passa a levar `first_name`/`last_name` do `billing_address` do cart, lidos no servidor pela rota de update e persistidos em `session.data.payer` (invariantes 40 e 41). Mudou só `payment-sessions/[id]/route.ts`. Backend: 12 suítes, 263 testes, `tsc` limpo, lint com 0 erros e os mesmos 2 warnings.
   - ✅ E2E B' executado em 2026-09-29, resultado **CONFIRMADO** ([E2E-B-PRIME-2026-09-29](investigations/E2E-B-PRIME-2026-09-29.md)). Comprovado:
     - o nome de cobrança chegou a `session.data.payer`;
     - o webhook `order.processed` real chegou, com correlação exata e 200;
     - session `authorized` (estado esperado), exatamente 1 Payment com `captured_at`, 1 Capture e collection `completed`;
     - a Review e a confirmação mostraram "Payment approved".
   - ⚠ Pendente: cenário **B**. NÃO REPRODUZIDO em 2026-09-29 ([E2E-B-2026-09-29](investigations/E2E-B-2026-09-29.md)): a aprovação em ~3,5 s não deu tempo de clicar Place order antes dela. Só é viável pelo navegador com uma aprovação lenta do sandbox, que não é controlável.
   - ⚠ Pendente: webhook da Order órfã da INV-003. **Não comprovado**: nenhuma notificação observada em ~45 min, e o `notifications_history` do MCP não serve como evidência.
   - Observação, não bug: o tempo de aprovação com `APRO` varia (~3,8 s, ~93 s, ~3,5 s); a causa não foi determinada.

### Média

- ✅ **Cancelar pedido Medusa com Pix pendente** ([INV-005](investigations/INV-005-cancel-order-with-pending-pix.md), concluída; [ADR-012](decisions/ADR-012-cancel-pending-pix-on-order-cancel.md); correção sobre `0821822`, não commitada).
  - Reprodução (#93, 2026-09-29): `cancelOrderWorkflow` cancelou pedido e collection sem chamar o Mercado Pago; a Order MP continuou `action_required/waiting_transfer`, e a confirmação continuou entregando QR para o pedido cancelado.
  - Correção: hook `cancelOrderWorkflow.hooks.orderCanceled` → ação `cancel` do provider → `invalidatePixOrder` (invariante 45). Backend: 15 suítes, 310 testes; `tsc` nos dois apps, `medusa build`, `next build`; lint com os mesmos 2 warnings.
  - E2E sandbox (2026-09-29): #94 Pix pendente → Order MP `canceled`, pedido `canceled`, confirmação `canceled` sem QR ✅; #95 Pix pago antes do webhook → cancelamento recusado e revertido, pedido `pending` ✅; #96 Payment capturado → reembolso pelo core, hook sem ação ✅.
  - ⚠ Compensação do core 2.20.1: a compensation de `updatePaymentCollectionStep` falha (snapshot só com `{ id, status }`; `amount`/`currency_code` `undefined` recusados pelo MikroORM), o workflow termina `FAILED`, o pedido volta a `pending` e a payment collection fica `canceled`. No #95 (Pix pago) o primeiro evento de pagamento recalculou a collection. Investigação: [INV-006](investigations/INV-006-payment-collection-rollback.md). O defeito do core não foi corrigido; a rota do Admin deixou de chegar a ele no caso do Pix ([ADR-013](decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)).
- ✅ **[INV-006](investigations/INV-006-payment-collection-rollback.md): rollback do `cancelOrderWorkflow` deixava a collection `canceled`** (concluída; [ADR-013](decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md); correção sobre `0821822`, não commitada).
  - Reprodução com Pix não pago (#97, falha controlada no `GET` da Order MP): workflow `failed`, erro de `invoke` no hook e de `compensate` em `update-payment-collection`; pedido `pending`; collection `awaiting` → `canceled`; `payment_status: canceled`; Pix ainda pagável [banco 2026-09-29]. `order.canceled` é descartado no rollback.
  - Correção: `POST /admin/orders/:id/cancel` (rota sobrescrita) executa `cancel-order-with-pending-pix`: `cancelValidateOrder` → step `cancel-pending-pix-charge` (mesma ação `cancel` do provider) → `cancelOrderWorkflow.runAsStep`. O hook fica como rede de segurança (invariantes 45 e 46).
  - Backend: 18 suítes, 336 testes; `tsc` nos dois apps; `medusa build` e `next build`; lint do backend com 0 erros e os mesmos 2 warnings.
  - E2E sandbox pela rota real (2026-09-29):
    - #98 Pix pendente → tudo `canceled`, Pix cancelado antes do core ✅;
    - #99 Pix pago antes do webhook → 400, core não executado, collection `awaiting` ✅;
    - #100 `GET` 403 → 500, collection `awaiting`, `payment_status: awaiting` ✅, e nova tentativa concluída ✅;
    - #101 cartão capturado → só o reembolso do core ✅.
    - Nenhuma chamada duplicada ao Mercado Pago.
  - #97 e #99 deixados como estão (dados de teste).

4. ✅ **`GET /store/mercadopago/orders/:id/pix`: resposta reduzida ao mínimo; depois substituída pela capability e removida ([ADR-007](decisions/ADR-007-payment-access-capability-for-pix.md))** (commit `fix(api): minimize Mercado Pago Pix order response`; invariante 14).
   - `:id` é o **ID da Order Medusa** (não o da Order Mercado Pago). A rota é usada só pela página de confirmação (`PaymentDetails` em `order-completed-template.tsx`), que também atende guest checkout.
   - **Antes:** devolvia `status`, `qr_code`, `qr_code_base64`, `ticket_url` e `expires_at` da primeira session `pp_mercadopago` do pedido, sem checar se era Pix, para quem conhecesse o ID.
   - **Depois:** só `status` e `ticket_url`, e só para uma session Pix; pedido de cartão → 404. A página do pedido trata qualquer resposta não 404 como Pix. Acesso inalterado, conforme a decisão de não exigir autenticação [decisão humana 2026-09-27].
   - ✅ Testes unitários (`OX`, 10 testes; 162 no total), `tsc` nos dois apps. ⚠ Página do pedido não reexecutada em E2E depois da mudança.
5. 🔍 **`PaymentButton` escolhe o botão por `payment_sessions[0]`.** Pergunta: a ordem de `payment_sessions` é garantida pelo Medusa neste fluxo, ou o código assume uma posição arbitrária? Não classificar como bug antes de verificar a garantia do framework.

### Baixa

6. 🔍 **Status desconhecido: cartão × Pix.** No cartão, status desconhecido vira `pending` (`getStatusFromGateway`); no Pix, lança erro (`resolvePixStatus`). É uma inconsistência de comportamento conhecida, **não demonstrada como bug**. Sem correção sugerida.
7. 🔍 **Idempotency key do cartão estável durante a session** (`mercadopago_idempotency_key`, gravada em `initiatePayment`). Pode ser deliberado, para permitir retries do mesmo pagamento. Só vira correção se um teste mostrar conflito real.
8. ✅ **`refundPayment`** ([INV-004](investigations/INV-004-refund-payment-amount-and-idempotency.md), concluída; [ADR-011](decisions/ADR-011-mercadopago-refund-contract.md)).
   - ✅ E1 reproduzido por teste e corrigido: `refund.raw_amount` (`{ value, precision }`) virava `NaN` em `Number()`, e todo reembolso pedido pelo Medusa falhava antes de chamar o Mercado Pago.
   - ✅ E2 reproduzido por teste e corrigido: todos os reembolsos de um Payment usavam a `mercadopago_idempotency_key` da session; agora cada um usa `context.idempotency_key` (`refund.id`).
   - ✅ Total sem body × parcial com `transactions[{ id, amount }]`, conforme a documentação (invariante 44).
   - Backend em 2026-09-29, com a correção: 13 suítes, 285 testes, `tsc` limpo, lint com 0 erros e os mesmos 2 warnings.
   - ✅ E2E sandbox em 2026-09-29, pelo `refundPaymentWorkflow` do core (o mesmo da rota do Admin) via `medusa exec`, sem a camada HTTP/auth do Admin: total sem body (cartão #85, Pix #92), parcial com `transactions` (cartão #80, Pix #91 R$ 30 + R$ 80), key = `refund.id` em todos, HTTP 201, reembolsos `processed` na resposta e ~6 min depois. Guard do Medusa recusou reembolso acima do capturado sem chamar o Mercado Pago. Evidências na INV-004.
   - ⚠ Semântica ambígua, sem bug (auditoria de 2026-09-29): depois do reembolso, `payment.data.mercadopago_payment_status`/`mercadopago_status_detail` continuam `processed/accredited` (a resposta do reembolso não traz `transactions.payments`), enquanto a transação no Mercado Pago passa a `refunded`/`partially_refunded`. Nenhum código, o core, o Admin ou o storefront lê esses campos em `payment.data`; o reembolso está representado por `Refund`, `OrderTransaction`, `refunded_amount` e `mercadopago_order_status`. Sem correção ([INV-004](investigations/INV-004-refund-payment-amount-and-idempotency.md#semântica-de-paymentdata-depois-do-reembolso)).
   - ⚠ Não observado: reembolso em `processing`/`failed`, recusa do Mercado Pago, entrega dos webhooks de reembolso (backend e túnel desligados).
9. ⚠ `cancelPayment` sem testes e sem E2E.
10. ⚠ `retrievePayment` sem testes e sem E2E.
11. ⚠ `getPaymentStatus` sem testes e sem E2E.
12. ⚠ `retrievePayment`/`getPaymentStatus` em um Payment anterior à migração de identidade.
13. ⚠ Mercado Pago disponível no Admin para a região Brasil (no banco, a região aponta para `pp_mercadopago` [banco 2026-09-25]; no Admin, não verificado).

### Segurança

- ✅ **Exposição de `session.data` pela Store API: corrigida ([ADR-006](decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md), invariante 24).**
  - **Antes** (comprovado na API em execução em 2026-09-27, só com a publishable key e o ID, sem login): `GET /store/carts/:id` devolvia `data` inteiro das sessions do Mercado Pago, com `card_token`, `payer` (e-mail e CPF), `issuer_id`, `installments`, idempotency keys, `mercadopago_order_id`/`payment_id`, status internos, QR/ticket e geração Pix. Isso valia também para carts completos. Com `?fields=`, o mesmo saía em `payments[].data` do cart e em `GET /store/orders/:id` de pedido guest.
  - **Depois** (mesma verificação): em todos esses caminhos, inclusive `?fields=` sem `provider_id`, sai só `data: { payment_method_id }`. O armazenamento não mudou (`session.data` e `payment.data` completos [banco 2026-09-27]).
  - ✅ `GET /store/mercadopago/orders/:id/pix` reduzida a `status` + `ticket_url` (pendência 4) e, depois do E2E da capability, removida. Etapa intermediária: a substituição por uma capability temporária está proposta no [ADR-007](decisions/ADR-007-payment-access-capability-for-pix.md).
- 🔍 **`GET /store/orders/:id` do core devolve e-mail e endereços a quem tem o ID do pedido** ([INV-002](investigations/INV-002-store-order-retrieve-without-auth.md)). Verificado no código do `@medusajs/medusa` 2.20.1; não verificado em requisição real.
- ✅ `GET /store/mercadopago/carts/:id/pix` responde 410 sem corpo depois de `completed_at`, e o DTO Pix (também o do prepare) não traz mais `mercadopago_order_id`, `session_status` nem status nativos (invariantes 14 e 26). Validado por testes unitários; ⚠ não reexecutado em E2E.

### Capability de pagamento ([ADR-007](decisions/ADR-007-payment-access-capability-for-pix.md))

Implementação: `780b740`, `87587f6`, `86b8ed0`, `93abe1f`, `d5a4b23`, `9884ba5`, `4de8ace`, `f2ceb7c`.

- ✅ **Migration `Migration20260927120000` aplicada** em 2026-09-27, sozinha (`ModulesSdkUtils.buildMigrationScript` apontado só para a pasta de migrations do `paymentAccess`). Tabela `payment_access_grant` com 14 colunas, PK, `CHECK (purpose = 'pix_payment_view')` e os índices `deleted_at`, `token_hash` (único), `payment_session_id`, `expires_at`; nenhuma outra migration registrada na última hora [banco 2026-09-27].
- ✅ Validação automatizada (código em `f2ceb7c`): backend 12 suítes / 233 testes, `tsc`, `medusa build`; storefront `pnpm test` 6/6, `tsc`; lint nos mesmos números de antes. Não há testes de integração HTTP; os de módulo criam bancos e não foram executados.
- 🐞 **Corrigido durante o E2E** (`f2ceb7c`): o re-export de tipos em `cart.ts` (`"use server"`, `9884ba5`) fazia o `next dev` (Turbopack) responder 500 em todas as páginas; o `next build` aceitava.

#### E2E sandbox (2026-09-27, código em `f2ceb7c`)

Fonte: roteiro HTTP contra o backend e o storefront em execução e a Orders API sandbox (Pix reais criados pelo Mercado Pago), mais consultas read-only [banco 2026-09-27]. **Não houve navegador:** o que depende de UI está separado abaixo.

```text
Guest Pix (pedido #87, order_01M3J8Y4V3DA79QAQ81QCW5HEK)                     38 checks, 37 ✅
  prepare 200 pending com QR/ticket; capability só no header, formato pat_, fora do corpo      ✅
  sem Access-Control-Expose-Headers                                                           ✅
  expiração da capability = deadline (60,0 min) + 15 min                                      ✅
  leitura: pending com QR, order_id null antes da conclusão, no-store/no-referrer, allowlist  ✅
  carts/:id/pix 200 com cart aberto, sem campos internos                                      ✅
  refresh reutiliza a cobrança (mesmo charge_ref) e emite nova capability; 2ª aba válida      ✅
  4ª emissão revoga a mais antiga; #2–#4 válidas (limite de 3)                                ✅
  404 genérico idêntico: sem token, token só na query, token desconhecido, malformado         ✅
  complete com Pix pendente → pedido (cenário A)                                              ✅
  carts/:id/pix → 410 sem corpo; prepare depois da conclusão → 400 sem capability             ✅
  capability depois da conclusão → order_id = pedido criado (consulta reversa real)           ✅
  GET /store/orders/:id → payment_sessions[].data = { payment_method_id: "pix" }              ✅
  confirmação (RSC) com cookie mostra o Pix; sem cookie / cookie inválido → sem dados Pix     ✅
  HTML da confirmação sem o token                                                             ❌ em next dev / ✅ em produção
Pix → cartão (mesma session)                                                                  5 ✅
  capability antiga → 404 genérico; carts/:id/pix → 404
Cliente autenticado (pedido #88)                                                              10 ✅
  cart do cliente, capability, leitura sem campos internos, pedido com Pix pendente,
  order_id resolvido; JWT do cliente sozinho não abre a rota (404)
Deadline (Pix PT1H)                                                                           ver abaixo
Banco: 6 grants, todos token_hash hex de 64, nenhum plaintext; 1 superseded, 1 payment_method_changed
```

- **Token no HTML só em `next dev`:** o debug do React Server Components em desenvolvimento serializa o valor de `cookies()` no payload RSC, com **todos** os cookies HttpOnly (inclusive `_medusa_jwt` de cliente logado), não só a capability. Num build de produção (cópia isolada do storefront, sem `.env`, `next start`), com o cookie `__Host-payment_access` a página mostra o Pix e o HTML não contém o token, o nome do cookie nem IDs do Mercado Pago. Não expor `next dev` publicamente.
- **Deadline** (probe com cart aberto e o pedido #87):
  - 2 min depois da deadline: a capability do probe responde só `{ status: "expired" }`, sem QR, enquanto o Mercado Pago (leitura ao vivo por `carts/:id/pix`) ainda dizia **`pending`**. A deadline local conservadora escondeu o QR antes do Mercado Pago.
  - O pedido #87 (deadline ~5 min antes) já respondia **`canceled`**, só status. O check automatizado esperava `expired` e falhou; o comportamento é o do invariante 34 (status final do Mercado Pago é mantido, sem artefatos).
  - 16 min depois da deadline: o Mercado Pago mostrava **`canceled`** para o probe; as duas capabilities (deadline + 15 min) → 404 genérico.
- **Estados no E2E real:** `pending` ✅; `canceled` ✅ (Pix vencido cancelado pelo Mercado Pago); `expired` só pela deadline local ✅. **`approved` e `failed` não reproduzíveis no sandbox** nesta data (antes do ADR-010, o Pix do checkout não era aprovável: [testing.md](mercadopago/testing.md#pix-no-sandbox)); cobertos só por testes automatizados (`V`, `PAX`). Depois do ADR-010, `approved` foi observado pela capability na confirmação do E2E B' (#91, [E2E-B-PRIME-2026-09-29](investigations/E2E-B-PRIME-2026-09-29.md#ui-decisão-humana-2026-09-29)); `failed` continua não reproduzido.
- Os testes que dependem de navegador estão na seção seguinte (executados depois, com o código em `6e4579b`).

#### E2E no navegador (2026-09-27/28, código em `6e4579b`)

Fonte: Chromium 153 headless controlado por DevTools Protocol (só em 127.0.0.1), contra o storefront em **build de produção** (`next build` + `next start`, cópia isolada sem `.env`), o backend em execução e a Orders API sandbox. Pedido `order_01M3JHS6GK94AHXYRVSMEKG7W7` (guest). O `next dev` não foi usado como evidência. O preenchimento do Payment Brick (iframe do Mercado Pago) foi substituído pelo mesmo payload do `onSubmit` via HTTP; o resto aconteceu no navegador.

```text
A — Review + cookie                                                               11/11 ✅
  painel Pix e modal com copia e cola após o prepare pelo Server Action
  cookie __Host-payment_access criado pelo servidor: HttpOnly, Secure, SameSite=Lax, Path=/, host-only
  token ausente de document.cookie, URL, DOM, corpos de resposta (HTML, RSC, Server Actions) e URLs de requisição
B — cart concluído com a Review aberta                                             5/5 ✅
  cart concluído por outra requisição (Store API), não pelo webhook (Pix do checkout não é pagável no sandbox)
  carts/:id/pix → 410 sem corpo; a Review mostra "already completed", esconde QR/copia e cola e libera "Place order"
C — confirmação                                                                    12/12 ✅
  "Awaiting payment" + modal com QR/copia e cola/ticket (payment_window_closed=false)
  polling pelo Server Action (2 chamadas em 16 s); token/nome do cookie ausentes do DOM e das respostas
  deadline + 2 min: API status=pending, payment_window_closed=true, sem QR/ticket;
                    página "Time to pay this Pix has ended", sem botão de QR
  deadline + 12 min: Mercado Pago canceled → API status=canceled; página "Pix canceled", nada pagável
```

- **Limitação:** `approved` **não** foi reproduzido: um Pix criado pelo checkout não pode ser pago no sandbox ([testing.md](mercadopago/testing.md#pix-no-sandbox)). Continua coberto só por testes automatizados (`V`, `PAX`). Não houve E2E de pagamento aprovado.
- **Limitação:** a passagem para `payment_window_closed=true` foi observada **depois de recarregar** a página, não como transição ao vivo do polling (o polling da página para depois de 180 × 5 s = 15 min, antes da deadline de 1 h).
- ✅ `GET /store/mercadopago/orders/:id/pix` e `retrievePixPayment` removidos depois do E2E (commit `refactor(mercadopago): remove legacy Pix order access`).
- ✅ Limpeza: job diário `cleanup-payment-access-grants` apaga capabilities expiradas ou revogadas há 7 dias ou mais (commit `chore(backend): clean up expired payment access grants`). Testes unitários; filtro conferido read-only no banco (7 grants, 0 elegíveis com 7 dias, 7 com corte em "agora") [banco 2026-09-27]. O job ainda não rodou agendado.
- ✅ `carts/:id/pix` e o prepare deixam de devolver QR/ticket a partir da deadline local, mantendo o status do provider e sinalizando `payment_window_closed` (`5ccd353`, [ADR-008](decisions/ADR-008-pix-payment-window-hides-artifacts.md)). Testes unitários; ⚠ na Review, depois da deadline, não observado no sandbox nem no navegador.
- ✅ A rota da capability mantém o status real do provider e devolve `payment_window_closed`; a confirmação exibe por `status` + janela ([ADR-009](decisions/ADR-009-payment-access-keeps-provider-status.md)). Testes unitários e E2E no navegador (`pending` + janela fechada, `canceled`; `approved` não reproduzível).
- 🔍 Oferecer um novo Pix na confirmação quando a janela fecha sem pagamento: não existe caminho depois da conclusão do cart; exige decisão (ADR-009).
- 🔍 `POST /store/mercadopago/payment-sessions/:id` devolve `payment_session` inteiro, com `data`; `/store/mercadopago/*` não é coberto pelo ADR-006. Pendência separada.

## Dívida técnica

Não bloqueia nenhuma pendência funcional.

- 🛠 **Lógica de pagamento fora de workflows.** Está no provider (`service.ts`) e nas rotas; só a capability de pagamento (ADR-007) usa `src/workflows` e `src/jobs`, e `src/subscribers` está vazio. Contraria o [AGENTS.md](../AGENTS.md). **Não foi decisão deliberada** [decisão humana 2026-09-25].
- 🛠 Sem CI.
- 🛠 Sem testes de integração HTTP.
- 🛠 Storefront só tem o teste da fronteira Pix (`pnpm test`); sem testes de componentes.
- 🛠 `apps/storefront/tsconfig.tsbuildinfo` versionado.
- 🛠 `.env.template` incompleto: no backend falta `AUTH_MFA_ENCRYPTION_KEY` e há variáveis não referenciadas no código do projeto; o storefront não tem `.env.template` (ver [development.md](development.md)).
- 🛠 `@medusajs/eslint-plugin` 2.21.0 × Medusa 2.20.1.
- 🛠 [AGENTS.md](../AGENTS.md) desatualizado ("Medusa latest", "storefront opcional", "package manager não fixo").
- 🛠 Skills desatualizadas: não mencionam o Pix. A `mercadopago-medusa` já aponta para `docs/`.
- 🛠 `.github/agents/medusa-mercadopago.agent.md` desatualizado (não menciona o Pix).
- 🛠 Comentários citam documentos que não existem no repositório: "the audit's D4 finding" (`payment-sessions/[id]/route.ts`) e "see the report" (`service.ts`, `reauthorizePixOrder`).
- 🛠 `"pp_mercadopago"` repetido em 7 arquivos (backend e storefront).
- 🛠 Textos da UI de pagamento em inglês ("Place order", painel Pix).
- 🛠 Pix ainda não mergeado na `main`.
