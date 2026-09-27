# Status do projeto

> Status: vigente · Última verificação: 2026-09-27 · Commit: `c6beff1` · Branch: `rebuild/mercadopago-pix-storefront`

Retrato atual. Atualizar ao fim de cada etapa relevante. Histórico fica no Git, não aqui. Marcadores de origem: [README.md](README.md#convenções).

**Próxima sessão começa por:** decidir como validar Pix pago pelo checkout no sandbox (ver [limitação do sandbox](mercadopago/testing.md#pix-no-sandbox)) → cenários B e B' depois do hardening. **Não repetir a auditoria geral do fluxo Pix nem o E2E do webhook:** o que foi comprovado está abaixo.

Legenda: ✅ comprovado · ⚠ pendente ou comprovado só antes do hardening · 🔍 investigação aberta · 🛠 dívida técnica · ❌ não existe · — sem registro

## Git

- Branch atual `rebuild/mercadopago-pix-storefront`, **6 commits à frente da `main`** (`81f5caf` Pix backend, `c41d686` Pix Review/storefront, `0326748` endurecimento do webhook Pix, `3a56150` correção da INV-001, `01991a0` documentação do E2E do webhook, `c6beff1` redação do `data` do Mercado Pago na Store API). O Pix não está na `main`.
- Existe a branch local `recovery/base-81f5caf`, que aponta para `81f5caf`.

## Matriz de evidências

"Teste unitário" = specs do backend (157 testes passando em 2026-09-27, com a correção do ADR-006). "E2E real" = checkout real em sandbox; os números são pedidos Medusa. O E2E Pix #75–#78 foi executado **antes** do hardening do webhook (`0326748`) [decisão humana 2026-09-27]; #79 em diante, depois.

| Área | Implementado | Teste unitário | E2E real | Estado |
|---|---|---|---|---|
| Pix preparado na Review | ✅ | ✅ | ✅ | Validado |
| QR / copia e cola | ✅ | ✅ | ✅ | Validado |
| A — Pix pendente → Place order | ✅ | ✅ | ✅ #75, #78 (antes); #81, #82, #84, #86 (depois) | Validado |
| B — Place order → webhook depois | ✅ | ✅ | ✅ #76 (antes); ⚠ depois: Pix do checkout não é aprovável no sandbox | Validado só antes do hardening |
| B' — webhook (pago) → usuário na Review → Place order | ✅ | ✅ | ⚠ | E2E isolado pendente |
| C — Pix pago → webhook → aba fechada, sem Place order | ✅ | parcial¹ | ✅ #77 (antes); ✅ #83 (depois, webhook real) | Validado |
| Bloqueio do Place order (Pix) | ✅ | ❌ storefront sem testes | ✅ | Validado em E2E |
| Webhook: assinatura, `GET /v1/orders`, correlação exata | ✅ | ✅ | ✅ webhooks reais de 2026-09-27 | Validado depois do hardening |
| Webhook: notificação duplicada/tardia de cart já completo | ✅ | ✅ | ✅ #80 | Validado |
| Webhook: Order paga de outra cobrança não atinge a session | ✅ | ✅ | ✅ teste negativo com Order sandbox `APRO` | Validado |
| Cartão (crédito) | ✅ `payment_type_id = credit_card` | parcial² | ✅ #79 (antes), #80 (regressão após a correção) | Validado (2026-09-27) |
| Cartão (débito) | ✅ `payment_type_id = debit_card` → `type: debit_card` (ADR-005) | ✅ | ⚠ inviável no sandbox: o único débito de teste oficial é classificado como `prepaid_card` | Corrigido; E2E de débito não validável no sandbox atual |
| `refundPayment` | existe no código | ❌ | — | Não validado |
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

**B' é diferente de C** e não deve ser tratado como validado.

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

As Orders Mercado Pago das #81, #82 e #84 (cenário A) nunca foram pagas: o Pix criado pelo checkout não é aprovável no sandbox ([testing.md](mercadopago/testing.md#pix-no-sandbox)). A Order "A" do teste negativo é uma cobrança sandbox paga e sem session, criada de propósito.

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
3. ✅ ~~E2E real do webhook depois do hardening~~: correlação, duplicidade, caso negativo e cenário C validados (#83). ⚠ Continuam pendentes os cenários **B** (depois do hardening) e **B'**, que precisam de um Pix criado pelo checkout e pago no sandbox. Isso não é possível com o código atual ([testing.md](mercadopago/testing.md#pix-no-sandbox)); a saída exige decisão.

### Média

4. 🔍 **`GET /store/mercadopago/orders/:id/pix`: segurança e robustez.**
   - `:id` é o **ID da Order Medusa** (não o da Order Mercado Pago). A rota é usada pela página de confirmação (`PaymentDetails` em `order-completed-template.tsx`), que também atende guest checkout.
   - Hoje ela devolve os dados Pix da primeira session `pp_mercadopago` do pedido, sem checar se é Pix, para quem conhecer o ID.
   - Abordagem pretendida: **reduzir a resposta ao mínimo necessário para a página de confirmação**, em vez de exigir autenticação e quebrar o guest checkout [decisão humana 2026-09-27]. Não implementado.
5. 🔍 **`PaymentButton` escolhe o botão por `payment_sessions[0]`.** Pergunta: a ordem de `payment_sessions` é garantida pelo Medusa neste fluxo, ou o código assume uma posição arbitrária? Não classificar como bug antes de verificar a garantia do framework.

### Baixa

6. 🔍 **Status desconhecido: cartão × Pix.** No cartão, status desconhecido vira `pending` (`getStatusFromGateway`); no Pix, lança erro (`resolvePixStatus`). É uma inconsistência de comportamento conhecida, **não demonstrada como bug**. Sem correção sugerida.
7. 🔍 **Idempotency key do cartão estável durante a session** (`mercadopago_idempotency_key`, gravada em `initiatePayment`). Pode ser deliberado, para permitir retries do mesmo pagamento. Só vira correção se um teste mostrar conflito real.
8. ⚠ `refundPayment` sem testes e sem E2E.
9. ⚠ `cancelPayment` sem testes e sem E2E.
10. ⚠ `retrievePayment` sem testes e sem E2E.
11. ⚠ `getPaymentStatus` sem testes e sem E2E.
12. ⚠ `retrievePayment`/`getPaymentStatus` em um Payment anterior à migração de identidade.
13. ⚠ Mercado Pago disponível no Admin para a região Brasil (no banco, a região aponta para `pp_mercadopago` [banco 2026-09-25]; no Admin, não verificado).

### Segurança

- ✅ **Exposição de `session.data` pela Store API: corrigida ([ADR-006](decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md), invariante 24).**
  - **Antes** (comprovado na API em execução em 2026-09-27, só com a publishable key e o ID, sem login): `GET /store/carts/:id` devolvia `data` inteiro das sessions do Mercado Pago, com `card_token`, `payer` (e-mail e CPF), `issuer_id`, `installments`, idempotency keys, `mercadopago_order_id`/`payment_id`, status internos, QR/ticket e geração Pix. Isso valia também para carts completos. Com `?fields=`, o mesmo saía em `payments[].data` do cart e em `GET /store/orders/:id` de pedido guest.
  - **Depois** (mesma verificação): em todos esses caminhos, inclusive `?fields=` sem `provider_id`, sai só `data: { payment_method_id }`. O armazenamento não mudou (`session.data` e `payment.data` completos [banco 2026-09-27]).
  - 🔍 Continua aberto: `GET /store/mercadopago/orders/:id/pix` (pendência 4).

## Dívida técnica

Não bloqueia nenhuma pendência funcional.

- 🛠 **Lógica de pagamento fora de workflows.** Está toda no provider (`service.ts`, 1144 linhas) e nas rotas; `src/workflows` e `src/subscribers` estão vazios. Contraria o [AGENTS.md](../AGENTS.md). **Não foi decisão deliberada** [decisão humana 2026-09-25].
- 🛠 Sem CI.
- 🛠 Sem testes de integração HTTP.
- 🛠 Sem testes no storefront.
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
