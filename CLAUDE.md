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

Provider:

```text
config id: mercadopago
service identifier: mercadopago
provider token: pp_mercadopago_mercadopago
```

Endpoint público do webhook:

```text
endpoint público: /hooks/payment/mercadopago
provider interno: mercadopago_mercadopago
token Medusa: pp_mercadopago_mercadopago
```

O endpoint público **não é** o token interno do provider — são dois valores distintos e a rota traduz um no outro:

- A rota (`apps/backend/src/api/hooks/payment/[provider]/route.ts`) recebe o segmento público `"mercadopago"` em `req.params.provider` e o traduz internamente para `"mercadopago_mercadopago"` antes de emitir o evento — a URL pública nunca é repassada como está para o restante do fluxo.
- O evento `payment.webhook_received` é emitido com `provider: "mercadopago_mercadopago"`.
- O Medusa (`PaymentModuleService.getWebhookActionAndData`) resolve esse valor para o token `pp_mercadopago_mercadopago`, que é o provider já registrado no container (config id `mercadopago` + service identifier `mercadopago`).
- O banco (`payment_provider`, `region_payment_provider`, `payment_session.provider_id`, `payment.provider_id`) continua usando `pp_mercadopago_mercadopago` sem qualquer alteração — o provider interno e o token Medusa não mudaram, apenas o segmento da URL pública.
- O endpoint público antigo `/hooks/payment/mercadopago_mercadopago` **não deve mais ser usado** para o Mercado Pago depois desta alteração. Ele é citado aqui apenas como referência histórica de uma configuração anterior — não é mais o endpoint ativo.

Não fixar no código ou neste arquivo a URL temporária do túnel usado em desenvolvimento (ex.: `trycloudflare.com`). Apenas o path `/hooks/payment/mercadopago` é parte permanente da arquitetura; o host pode mudar e deve ser configurado manualmente no painel Mercado Pago a cada troca.