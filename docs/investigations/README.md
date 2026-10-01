# Investigações

> Status: vigente · Última verificação: 2026-10-01 · Commit: `bdefe51`

Um achado sem evidência suficiente para justificar uma mudança de código vira uma investigação aqui, e não uma correção direta.

```text
achado → investigação → teste → decisão → ADR/documentação → código, se necessário
```

Regras:

- Uma investigação por arquivo: `INV-0XX-<tema>.md`. Registros de execução (o que foi executado e observado numa data) ficam fora da numeração: `E2E-<TEMA>-<data>.md`.
- Separar **fatos** (verificados no código/Git/testes) de **hipóteses** e **perguntas em aberto**.
- Não alterar o código de comportamento enquanto a investigação estiver aberta.
- Ao concluir, registrar o resultado e o destino: ADR, mudança em `docs/`, tarefa de código ou "sem ação". Status final: `concluída` ou `descartada`.
- **Investigação concluída e registro de execução são histórico.** Não reescrevê-los para o estado atual. Fato novo entra como nota datada no fim, ou numa investigação nova. O comportamento atual fica em [../mercadopago/](../mercadopago/README.md).
- **Versão.** A coluna "Medusa" indica a versão do core em que a evidência foi obtida. Revalidação no baseline atual: [INV-010](INV-010-medusa-2-21-2-upgrade.md#impacto-nos-documentos).

## Investigações

| ID | Tema | Status | Medusa |
|---|---|---|---|
| [INV-001](INV-001-debit-card-sent-as-credit-card.md) | Débito enviado à Orders API como `credit_card` | causa confirmada; corrigida em `3a56150` ([ADR-005](../decisions/ADR-005-card-payment-type-from-brick.md)); crédito validado; débito não validável no sandbox | 2.20.1 |
| [INV-002](INV-002-store-order-retrieve-without-auth.md) | `GET /store/orders/:id` devolve dados do comprador a quem tem o ID | aberta | 2.20.1 (no 2.21.2 só o comentário da rota mudou) |
| [INV-003](INV-003-pix-sandbox-approval.md) | Aprovação de Pix da Orders API no sandbox (`payer.first_name = "APRO"`) | concluída | — (só Orders API) |
| [INV-004](INV-004-refund-payment-amount-and-idempotency.md) | `refundPayment`: valor como `BigNumberInput`, idempotency key por reembolso, total × parcial | concluída ([ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md)) | 2.20.1 |
| [INV-005](INV-005-cancel-order-with-pending-pix.md) | Cancelar pedido Medusa com Pix pendente não cancela a Order Mercado Pago | concluída ([ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md)) | 2.20.1 |
| [INV-006](INV-006-payment-collection-rollback.md) | Payment Collection fica `canceled` quando o `cancelOrderWorkflow` é revertido (compensation do core falha) | concluída ([ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)) | 2.20.1 |
| [INV-007](INV-007-payment-button-first-session.md) | `PaymentButton` escolhe o botão por `payment_sessions[0]` | concluída (sem bug; corrida concorrente [não validado]) | 2.20.1 |
| [INV-008](INV-008-card-idempotency-key-per-session.md) | Idempotency key do cartão estável durante a Payment Session | concluída ([ADR-014](../decisions/ADR-014-card-order-idempotency-key-from-body.md)) | 2.20.1 |
| [INV-009](INV-009-card-ambiguous-order-reconciliation.md) | Reconciliação da Order de cartão com resultado ambíguo (timeout) | concluída ([ADR-015](../decisions/ADR-015-card-ambiguous-order-reconciliation.md), [ADR-016](../decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md)); E2E aprovados; H2–H4 não validadas e 1 artefato residual em `unknown` ([status](../status.md#pendências-abertas)) | 2.20.1 |
| [INV-010](INV-010-medusa-2-21-2-upgrade.md) | O upgrade para o Medusa 2.21.2 preserva o comportamento validado no 2.20.1? | concluída (código analisado; regressão mínima em runtime 5 de 5 PASS, #145–#147) | 2.21.2 |

## Registros de execução

| Registro | Conteúdo | Resultado | Medusa |
|---|---|---|---|
| [E2E-SANDBOX-2026-09-27](E2E-SANDBOX-2026-09-27.md) | Pix antes do hardening (#75–#78), webhook real depois do hardening (#83), cartão, regressão e exposição da Store API (ADR-006), capability de pagamento (#87, #88, navegador) | concluído | 2.20.1 |
| [E2E-B-PRIME-2026-09-29](E2E-B-PRIME-2026-09-29.md) | Cenário B' com o nome de cobrança `APRO` e webhook real | CONFIRMADO | 2.20.1 |
| [E2E-B-2026-09-29](E2E-B-2026-09-29.md) | Cenário B, segunda janela da Order órfã da INV-003 e tempos de aprovação | NÃO REPRODUZIDO | 2.20.1 |
| [E2E-CANCEL-PAYMENT-2026-09-30](E2E-CANCEL-PAYMENT-2026-09-30.md) | `cancelPayment` do cartão por chamada direta ao provider | provider aprovado; caminho do core não observado | 2.20.1 |
| [E2E-CARD-ATTEMPT-DEADLINE-2026-09-30](E2E-CARD-ATTEMPT-DEADLINE-2026-09-30.md) | Tentativa de cartão depois do prazo (ADR-016): cenários 1, 1b, 2a, 2b | 4 de 4 aprovados | 2.20.1 |

Os E2E da INV-001 a INV-009 estão nas próprias investigações.

## Modelos

```markdown
# INV-0XX: <tema>

> Status: aberta | concluída | descartada · Aberta em: AAAA-MM-DD · Commit: <hash>

## Achado
## Fatos
## Hipóteses
## Perguntas em aberto
## Plano de validação
## Critério de decisão
## Resultado
```

```markdown
# E2E-<TEMA>-<data>: <o que foi executado>

> Status: concluído (<resultado>) · Executado em: AAAA-MM-DD · Commit do código: <hash>

Investigação ou decisão de origem, versão do Medusa e marcadores de origem.

## Execução
```
