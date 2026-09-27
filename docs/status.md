# Status do projeto

> Status: vigente · Última verificação: 2026-09-27 · Commit: `f2ceb7c` · Branch: `rebuild/mercadopago-pix-storefront`

Retrato atual. Atualizar ao fim de cada etapa relevante. Histórico fica no Git, não aqui. Marcadores de origem: [README.md](README.md#convenções).

**Próxima sessão começa por:** verificação no navegador do que o E2E HTTP não cobre (seção "Capability de pagamento"). Depois: decidir como validar Pix pago pelo checkout no sandbox (ver [limitação do sandbox](mercadopago/testing.md#pix-no-sandbox)) → cenários B e B' depois do hardening. **Não repetir a auditoria geral do fluxo Pix nem o E2E do webhook:** o que foi comprovado está abaixo.

Legenda: ✅ comprovado · ⚠ pendente ou comprovado só antes do hardening · 🔍 investigação aberta · 🛠 dívida técnica · ❌ não existe · — sem registro

## Git

- Branch atual `rebuild/mercadopago-pix-storefront`. Este status cobre as alterações até o commit `f2ceb7c`. Commits posteriores só de documentação ficam registrados no histórico do Git (`git log main..HEAD`). Commits relevantes sobre a `main`: `81f5caf` Pix backend, `c41d686` Pix Review/storefront, `0326748` endurecimento do webhook Pix, `3a56150` correção da INV-001, `01991a0` documentação do E2E do webhook, `c6beff1` redação do `data` do Mercado Pago na Store API, `1749309` resposta mínima de `orders/:id/pix`, `780b740` prazo explícito do Pix, `87587f6` `carts/:id/pix` fechado após a conclusão, `86b8ed0` módulo `paymentAccess`, `93abe1f` emissão/revogação da capability, `d5a4b23` leitura por capability, `9884ba5` cookie no storefront, `4de8ace` confirmação por capability, `f2ceb7c` correção do `next dev`. O Pix não está na `main`.
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

4. ✅ **`GET /store/mercadopago/orders/:id/pix`: resposta reduzida ao mínimo; depois substituída pela capability e removida ([ADR-007](decisions/ADR-007-payment-access-capability-for-pix.md))** (commit `fix(api): minimize Mercado Pago Pix order response`; invariante 14).
   - `:id` é o **ID da Order Medusa** (não o da Order Mercado Pago). A rota é usada só pela página de confirmação (`PaymentDetails` em `order-completed-template.tsx`), que também atende guest checkout.
   - **Antes:** devolvia `status`, `qr_code`, `qr_code_base64`, `ticket_url` e `expires_at` da primeira session `pp_mercadopago` do pedido, sem checar se era Pix, para quem conhecesse o ID.
   - **Depois:** só `status` e `ticket_url`, e só para uma session Pix; pedido de cartão → 404. A página do pedido trata qualquer resposta não 404 como Pix. Acesso inalterado, conforme a decisão de não exigir autenticação [decisão humana 2026-09-27].
   - ✅ Testes unitários (`OX`, 10 testes; 162 no total), `tsc` nos dois apps. ⚠ Página do pedido não reexecutada em E2E depois da mudança.
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
- **Estados no E2E real:** `pending` ✅; `canceled` ✅ (Pix vencido cancelado pelo Mercado Pago); `expired` só pela deadline local ✅. **`approved` e `failed` não reproduzíveis no sandbox** (Pix do checkout não é aprovável: [testing.md](mercadopago/testing.md#pix-no-sandbox)); cobertos só por testes automatizados (`V`, `PAX`).
- ⚠ **Depende de navegador, não executado:** o Server Action gravar o cookie no browser; a Review reagir ao 410 (esconder a cobrança, liberar "Place order"); a interface da confirmação (modal, polling). Cobertos por `tsc`/lint e pelo teste da fronteira, não por E2E.
- ✅ `GET /store/mercadopago/orders/:id/pix` e `retrievePixPayment` removidos depois do E2E (commit `refactor(mercadopago): remove legacy Pix order access`).
- ✅ Limpeza: job diário `cleanup-payment-access-grants` apaga capabilities expiradas ou revogadas há 7 dias ou mais (commit `chore(backend): clean up expired payment access grants`). Testes unitários; filtro conferido read-only no banco (7 grants, 0 elegíveis com 7 dias, 7 com corte em "agora") [banco 2026-09-27]. O job ainda não rodou agendado.
- ✅ `carts/:id/pix` e o prepare deixam de devolver QR/ticket a partir da deadline local, mantendo o status do provider e sinalizando `payment_window_closed` (`5ccd353`, [ADR-008](decisions/ADR-008-pix-payment-window-hides-artifacts.md)). Testes unitários; ⚠ não reexecutado no sandbox nem no navegador.
- 🔍 A rota da capability ainda converte `pending` em `expired` depois da deadline (ADR-007 decisão 6), enquanto a Review mantém o status real. Divergência registrada no ADR-008; alinhar exige decisão.
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
