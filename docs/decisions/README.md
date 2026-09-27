# Registros de decisão (ADRs)

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

Um ADR registra **uma** decisão arquitetural: contexto, decisão, alternativas e consequências. ADR aceito não é editado (exceto correção de erro factual): se a decisão mudar, cria-se um novo ADR com status "substitui ADR-00X", e o antigo passa a "substituído".

Só viram ADR decisões com evidência no código ou no Git. O que não foi decidido conscientemente (por exemplo, lógica fora de workflows [decisão humana 2026-09-25]) é dívida técnica e fica em [../status.md](../status.md).

| ADR | Título | Status | Data |
|---|---|---|---|
| [ADR-001](ADR-001-provider-identity-pp-mercadopago.md) | Identidade do provider: `pp_mercadopago` (sem `id` no config) | Aceito | 2026-09-20 |
| [ADR-002](ADR-002-orders-api-automatic-capture.md) | Orders API com captura automática | Aceito | 2026-09-18 |
| [ADR-003](ADR-003-pix-charge-created-at-review.md) | Cobrança Pix criada na etapa Review | Aceito | 2026-09-25 |
| [ADR-004](ADR-004-webhook-hmac-lowercase-data-id.md) | HMAC do webhook com `data.id` em minúsculas | Aceito | 2026-09-21 |
| [ADR-005](ADR-005-card-payment-type-from-brick.md) | Tipo do cartão vem do Payment Brick (`payment_type_id`) | Aceito | 2026-09-27 |

As datas são as dos commits em que a decisão entrou no código.

Modelo:

```markdown
# ADR-00X: <título>

> Status: proposto | aceito | substituído por ADR-00Y · Data: AAAA-MM-DD · Commits: <hash>

## Contexto
## Decisão
## Alternativas consideradas
## Consequências
```
