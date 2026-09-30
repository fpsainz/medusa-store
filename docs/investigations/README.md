# Investigações

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

Um achado sem evidência suficiente para justificar uma mudança de código vira uma investigação aqui, e não uma correção direta.

```text
achado → investigação → teste → decisão → ADR/documentação → código, se necessário
```

Regras:

- Uma investigação por arquivo: `INV-00X-<tema>.md`.
- Separar **fatos** (verificados no código/Git/testes) de **hipóteses** e **perguntas em aberto**.
- Não alterar o código de comportamento enquanto a investigação estiver aberta.
- Ao concluir, registrar o resultado e o destino: ADR, mudança em `docs/`, tarefa de código ou "sem ação". Status final: `concluída` ou `descartada`.

| ID | Tema | Status |
|---|---|---|
| [INV-001](INV-001-debit-card-sent-as-credit-card.md) | Débito enviado à Orders API como `credit_card` | aberta |
| [INV-002](INV-002-store-order-retrieve-without-auth.md) | `GET /store/orders/:id` devolve dados do comprador a quem tem o ID | aberta |
| [INV-003](INV-003-pix-sandbox-approval.md) | Aprovação de Pix da Orders API no sandbox (`payer.first_name = "APRO"`) | concluída |
| [INV-004](INV-004-refund-payment-amount-and-idempotency.md) | `refundPayment`: valor como `BigNumberInput`, idempotency key por reembolso, total × parcial | concluída (E2E sandbox cartão e Pix; [ADR-011](../decisions/ADR-011-mercadopago-refund-contract.md)) |
| [INV-005](INV-005-cancel-order-with-pending-pix.md) | Cancelar pedido Medusa com Pix pendente não cancela a Order Mercado Pago | concluída (hook `orderCanceled`, [ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md); E2E sandbox) |
| [INV-006](INV-006-payment-collection-rollback.md) | Payment Collection fica `canceled` quando o `cancelOrderWorkflow` é revertido (compensation do core falha) | concluída (wrapper que cancela o Pix antes do core, [ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md); E2E A/B/C/D) |
| [INV-007](INV-007-payment-button-first-session.md) | `PaymentButton` escolhe o botão por `payment_sessions[0]` | concluída (B: o core garante no máximo uma session por collection; sem bug; corrida concorrente [não validado]) |
| [E2E-B-PRIME-2026-09-29](E2E-B-PRIME-2026-09-29.md) | E2E do cenário B' com o nome de cobrança `APRO` e webhook real (registro de execução, fora da numeração `INV`) | concluída (CONFIRMADO) |
| [E2E-B-2026-09-29](E2E-B-2026-09-29.md) | E2E do cenário B com o nome de cobrança `APRO`, segunda janela da Order órfã da INV-003 e tempos de aprovação (registro de execução, fora da numeração `INV`) | concluída (NÃO REPRODUZIDO) |

Modelo:

```markdown
# INV-00X: <tema>

> Status: aberta | concluída | descartada · Aberta em: AAAA-MM-DD · Commit: <hash>

## Achado
## Fatos
## Hipóteses
## Perguntas em aberto
## Plano de validação
## Critério de decisão
## Resultado
```
