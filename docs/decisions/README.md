# Registros de decisão (ADRs)

> Status: vigente · Última verificação: 2026-10-01 · Commit: `bdefe51`

Um ADR registra **uma** decisão arquitetural: contexto, decisão, alternativas e consequências. ADR aceito não é editado (exceto correção de erro factual): se a decisão mudar, cria-se um novo ADR com status "substitui ADR-00X", e o antigo passa a "substituído".

Só viram ADR decisões com evidência no código ou no Git. O que não foi decidido conscientemente (por exemplo, lógica fora de workflows [decisão humana 2026-09-25]) é dívida técnica e fica em [../status.md](../status.md).

**Premissas do core.** A coluna "Core" marca os ADRs cujo contexto ou consequências se apoiam em comportamento do Medusa lido na versão indicada. O ADR continua valendo como decisão; a premissa sobre o core é revalidada na [INV-010](../investigations/INV-010-medusa-2-21-2-upgrade.md#impacto-nos-documentos) (baseline 2.21.2: análise de código e regressão mínima em runtime; os caminhos não revalidados estão nos limites dela). O ADR não é editado por causa disso.

| ADR | Título | Status | Data | Core |
|---|---|---|---|---|
| [ADR-001](ADR-001-provider-identity-pp-mercadopago.md) | Identidade do provider: `pp_mercadopago` (sem `id` no config) | Aceito | 2026-09-20 | 2.20.1 |
| [ADR-002](ADR-002-orders-api-automatic-capture.md) | Orders API com captura automática | Aceito | 2026-09-18 | — |
| [ADR-003](ADR-003-pix-charge-created-at-review.md) | Cobrança Pix criada na etapa Review | Aceito | 2026-09-25 | 2.20.1 |
| [ADR-004](ADR-004-webhook-hmac-lowercase-data-id.md) | HMAC do webhook com `data.id` em minúsculas | Aceito | 2026-09-21 | — |
| [ADR-005](ADR-005-card-payment-type-from-brick.md) | Tipo do cartão vem do Payment Brick (`payment_type_id`) | Aceito | 2026-09-27 | — |
| [ADR-006](ADR-006-store-api-redacts-mercadopago-provider-data.md) | Store API não expõe `data` do provider Mercado Pago | Aceito | 2026-09-27 | 2.20.1 |
| [ADR-007](ADR-007-payment-access-capability-for-pix.md) | Capability temporária (`payment_access`) para acompanhar o Pix depois do checkout | Aceito | 2026-09-27 | 2.20.1 |
| [ADR-008](ADR-008-pix-payment-window-hides-artifacts.md) | Fim da janela de pagamento do Pix esconde QR/ticket sem mudar o status do provider | Aceito | 2026-09-27 | — |
| [ADR-009](ADR-009-payment-access-keeps-provider-status.md) | A leitura por capability mantém o status do provider e sinaliza a janela à parte | Aceito | 2026-09-27 | — |
| [ADR-010](ADR-010-pix-payer-name-from-billing-address.md) | Nome do pagador do Pix derivado do endereço de cobrança do cart | Aceito | 2026-09-29 | — |
| [ADR-011](ADR-011-mercadopago-refund-contract.md) | Contrato de reembolso do provider Mercado Pago (valor, idempotency key por reembolso, total × parcial) | Aceito | 2026-09-29 | 2.20.1 |
| [ADR-012](ADR-012-cancel-pending-pix-on-order-cancel.md) | Cancelar o Pix pendente no hook `orderCanceled` do `cancelOrderWorkflow` | Substituído em parte pelo ADR-013 (o hook continua como rede de segurança) | 2026-09-29 | 2.20.1 |
| [ADR-013](ADR-013-cancel-order-wrapper-cancels-pix-first.md) | Cancelar o Pix pendente antes do `cancelOrderWorkflow` (workflow wrapper na rota do Admin) | Aceito | 2026-09-29 | 2.20.1 |
| [ADR-014](ADR-014-card-order-idempotency-key-from-body.md) | Idempotency key da Order de cartão derivada da chave base + body canônico | Aceito | 2026-09-29 | — |
| [ADR-015](ADR-015-card-ambiguous-order-reconciliation.md) | Reconciliação da Order de cartão com resultado ambíguo (tentativa em módulo próprio com token cifrado, `external_reference` por tentativa, replay idempotente, fallback do webhook) | Aceito; substituído em parte pelo ADR-016 (prazo como fim funcional da tentativa) | 2026-09-29 | 2.20.1 |
| [ADR-016](ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md) | O prazo da tentativa de cartão controla replay e retenção do CardToken, não o fim da tentativa; tentativa ambígua depois do prazo resolvida pela busca da Order | Aceito | 2026-09-30 | 2.20.1 |

As datas são as dos commits em que a decisão entrou no código; para um ADR proposto, a data da proposta.

Modelo:

```markdown
# ADR-00X: <título>

> Status: proposto | aceito | substituído por ADR-00Y · Data: AAAA-MM-DD · Commits: <hash>

## Contexto
## Decisão
## Alternativas consideradas
## Consequências
```
