# Runbook: migração `pp_mercadopago_mercadopago` → `pp_mercadopago`

> Status: **concluída** (registro histórico) · Última verificação: 2026-09-25 · Commit: `0326748`

Decisão: [ADR-001](../decisions/ADR-001-provider-identity-pp-mercadopago.md).

## Por que foi preciso migrar dados

O container registra só o token calculado no boot. Depois de `037a5a8` (código sem `id`), registros com `provider_id = pp_mercadopago_mercadopago` deixariam de resolver (`AwilixResolutionError`). A ordem entre deploy do código, migração de dados e restart do backend precisava ser controlada.

## Estado antes (registrado no CLAUDE.md pelo commit `037a5a8`, levantamento read-only)

- 17 `payment_session` em `pp_mercadopago_mercadopago` (8 `authorized`, 9 `pending`)
- 8 `payment` em `pp_mercadopago_mercadopago` (todos capturados)
- 1 `payment_provider` `pp_mercadopago_mercadopago` (`is_enabled: true`)
- 1 `region_payment_provider` ativo apontando para ele
- 9 Orders reais dependentes
- `payment.provider_id` e `payment_session.provider_id` sem FK para `payment_provider.id`. `region_payment_provider` tem PK composta `(region_id, payment_provider_id)`, o que exige DELETE+INSERT em vez de UPDATE.

## Execução

**Não registrada no repositório:** não há SQL, script ou commit com os comandos executados nem a data exata. Se a migração for repetida em outro ambiente, o procedimento precisa ser reescrito e revisado antes.

## Estado depois [banco 2026-09-25]

- `payment_session`: 74, todas em `pp_mercadopago` (30 `authorized`, 22 `pending`, 22 `pending_authorization`)
- `payment`: 30, todos em `pp_mercadopago`, 30 com `captured_at`
- `payment_provider`: `pp_mercadopago` (habilitado), `pp_mercadopago_mercadopago` (**desabilitado**, mantido como histórico), `pp_system_default` (habilitado)
- `region_payment_provider`: região "Brasil" → apenas `pp_mercadopago`

Nenhum registro ativo em `pp_mercadopago_mercadopago`. As contagens incluem sessions e payments criados depois da migração.

## Checklist pós-migração (do CLAUDE.md original)

| Item | Estado |
|---|---|
| 1. Testes unitários do webhook com a nova identidade | OK (2026-09-25) |
| 2. TypeScript backend e storefront | OK (2026-09-25); lint não executado nesta verificação |
| 3. `SELECT` sem registros ativos no token antigo | OK [banco 2026-09-25] |
| 4. E2E de checkout novo com `pp_mercadopago` | Pix: validado em E2E com código posterior a `037a5a8` [decisão humana 2026-09-27] (ver [../status.md](../status.md#evidência-e2e)). Cartão: pendente |
| 5. Webhook real sem `AwilixResolutionError` | Webhook real funcionou nos cenários B e C, antes do hardening [decisão humana 2026-09-27]. Depois do hardening: pendente |
| 6. `retrievePayment`/`getPaymentStatus` em Payment histórico migrado | [não validado] |
| 7. Mercado Pago disponível no Admin, região afetada | [não validado] no Admin; no banco, a região aponta para `pp_mercadopago` |

## Consultas de verificação (read-only)

```sql
select provider_id, status, count(*) from payment_session where deleted_at is null group by 1,2;
select provider_id, count(*), count(captured_at) from payment where deleted_at is null group by 1;
select id, is_enabled from payment_provider order by id;
select r.name, rpp.payment_provider_id
  from region_payment_provider rpp join region r on r.id = rpp.region_id
 where rpp.deleted_at is null;
```
