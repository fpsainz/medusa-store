# Documentação do projeto

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

Documentação permanente para desenvolvimento humano + IA. Comece por aqui e leia **apenas** os documentos indicados para a tarefa.

## Roteador: tarefa → o que ler

| Tarefa | Ler |
|---|---|
| Início de sessão / "onde paramos?" | [status.md](status.md) |
| Entender o sistema como um todo | [architecture.md](architecture.md) |
| Rodar, configurar ambiente, variáveis | [development.md](development.md) |
| Qualquer mudança no Mercado Pago | [mercadopago/invariants.md](mercadopago/invariants.md) + [mercadopago/README.md](mercadopago/README.md) |
| Mexer no webhook | [mercadopago/invariants.md](mercadopago/invariants.md) + [mercadopago/webhook.md](mercadopago/webhook.md) |
| Escrever/rodar testes de pagamento | [mercadopago/testing.md](mercadopago/testing.md) |
| Entender por que algo é como é | [decisions/README.md](decisions/README.md) |
| Achado sem evidência suficiente / investigação em aberto | [investigations/README.md](investigations/README.md) |
| Configurar webhook em desenvolvimento | [runbooks/dev-webhook-tunnel.md](runbooks/dev-webhook-tunnel.md) |
| Histórico da troca `pp_mercadopago_mercadopago` → `pp_mercadopago` | [runbooks/provider-id-migration.md](runbooks/provider-id-migration.md) |

Comandos genéricos do monorepo (dev, build, lint, test, db) estão em [../AGENTS.md](../AGENTS.md) e não são repetidos aqui.

## Convenções

**Cabeçalho obrigatório** em todo documento:

```text
> Status: vigente | em revisão | obsoleto · Última verificação: AAAA-MM-DD · Commit: <hash>
```

**O que o hash do cabeçalho significa.** `Commit` é o **último commit de código revisado**: o estado do código e dos testes contra o qual o documento foi conferido na data de `Última verificação`. Não é o commit que criou o documento nem o que o modificou por último.

- Atualizar o hash (e a data) **somente** quando o conteúdo do documento for conferido de novo contra o código, usando o commit de código que foi efetivamente lido.
- Commits que só alteram documentação **não** exigem atualizar o hash. Por isso não existe o ciclo "commit → atualiza hash → novo commit": o hash aponta para código, não para o próprio documento.
- Um documento com hash antigo não está necessariamente errado. Ele indica até onde foi conferido; mudanças de código depois desse commit ainda não foram revisadas nele.

**Fonte das afirmações.** Salvo marcação em contrário, o conteúdo foi verificado no código e nos testes no commit do cabeçalho. Marcações usadas:

- **[não validado]** — hipótese ou algo não confirmado; não tratar como fato.
- **[banco AAAA-MM-DD]** — obtido por consulta read-only ao banco na data indicada; é um retrato, não um valor permanente.
- **[commit `<hash>`]** — comprovado pelo Git: conteúdo/diff do commit ou histórico.
- **[mensagem de commit `<hash>`]** — apenas afirmado no texto da mensagem, sem verificação independente (por exemplo, "E2E validado").
- **[decisão humana AAAA-MM-DD]** — decisão ou confirmação dada pelo responsável do projeto na data indicada, sem evidência no código/Git.

Um item **[não validado]** nunca é especificação. Ele só passa a fato com evidência nova, e a marcação é atualizada junto.

**Dados de banco/produção** pertencem a evidências ou histórico (`status.md`, `runbooks/`), não à documentação arquitetural (`architecture.md`, `mercadopago/`, `decisions/`), salvo quando forem necessários para explicar uma decisão. Contagens brutas ficam em um único lugar; os demais documentos apontam para ele.

**Referências a código** usam caminho de arquivo e nome de função, não trechos copiados. O código é a fonte da verdade: se um documento contradisser o código, corrija o documento.

## Glossário

| Termo | Significado neste projeto |
|---|---|
| Payment Session | Registro Medusa (`payment_session`) que guarda em `data` o estado da cobrança no Mercado Pago (campos `mercadopago_*`). |
| Payment | Registro Medusa criado quando a session é autorizada. |
| Order (Medusa) | Pedido criado pelo `completeCart`. |
| Order (Mercado Pago) | Cobrança criada na Orders API (`/v1/orders`). Correlacionada ao cart por `external_reference = cart_id`. |
| Provider token | Identificador `pp_<identifier>[_<id>]` registrado pelo módulo de pagamento. Aqui: `pp_mercadopago`. |
| Pix charge | Order Mercado Pago com `payment_method.id = 'pix'`, com QR/copia-e-cola/ticket. |
| Display status | Status de apresentação do Pix (`PixDisplayStatus`), derivado dos status nativos do Mercado Pago. Não é status Medusa. |
