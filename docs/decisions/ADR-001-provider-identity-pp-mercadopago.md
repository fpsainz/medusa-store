# ADR-001: Identidade do provider `pp_mercadopago`

> Status: aceito · Data: 2026-09-20 · Commits: `037a5a8` (código); migração de dados executada depois (ver runbook)

## Contexto

O loader do módulo de pagamento (`@medusajs/payment`) registra cada provider no container (Awilix) com o token `pp_${service.identifier}${config.id ? '_' + config.id : ''}`.

O projeto tinha `id: 'mercadopago'` no provider em `medusa-config.ts` e `static identifier = 'mercadopago'` em `service.ts`, o que gerava o token duplicado `pp_mercadopago_mercadopago`. O valor de `provider` no webhook também era `mercadopago_mercadopago` e precisava de tradução a partir do segmento público da URL.

## Decisão

- Omitir `id` do provider em `medusa-config.ts`. O token passa a ser `pp_mercadopago`.
- O segmento público do webhook e o `provider` interno passam a ser o mesmo valor (`mercadopago`), sem camada de tradução.
- O storefront compara com `pp_mercadopago` (`isMercadoPago` em `constants.tsx`).

## Alternativas consideradas

Nenhuma alternativa foi registrada. A justificativa registrada no CLAUDE.md pelo commit `037a5a8` foi: "a correção definitiva é omitir `id` do config, já que o `identifier` sozinho já identifica o provider de forma única neste projeto".

## Consequências

- O container registra **apenas** o token calculado no boot. Registros no banco com outro `provider_id` deixam de resolver (`AwilixResolutionError`). Por isso a mudança de código exigiu uma migração de dados: [../runbooks/provider-id-migration.md](../runbooks/provider-id-migration.md).
- **Nunca** adicionar `id` a este provider sem outra migração planejada. Hoje nenhum teste impede isso.
- Fica um comentário em `medusa-config.ts` explicando a ausência do `id`.
