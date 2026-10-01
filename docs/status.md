# Status do projeto

> Status: vigente · Última verificação: 2026-10-01 · Commit: `bdefe51` · Branch: `upgrade/medusa-2.21.x`

Responde só **"onde o projeto está agora?"**. Explicações, evidências e histórico ficam nos documentos ligados; ler um deles só quando a tarefa tocar aquele tema ([roteador](README.md#roteador-tarefa--o-que-ler)). Histórico deste arquivo: Git (a versão longa anterior está em `git show bdefe51:docs/status.md`). Marcadores de origem: [README.md](README.md#convenções).

Legenda: ✅ comprovado · ⚠ pendente ou parcial · 🔍 investigação ou decisão em aberto · 🛠 dívida técnica

## Próxima ação

1. Decidir o destino do artefato residual da INV-009 (pendências, abaixo).
2. Decidir quando publicar e integrar a branch `upgrade/medusa-2.21.x` (sem push nem merge até agora).

## Baseline

| Item | Estado |
|---|---|
| Branch | `upgrade/medusa-2.21.x` sobre `a92d307`: `bdefe51 chore(medusa): upgrade core to 2.21.2` e, em seguida, o commit só de documentação que reorganiza `docs/` e registra a INV-010; só local (não publicado) [`git status` 2026-10-01] |
| Outras branches | `rebuild/mercadopago-pix-storefront` em `a92d307`, igual ao `origin`; `main` sem o Pix; `recovery/base-81f5caf` em `81f5caf` [`git status` 2026-10-01] |
| Medusa | 2.21.2 no backend; no storefront, `js-sdk`, `ui-preset` e `types` 2.21.2 [commit `bdefe51`] |
| Exceção de versão | `@medusajs/icons` 2.20.1 no storefront (único `@medusajs` 2.20.1 no lockfile); motivo não registrado |
| Migrations | `db:migrate` executado em 2026-10-01 02:08Z [decisão humana 2026-10-01]; aplicou as 2 migrations novas do `@medusajs/search`; nenhuma pendente nos módulos carregados [banco 2026-10-01] ([INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#migrations-banco-2026-10-01)) |
| Testes e builds | backend 23 suítes / 569 testes; `tsc` limpo; `medusa build` e `next build` passando (2026-10-01, `bdefe51`) |
| Runtime no 2.21.2 | ✅ regressão mínima 5 de 5 PASS: boot, cartão (#145), Pix pago pelo webhook (#146), redação da Store API, cancelamento pelo Admin (#145, #147) [sandbox 2026-10-01] ([INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#validação-em-runtime-sandbox-2026-10-01)) |

**Validade da evidência.** Todo E2E e toda leitura do core registrados até 2026-09-30 foram feitos no Medusa **2.20.1**. No 2.21.2, valem os caminhos revalidados pela [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#impacto-nos-documentos) (coluna "2.21.2" abaixo); os demais continuam com evidência só do 2.20.1 ([limites](investigations/INV-010-medusa-2-21-2-upgrade.md#limites)).

## Matriz de evidências

"Teste unitário" = specs do backend. "E2E real" = checkout real em sandbox, **no Medusa 2.20.1**; os números são pedidos Medusa. #75–#78 foram executados antes do hardening do webhook (`0326748`) [decisão humana 2026-09-27]; #79 em diante, depois. Coluna "2.21.2": o que foi revalidado no baseline atual, com evidência na [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#resultados) [sandbox 2026-10-01].

| Área | Teste unitário | E2E real (2.20.1) | 2.21.2 | Onde está a evidência |
|---|---|---|---|---|
| Pix preparado na Review, QR / copia e cola | ✅ | ✅ | ✅ #146, #147 (API, sem UI) | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md) |
| A — Pix pendente → Place order | ✅ | ✅ #75, #78 (antes); #81, #82, #84, #86 (depois) | ✅ #147 | idem |
| B — Place order → webhook depois | ✅ | ✅ #76 (antes); ⚠ depois: não reproduzido | ⚠ | [E2E-B-2026-09-29](investigations/E2E-B-2026-09-29.md) |
| B' — webhook (pago) → Review → Place order | ✅ | ✅ #91 | ⚠ | [E2E-B-PRIME-2026-09-29](investigations/E2E-B-PRIME-2026-09-29.md) |
| C — Pix pago → webhook → aba fechada | parcial¹ | ✅ #77 (antes); ✅ #83, #92 (depois) | ✅ #146 | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#webhook-real-depois-do-hardening-2026-09-27-código-3a56150), [E2E-B](investigations/E2E-B-2026-09-29.md) |
| Bloqueio do Place order (Pix) | ❌ storefront sem testes | ✅ | ⚠ | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md) |
| Webhook: assinatura, `GET /v1/orders`, correlação exata, duplicada/tardia, Order de outra cobrança | ✅ | ✅ #80, #83, #92, teste negativo | ✅ #145–#147, sem o teste negativo | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#webhook-real-depois-do-hardening-2026-09-27-código-3a56150) |
| Cartão (crédito) | parcial² | ✅ #79, #80 | ✅ #145 | [INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md) |
| Cartão (débito) | ✅ | ⚠ inviável no sandbox (débito de teste classificado como `prepaid_card`) | — | [INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md) |
| Tentativa de cartão ambígua (INV-009) | ✅ | ✅ cenários 1, 2, 3, 7, 8, 9, H7 | ⚠ só o caminho feliz (#145, `resolved`) | [INV-009](investigations/INV-009-card-ambiguous-order-reconciliation.md) |
| Tentativa depois do prazo (ADR-016) | ✅ | ✅ 1, 1b, 2a, 2b (#132, #136) | ⚠ | [E2E-CARD-ATTEMPT-DEADLINE-2026-09-30](investigations/E2E-CARD-ATTEMPT-DEADLINE-2026-09-30.md) |
| `refundPayment` | ✅ | ✅ #80, #85, #91, #92; regressão #119, #128 | ✅ total #145 (pelo cancelamento); parcial ⚠ | [INV-004](investigations/INV-004-refund-payment-amount-and-idempotency.md), [INV-009](investigations/INV-009-card-ambiguous-order-reconciliation.md) |
| Cancelamento de pedido (Admin) | ✅ | ✅ #94–#101; regressão #124 | ✅ #145, #147 | [INV-005](investigations/INV-005-cancel-order-with-pending-pix.md), [INV-006](investigations/INV-006-payment-collection-rollback.md) |
| `cancelPayment` (cartão) | ✅ `CP` | ⚠ só chamada direta ao provider; caminho core → `cancelPayment` não observado | ⚠ | [E2E-CANCEL-PAYMENT-2026-09-30](investigations/E2E-CANCEL-PAYMENT-2026-09-30.md) |
| Capability de pagamento (ADR-007) | ✅ | ✅ #87, #88, navegador | ⚠ | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#capability-de-pagamento-adr-007) |
| Redação da Store API (ADR-006) | ✅ | ✅ 2026-09-27 | ✅ com a nova política de campos | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#store-api-antes-e-depois-do-adr-006-2026-09-27) |
| `retrievePayment`, `getPaymentStatus` | ❌ | — | — | — |

¹ Os testes cobrem a emissão do evento pelo webhook para a session correta. Completar o cart sem o navegador é do core e só está coberto pelo E2E.
² `authorizePayment` no caminho de cartão tem testes; `initiatePayment` e a integração com o Brick, não.

## Pendências abertas

Nenhuma vira alteração de código sem passar pelo fluxo de investigação ([investigations/README.md](investigations/README.md)).

### Alta

Nenhuma.

### Média

1. ⚠ **Artefato residual da INV-009**: a tentativa `mpca_01M3S6S85G125GT437C94NZMEC` continua `unknown`, com a MP Order paga e sem pedido Medusa. Pelo ADR-016, o prazo não muda o estado; um Place order ou uma reentrega do webhook a resolve ([pendência](investigations/INV-009-card-ambiguous-order-reconciliation.md#dados-criados-e-pendência)). Outras tentativas de teste: [E2E-CARD-ATTEMPT-DEADLINE](investigations/E2E-CARD-ATTEMPT-DEADLINE-2026-09-30.md).
2. ⚠ **ADR-016, itens não validados ou não implementados** ([seção 11](decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md#11-decisões-desta-revisão-e-pendências)):
   - corrida webhook × resolução depois do prazo: cobertura só unitária;
   - liberação por `total = 0` desligada enquanto `H = null` (→ `card_attempt_manual_review`); fixar `H` exige a validação read-only da busca no sandbox, com autorização;
   - sem limpeza periódica do ciphertext de tentativas abandonadas;
   - o storefront ainda não trata os códigos do contrato ([seção 4.6](decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md#46-contrato-mínimo-com-o-storefront));
   - sem teste unitário de `deletePayment` com tentativa `failed`, nem do ramo em que uma tentativa `submitted` passa do prazo durante o Place order.
3. ⚠ **`card_token` antigo em claro**: 38 `payment_session`, 33 `payment` e 13 execuções `complete-cart` do `workflow_execution` (retidas por 3 dias) [banco 2026-09-30, só contagens]. Sessions novas não guardam o token (ADR-015). A remoção exige autorização.
4. ⚠ **INV-009, hipóteses H2, H3 e H4 não validadas** (retenção da idempotência, replay concorrente, token consumido) ([hipóteses](investigations/INV-009-card-ambiguous-order-reconciliation.md#perguntas-em-aberto-exigem-teste-ou-decisão)). O cenário 6 (job de reconciliação/alerta) não tem E2E: o job não existe.
5. ⚠ **Pix, cenário B depois do hardening**: não reproduzido; a aprovação do sandbox é rápida demais para clicar em Place order antes dela ([E2E-B](investigations/E2E-B-2026-09-29.md)).
6. ⚠ **Webhook da Order órfã da INV-003**: não comprovado ([E2E-B](investigations/E2E-B-2026-09-29.md#order-órfã-da-inv-003)).
7. ⚠ **`cancelPayment`: caminho core → provider não observado.** O checkout não cria uma Order de cartão cancelável. É lacuna de cobertura, não defeito conhecido ([E2E-CANCEL-PAYMENT](investigations/E2E-CANCEL-PAYMENT-2026-09-30.md)).

### Baixa

8. ⚠ Cartão de débito não validável no sandbox ([INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md)).
9. 🔍 Status desconhecido: no cartão vira `pending` (`getStatusFromGateway`); no Pix lança erro (`resolvePixStatus`). Inconsistência conhecida, não demonstrada como bug; sem correção sugerida.
10. ⚠ `retrievePayment` e `getPaymentStatus` sem testes e sem E2E, inclusive num Payment anterior à migração de identidade.
11. ⚠ Mercado Pago disponível no Admin para a região Brasil: no banco, a região aponta para `pp_mercadopago` [banco 2026-09-25]; no Admin, não verificado.
12. ⚠ Reembolso: não observados `processing`/`failed` e recusa do Mercado Pago. A entrega do webhook depois de um reembolso foi observada no 2.21.2 (200, nada criado; [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#observações-diferenças-de-2201-e-dados-novos)). `payment.data` não reflete o reembolso, sem bug ([INV-004](investigations/INV-004-refund-payment-amount-and-idempotency.md#semântica-de-paymentdata-depois-do-reembolso)).
13. ⚠ `PaymentButton` usa `payment_sessions[0]`: sem bug ([INV-007](investigations/INV-007-payment-button-first-session.md)); corrida entre inicializações concorrentes [não validado].
14. ⚠ Pix: `carts/:id/pix` com 410 e DTO reduzido (invariantes 14 e 26) não reexecutado em E2E; a Review depois da deadline local (ADR-008) não foi observada.
15. ⚠ Caminhos sem evidência no 2.21.2 (só no 2.20.1): tentativa ambígua e prazo do cartão, reembolso parcial, capability, cenário B, compensação com falha do cancelamento, `createPaymentSessionsWorkflow`, `GET /store/orders/:id` ([limites](investigations/INV-010-medusa-2-21-2-upgrade.md#limites)).

### Segurança e produto

16. 🔍 `GET /store/orders/:id` do core devolve e-mail e endereços a quem tem o ID do pedido ([INV-002](investigations/INV-002-store-order-retrieve-without-auth.md)); verificado só no código.
17. 🔍 `POST /store/mercadopago/payment-sessions/:id` devolve a `payment_session` inteira, com `data`; `/store/mercadopago/*` não é coberto pelo ADR-006.
18. 🔍 Oferecer um novo Pix na confirmação quando a janela fecha sem pagamento: não há caminho depois da conclusão do cart; exige decisão ([ADR-009](decisions/ADR-009-payment-access-keeps-provider-status.md)).
19. ⚠ Job `cleanup-payment-access-grants`: execução agendada não observada (última verificação em 2026-09-27).

## Dívida técnica

Não bloqueia nenhuma pendência funcional.

- 🛠 **Lógica de pagamento fora de workflows** (provider e rotas). Contraria o [AGENTS.md](../AGENTS.md). **Não foi decisão deliberada** [decisão humana 2026-09-25]. É a origem dos 2 warnings do lint do backend (`updatePaymentSession` em rota).
- 🛠 Sem CI. Sem testes de integração HTTP. Storefront só com o teste da fronteira Pix (`pnpm test`).
- 🛠 Lint do storefront: 12 erros e 3 warnings em código não alterado (`no-explicit-any`, `no-unused-vars`, `ban-ts-comment`, `exhaustive-deps`), medido em 2026-09-27; não corrigido nem remedido.
- 🛠 `apps/storefront/tsconfig.tsbuildinfo` versionado.
- 🛠 `.env.template` incompleto (ver [development.md](development.md#variáveis-de-ambiente)).
- 🛠 Skills e `.github/agents/medusa-mercadopago.agent.md` desatualizados: não mencionam o Pix.
- 🛠 Comentários citam documentos que não existem: "the audit's D4 finding" (`payment-sessions/[id]/route.ts`) e "see the report" (`service.ts`, `reauthorizePixOrder`).
- 🛠 `"pp_mercadopago"` repetido em 7 arquivos (backend e storefront).
- 🛠 Textos da UI de pagamento em inglês ("Place order", painel Pix).
- 🛠 Pix ainda não mergeado na `main`.

## Dados de teste deixados de propósito

Pedidos #97 e #99 ([INV-006](investigations/INV-006-payment-collection-rollback.md)), Orders sandbox sem cart ([INV-003](investigations/INV-003-pix-sandbox-approval.md), [E2E-CANCEL-PAYMENT](investigations/E2E-CANCEL-PAYMENT-2026-09-30.md)) as tentativas listadas nas pendências 1 e 2 e os pedidos #145–#147 da [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#resultados). Não apagar sem autorização.
