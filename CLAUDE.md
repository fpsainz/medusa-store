# CLAUDE.md

Read [AGENTS.md](./AGENTS.md) — it holds this project's directory structure, commands, conventions, and off-limits paths. Follow it for all work in this repository.

## Projeto

Monorepo de ecommerce:

- `apps/backend` — Medusa.js v2
- `apps/storefront` — Next.js
- PostgreSQL hospedado no Supabase
- Mercado inicial: Brasil
- Moeda: BRL

Respeite as versões atualmente instaladas no projeto.
Não aplicar exemplos de Medusa v1 em código Medusa v2.

## Ambiente

- WSL2 / Ubuntu
- Node.js: usar a versão definida pelo projeto
- pnpm: usar a versão definida pelo projeto
- PostgreSQL remoto via Supabase

Não atualizar dependências sem autorização explícita.

## Regras gerais

Antes de modificar arquivos:

1. verificar a estrutura relevante;
2. ler o código relacionado à tarefa;
3. executar `git status --short`;
4. preservar alterações existentes;
5. modificar somente arquivos relacionados.

Preferir alterações pequenas, isoladas e reversíveis.

Não duplicar lógica existente.
Não remover código sem verificar seus usos.
Manter TypeScript estrito.
Evitar `any` quando houver alternativa adequada.

Não colocar secrets, tokens ou credenciais no código.
Nunca commitar credenciais.

Não executar ações destrutivas sem confirmação explícita.

## Banco de dados

Consultas de diagnóstico são read-only por padrão.

Não alterar schema, apagar dados ou executar migrations destrutivas sem autorização explícita.

Não apagar, recriar ou truncar dados de checkout, pagamento ou usuário.

Antes de qualquer escrita no banco, informar o que será alterado e o efeito esperado.

## Mercado Pago

Existe uma integração ativa com Mercado Pago.

### Identidade do provider (estado alvo desta migração)

```text
endpoint público:      /hooks/payment/mercadopago
provider interno:      mercadopago
provider ID/token:     pp_mercadopago
config id (medusa-config.ts): (nenhum — omitido de propósito)
service identifier (service.ts): mercadopago
```

Três conceitos que não devem ser confundidos entre si:

- **Endpoint/path** — o segmento da URL pública do webhook (`/hooks/payment/mercadopago`). É o que o Mercado Pago chama.
- **Provider interno** — o valor de `provider` no evento `payment.webhook_received` (`apps/backend/src/api/hooks/payment/[provider]/route.ts`). Hoje é igual ao segmento público, por design — não há mais tradução entre os dois.
- **Provider ID/token Medusa** — o identificador `pp_<algo>` registrado no container (Awilix) pelo loader do `@medusajs/payment`. É calculado como `pp_${service.identifier}${config.id ? '_' + config.id : ''}`. Como `medusa-config.ts` não define `id` para este provider, e `service.ts` define `static identifier = 'mercadopago'`, o token final é `pp_mercadopago`.

Não fixar no código ou neste arquivo a URL/host temporário do túnel usado em desenvolvimento (ex.: `trycloudflare.com`). Apenas o path `/hooks/payment/mercadopago` é parte permanente da arquitetura; o host pode mudar e deve ser configurado manualmente no painel Mercado Pago a cada troca.

### Migração da identidade antiga (mercadopago_mercadopago → mercadopago)

A integração usava anteriormente:

```text
provider interno antigo: mercadopago_mercadopago
provider ID antigo:      pp_mercadopago_mercadopago
```

**Motivo da migração:** o `config id` em `medusa-config.ts` (`id: 'mercadopago'`) e o `service identifier` em `service.ts` (`static identifier = 'mercadopago'`) eram iguais, e o loader do Medusa concatena os dois quando `id` está presente (`pp_<identifier>_<id>`), gerando a duplicação `pp_mercadopago_mercadopago`. A correção definitiva é omitir `id` do config, já que o `identifier` sozinho já identifica o provider de forma única neste projeto.

**Impacto nos registros existentes:** a mudança do token não é automática para dados já persistidos. Read-only, antes da execução da migração de banco, foram confirmados:

- 17 `payment_session` com `provider_id = pp_mercadopago_mercadopago` (8 `authorized`, 9 `pending`)
- 8 `payment` com `provider_id = pp_mercadopago_mercadopago` (todos capturados)
- 1 `payment_provider` (`pp_mercadopago_mercadopago`, `is_enabled: true`)
- 1 `region_payment_provider` ativo apontando para `pp_mercadopago_mercadopago`
- 9 Orders reais dependentes desses registros
- `payment.provider_id` e `payment_session.provider_id` não têm FK declarada contra `payment_provider.id` — migração de dados não quebra integridade referencial nessas duas tabelas, mas `region_payment_provider` tem chave primária composta `(region_id, payment_provider_id)`, o que exige DELETE+INSERT em vez de UPDATE simples nessa tabela.

**Consistência código/banco/runtime:** o container Awilix só registra o token que `medusa-config.ts` produzir no boot atual — não existem dois tokens simultâneos. Por isso, alterar o código (removendo `id`) sem migrar os registros existentes no banco faz o Medusa não conseguir resolver `pp_mercadopago_mercadopago` para os Payments/Sessions antigos (`AwilixResolutionError: Could not resolve '...'`, o mesmo padrão de erro já visto na direção oposta durante o diagnóstico inicial desta integração). A ordem entre deploy do código, migração de dados e restart do backend precisa ser controlada — nunca deixar o container esperando um token que o banco ainda não usa, nem o banco usando um token que o container não registra mais.

**Testes obrigatórios após a migração completa (código + banco + restart):**

1. Testes unitários do webhook (`route.unit.spec.ts`) com a nova identidade.
2. TypeScript e lint (backend e storefront) limpos.
3. `SELECT` read-only confirmando 0 registros remanescentes em `pp_mercadopago_mercadopago` (ou, se preservado como histórico desabilitado, confirmando `is_enabled: false`).
4. Teste E2E de checkout novo, gerando `PaymentSession` com `pp_mercadopago`.
5. Teste E2E de webhook real no endpoint `/hooks/payment/mercadopago`, confirmando resolução do provider sem `AwilixResolutionError`.
6. `retrievePayment`/`getPaymentStatus` em pelo menos um dos Payments históricos migrados, confirmando que a migração preservou a capacidade operacional sobre dados antigos.
7. Confirmação no Admin Dashboard de que Mercado Pago continua disponível como opção de pagamento na região afetada.