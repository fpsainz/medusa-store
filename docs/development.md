# Desenvolvimento

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

Comandos genéricos (dev, build, lint, testes, db): [../AGENTS.md](../AGENTS.md). Aqui só o que é específico deste projeto.

## Ambiente

- WSL2 / Ubuntu.
- Node: `^20.19.0 || >=22.12.0` (`engines` em `package.json`).
- pnpm `10.11.1` (`packageManager`). Não usar outro gerenciador.
- Versões fixadas: Medusa `2.21.2` em todos os pacotes `@medusajs/*` do backend e do storefront e em `@medusajs/eslint-plugin` (raiz); `@medusajs/ui` `4.2.6`. **Exceção:** `@medusajs/icons` continua em `2.20.1` no storefront; o motivo não está registrado. Upgrade a partir do 2.20.1 em `bdefe51` [commit `bdefe51`]; validação: [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md). Não atualizar dependências sem autorização.
- Portas: backend `9000` (admin em `/app`), storefront `8000`.

## Banco (Supabase)

`medusa-config.ts` altera a `DATABASE_URL` em tempo de execução: troca `sslmode=require` por `ssl_mode=disable` e passa `databaseDriverOptions.connection.ssl = { rejectUnauthorized: false }`. O efeito exato na conexão (SSL ativo sem validação de certificado) é **[não validado]**. Não remover sem testar a conexão com o Supabase.

Consultas de diagnóstico são read-only (regra do [CLAUDE.md](../CLAUDE.md)).

## Variáveis de ambiente

Somente nomes. Nunca registrar valores.

**Backend** (`apps/backend/.env`, modelo em `.env.template`):

| Variável | Usada em |
|---|---|
| `DATABASE_URL` | `medusa-config.ts` |
| `STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS` | `medusa-config.ts` |
| `JWT_SECRET`, `COOKIE_SECRET` | `medusa-config.ts` |
| `MERCADOPAGO_ACCESS_TOKEN` | `medusa-config.ts` (opção do provider), rota do webhook, `GET /store/mercadopago/carts/:id/pix` |
| `MERCADOPAGO_WEBHOOK_SECRET` | rota do webhook (sem ela o webhook responde 500) |
| `MERCADOPAGO_PUBLIC_KEY`, `REDIS_URL`, `DB_NAME` | presentes no `.env.template`, **não referenciadas** no código do projeto [não validado: se são lidas internamente pelo Medusa/CLI] |
| `AUTH_MFA_ENCRYPTION_KEY` | presente no `.env` local, **ausente** do `.env.template`; não referenciada no código do projeto [não validado: se é lida internamente pelo Medusa] |

**Storefront** (`apps/storefront/.env.local`; **não existe** `.env.template`):

| Variável | Observação |
|---|---|
| `NEXT_PUBLIC_MEDUSA_BACKEND_URL`, `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` | obrigatórias; a publishable key é checada em `check-env-variables.js` |
| `NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY` | sem ela o Payment Brick não renderiza |
| `NEXT_PUBLIC_DEFAULT_REGION`, `NEXT_PUBLIC_BASE_URL` | do starter |
| `NEXT_PUBLIC_STRIPE_KEY`, `NEXT_PUBLIC_MEDUSA_PAYMENTS_*`, `MEDUSA_CLOUD_S3_*`, `NEXT_PUBLIC_VERCEL_URL` | do starter; não usadas pelo fluxo Mercado Pago |

## Verificações rápidas

```bash
cd apps/backend && pnpm run test:unit     # 23 suítes / 569 testes em 2026-10-01
cd apps/backend && npx tsc --noEmit -p .
cd apps/storefront && npx tsc --noEmit
```

Não existem testes de integração HTTP (`apps/backend/integration-tests/http/` não existe), testes no storefront nem CI em `.github/`.

## Armadilhas conhecidas

- Adicionar `id` ao provider em `medusa-config.ts` muda o token para `pp_mercadopago_<id>` e quebra a resolução de sessions/payments existentes. Ver [ADR-001](decisions/ADR-001-provider-identity-pp-mercadopago.md).
- `apps/storefront/tsconfig.tsbuildinfo` (artefato de build) está versionado no Git e já entrou em commits de funcionalidade (`c41d686`, `0326748`). Não incluir em commits sem necessidade.
- Webhook em desenvolvimento exige URL pública: [runbooks/dev-webhook-tunnel.md](runbooks/dev-webhook-tunnel.md).
