# CLAUDE.md

Read [AGENTS.md](./AGENTS.md) — it holds this project's directory structure, commands, conventions, and off-limits paths. Follow it for all work in this repository.

## Início de qualquer tarefa

1. Ler [docs/status.md](docs/status.md) (onde o projeto está).
2. Consultar o roteador [docs/README.md](docs/README.md) e ler **apenas** os documentos indicados para a tarefa.
3. Só então ler o código relacionado.

Papel de cada fonte:

```text
CLAUDE.md          → regras operacionais específicas do Claude Code
AGENTS.md          → instruções compartilhadas entre agentes
docs/              → documentação técnica e decisões do projeto (não é instrução)
código/testes/Git  → fonte de verdade sobre o comportamento implementado
```

O AGENTS.md veio do starter; a seção "This project" no topo dele prevalece sobre os trechos genéricos do starter. Na dúvida sobre um fato, verificar no código, nos testes e no Git.

## Projeto

Monorepo de ecommerce:

- `apps/backend` — Medusa.js 2.21.2 (upgrade de 2.20.1 validado na regressão mínima da [INV-010](docs/investigations/INV-010-medusa-2-21-2-upgrade.md); caminhos não revalidados estão nos limites dela)
- `apps/storefront` — Next.js 15
- PostgreSQL hospedado no Supabase
- Mercado: Brasil · Moeda: BRL

Respeite as versões atualmente instaladas no projeto.
Não aplicar exemplos de Medusa v1 em código Medusa v2.

## Ambiente

- WSL2 / Ubuntu
- Node.js e pnpm: usar as versões definidas no `package.json` raiz
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

Integração ativa (cartão + Pix, Orders API, webhook). Antes de qualquer mudança, ler [docs/mercadopago/invariants.md](docs/mercadopago/invariants.md).

```text
endpoint público:   /hooks/payment/mercadopago
provider interno:   mercadopago
provider token:     pp_mercadopago
```

- **Nunca** adicionar `id` ao provider em `medusa-config.ts`: isso muda o token e quebra os registros existentes ([ADR-001](docs/decisions/ADR-001-provider-identity-pp-mercadopago.md)).
- Não fixar no código nem na documentação o host temporário do túnel usado em desenvolvimento. Só o path `/hooks/payment/mercadopago` é permanente; o host é configurado manualmente no painel do Mercado Pago a cada troca.

## Documentação (`docs/`)

- Mudança de comportamento (fluxo, invariante, contrato de rota, status) atualiza o documento correspondente **na mesma alteração**. Refatoração sem mudança de comportamento não exige.
- Invariante novo ou alterado: atualizar `docs/mercadopago/invariants.md` e ter teste correspondente.
- Decisão arquitetural nova: criar ADR em `docs/decisions/`. ADR aceito não se edita (exceto correção factual); se a decisão mudar, ele é substituído por outro.
- Achado sem evidência suficiente ("efeito não validado") não vira correção direta: abrir investigação em `docs/investigations/` (achado → investigação → teste → decisão → ADR/docs → código, se necessário).
- Documentação quebrada e comentário de código que contradiz o comportamento atual: corrigir na hora.
- Ao fim de cada etapa relevante: atualizar `docs/status.md` com data e commit. Ele guarda só o estado atual; a evidência de uma execução E2E vai para a investigação de origem ou para um registro `docs/investigations/E2E-<TEMA>-<data>.md`, e o `status.md` aponta para ela.
- Investigação concluída, registro de execução e ADR aceito são histórico: não reescrevê-los para o estado atual. Evidência obtida numa versão do Medusa vale para essa versão até ser revalidada.
- Documentar só o que foi verificado, sempre indicando a origem de cada afirmação:
  - comprovado pelo código ou pelos testes no commit indicado no cabeçalho do documento: sem marcação (é o padrão);
  - comprovado pelo Git (diff ou histórico): **[commit `<hash>`]**; apenas afirmado no texto da mensagem: **[mensagem de commit `<hash>`]**;
  - evidência de banco: **[banco AAAA-MM-DD]**;
  - informação vinda de decisão ou confirmação humana: **[decisão humana AAAA-MM-DD]**;
  - hipótese ainda não validada: **[não validado]**.
- Nunca tratar como especificação algo marcado **[não validado]**. Para promover um item a fato, é preciso evidência nova, e a marcação é atualizada junto.
- Dados de banco/produção vão só para evidência ou histórico (registros e investigações em `docs/investigations/`, `docs/runbooks/`; contagens atuais em `docs/status.md`), nunca para a documentação arquitetural, salvo quando necessários para explicar uma decisão.
- Nunca registrar segredos, host de túnel, dados pessoais ou dados de cartão.
- Cada fato fica em um único documento; os outros apontam para ele. Não copiar código para a documentação.
- Se a documentação contradisser o código, o código é a verdade: corrigir o documento ou avisar.
