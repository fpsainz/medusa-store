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
