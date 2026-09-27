# Status do projeto

> Status: vigente · Última verificação: 2026-09-27 · Commit: `0326748` + correção da INV-001 não commitada (ADR-005) · Branch: `rebuild/mercadopago-pix-storefront`

Retrato atual. Atualizar ao fim de cada etapa relevante. Histórico fica no Git, não aqui. Marcadores de origem: [README.md](README.md#convenções).

**Próxima sessão começa por:** commit da correção da INV-001 ([ADR-005](decisions/ADR-005-card-payment-type-from-brick.md)) → E2E real do webhook depois do hardening. **Não repetir a auditoria geral do fluxo Pix:** o que foi comprovado está abaixo.

Legenda: ✅ comprovado · ⚠ pendente ou comprovado só antes do hardening · 🔍 investigação aberta · 🛠 dívida técnica · ❌ não existe · — sem registro

## Git

- Branch atual `rebuild/mercadopago-pix-storefront`, **3 commits à frente da `main`** (`81f5caf` Pix backend, `c41d686` Pix Review/storefront, `0326748` endurecimento do webhook Pix). O Pix não está na `main`.
- Existe a branch local `recovery/base-81f5caf`, que aponta para `81f5caf`.

## Matriz de evidências

"Teste unitário" = specs do backend (121 testes passando em 2026-09-25). "E2E real" = checkout real em sandbox; os números são pedidos Medusa. Todo o E2E foi executado **antes** do hardening do webhook (`0326748`) [decisão humana 2026-09-27].

| Área | Implementado | Teste unitário | E2E real | Estado |
|---|---|---|---|---|
| Pix preparado na Review | ✅ | ✅ | ✅ | Validado |
| QR / copia e cola | ✅ | ✅ | ✅ | Validado |
| A — Pix pendente → Place order | ✅ | ✅ | ✅ #75, #78 | Validado |
| B — Place order → webhook depois | ✅ | ✅ | ✅ #76 | Validado |
| B' — webhook (pago) → usuário na Review → Place order | ✅ | ✅ | ⚠ | E2E isolado pendente |
| C — Pix pago → webhook → aba fechada, sem Place order | ✅ | parcial¹ | ✅ #77 | Validado |
| Bloqueio do Place order (Pix) | ✅ | ❌ storefront sem testes | ✅ | Validado em E2E |
| Webhook (fluxo antes do hardening) | ✅ | ✅ | ✅ | ⚠ comprovado antes do hardening |
| Correlação nova do webhook (depois do hardening) | ✅ | ✅ | ⚠ | E2E real pendente |
| Cartão (crédito) | ✅ `payment_type_id = credit_card` | parcial² | ✅ #79 (antes), #80 (regressão após a correção) | Validado (2026-09-27) |
| Cartão (débito) | ✅ `payment_type_id = debit_card` → `type: debit_card` (ADR-005) | ✅ | ⚠ inviável no sandbox: o único débito de teste oficial é classificado como `prepaid_card` | Corrigido; E2E de débito não validável no sandbox atual |
| `refundPayment` | existe no código | ❌ | — | Não validado |
| `cancelPayment` | existe no código | ❌ | — | Não validado |
| `retrievePayment` | existe no código | ❌ | — | Não validado |
| `getPaymentStatus` | existe no código | ❌ | — | Não validado |

¹ Os testes cobrem a emissão do evento pelo webhook para a session correta. Completar o carrinho sem o navegador é do core do Medusa e só está coberto pelo E2E.
² `authorizePayment` no caminho de cartão tem testes; `initiatePayment` e a integração com o Brick, não.

## Evidência E2E

Fonte: execução real relatada pelo responsável, antes de `0326748` [decisão humana 2026-09-27].

### Pix

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

### Cartão

Executado em 2026-09-27, com evidências completas na [INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md#5-evidência-e2e-sandbox-2026-09-27).

```text
Crédito (Visa)  — Brick → session → authorizePayment (type credit_card) → MP processed/accredited → Order #79   ✅
Débito          — o cartão oficial "Elo Débito" é classificado como prepaid_card e o Brick o recusa antes do onSubmit   ❌
                  Orders API: debelo + credit_card → 400 (validação de esquema); debelo + debit_card → 400 not_allowed_for_collector
```

Runtime do Brick: `paymentType`, `selectedPaymentMethod` e `additionalData.paymentTypeId` = `"credit_card"` (snake_case; os tipos do `sdk-react` 1.0.7 dizem `'creditCard'`).

## Comportamentos validados

- **Pix em `pending_authorization` é suportado pelo fluxo do Medusa 2.20.1.** O `complete-cart` e o `authorize-payment-session` do `@medusajs/core-flows` 2.20.1 instalado tratam esse status. Na prática, o cenário A mostrou o pedido sendo criado com o Pix pendente.
- **Pagamento assíncrono completa o carrinho sem o navegador**, pelo mecanismo nativo `processPaymentWorkflow` → `completeCartAfterPaymentStep` → `completeCartWorkflow`. Os três existem no `@medusajs/core-flows` 2.20.1 instalado, e o cenário C comprovou o fluxo de ponta a ponta.
- **Hardening do webhook** (`0326748`): a correlação passou a ser `data.id` → `GET /v1/orders/{data.id}` → `mercadopago_order_id` → Payment Session exata → cart → evento → `processPaymentWorkflow`. Está coberta por testes unitários. ⚠ Não foi reexecutada com webhook real depois da mudança.
- Migração de identidade do provider concluída [banco 2026-09-25] (resultado em [runbooks/provider-id-migration.md](runbooks/provider-id-migration.md)).
- 121 testes unitários passando e TypeScript limpo no backend e no storefront (2026-09-25). Lint não foi executado.

## Pendências funcionais (por prioridade)

Nenhuma delas deve virar alteração de código sem passar pelo fluxo de investigação ([investigations/README.md](investigations/README.md)).

### Alta

1. **[INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md)**: débito enviado como `credit_card`.
   - ✅ causa confirmada;
   - ✅ correção implementada, [ADR-005](decisions/ADR-005-card-payment-type-from-brick.md), ainda não commitada;
   - ✅ crédito validado, com regressão E2E #80;
   - ⚠ débito não validável no sandbox atual.
   - Sessions de cartão antigas, sem `payment_type_id`, são recusadas com erro controlado e exigem novo preenchimento.
2. ✅ ~~E2E real de cartão~~: crédito validado (#79); débito coberto pela INV-001.
3. ⚠ **E2E real do webhook depois do hardening**, incluindo o cenário B'.

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

### Segurança (prioridade ainda não definida)

- 🔍 **Exposição de `session.data` pela API genérica de carrinho.**
  - Os campos padrão da Store API de carrinho no Medusa 2.20.1 (`defaultStoreCartFields`) incluem `*payment_collection.payment_sessions`, isto é, a session inteira com `data`.
  - Pelo que o provider e a rota de update gravam, `data` pode conter: `payer.email`, identificação/CPF (cartão), `card_token`, `issuer_id`, `installments`, idempotency keys internas, `mercadopago_order_id`, IDs de payment, dados de status e dados Pix.
  - Solução pretendida: no futuro, impedir a exposição de `session.data` inteiro e fazer o storefront consumir apenas DTOs específicos [decisão humana 2026-09-27]. Não implementado.

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
