# Documentação do projeto

> Status: vigente · Última verificação: 2026-10-01 · Commit: `bdefe51`

Documentação permanente para desenvolvimento humano + IA. Comece por aqui e leia **apenas** os documentos indicados para a tarefa. Baseline atual e validade da evidência: [status.md](status.md#baseline).

## Responsabilidades

| Documento | Responde | Não contém |
|---|---|---|
| [../AGENTS.md](../AGENTS.md) | regras gerais para qualquer agente: comandos, estilo, convenções, áreas proibidas | estado do projeto, Mercado Pago |
| [../CLAUDE.md](../CLAUDE.md) | regras operacionais do Claude Code: banco, segredos, Mercado Pago, manutenção de `docs/` | conhecimento técnico (aponta para cá) |
| [status.md](status.md) | onde o projeto está **agora**: baseline, próxima ação, matriz de evidências, pendências abertas, dívida técnica | explicação de INV/ADR, evidência detalhada, histórico |
| [architecture.md](architecture.md), [development.md](development.md) | visão do sistema; ambiente, versões, variáveis | Mercado Pago em detalhe |
| [mercadopago/](mercadopago/README.md) | comportamento **atual** da integração: fluxos, invariantes, webhook, testes | histórico de como se chegou lá |
| [decisions/](decisions/README.md) | **por que** algo é como é (ADRs) | estado atual da implementação |
| [investigations/](investigations/README.md) | hipóteses, evidências, testes e conclusões (INVs) e registros de execução E2E | especificação: uma investigação concluída não é a regra atual |
| [runbooks/](runbooks/dev-webhook-tunnel.md) | procedimentos operacionais | — |
| código, testes, Git | autoridade sobre o comportamento implementado | — |

## Roteador: tarefa → o que ler

| Tarefa | Ler | Não precisa ler |
|---|---|---|
| Início de sessão / "onde paramos?" | [status.md](status.md) | INVs e ADRs, até uma pendência apontar para eles |
| Entender o sistema como um todo | [architecture.md](architecture.md) | investigações |
| Rodar, configurar ambiente, variáveis, versões | [development.md](development.md) | `mercadopago/` |
| Qualquer mudança no Mercado Pago | [mercadopago/invariants.md](mercadopago/invariants.md) + a seção de [mercadopago/README.md](mercadopago/README.md) do fluxo afetado + o ADR do tema (mapa abaixo) | INVs concluídas, salvo para entender um invariante |
| Mexer no webhook | [mercadopago/invariants.md](mercadopago/invariants.md#webhook) + [mercadopago/webhook.md](mercadopago/webhook.md) | registros E2E |
| Escrever/rodar testes de pagamento | [mercadopago/testing.md](mercadopago/testing.md) | — |
| Mudança que depende do comportamento do core do Medusa | [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#impacto-nos-documentos) antes de confiar em afirmações sobre o core 2.20.1 | — |
| Entender por que algo é como é | [decisions/README.md](decisions/README.md) → o ADR | a INV de origem, salvo se o ADR não bastar |
| Achado sem evidência suficiente / investigação em aberto | [investigations/README.md](investigations/README.md) | — |
| Procurar evidência histórica (pedido #N, Order sandbox, data) | a coluna "Onde está a evidência" da [matriz](status.md#matriz-de-evidências) → o registro ou a INV | o resto da INV |
| Configurar webhook em desenvolvimento | [runbooks/dev-webhook-tunnel.md](runbooks/dev-webhook-tunnel.md) | — |
| Histórico da troca `pp_mercadopago_mercadopago` → `pp_mercadopago` | [runbooks/provider-id-migration.md](runbooks/provider-id-migration.md) | — |

Comandos genéricos do monorepo (dev, build, lint, test, db) estão em [../AGENTS.md](../AGENTS.md) e não são repetidos aqui.

## Mapa por tema

Comportamento atual → decisão → investigação/evidência. Ler da esquerda para a direita e parar quando a pergunta estiver respondida.

| Tema | Comportamento atual | Decisão | Investigação / evidência |
|---|---|---|---|
| Identidade do provider (`pp_mercadopago`) | [README](mercadopago/README.md#identidade-do-provider), [invariantes](mercadopago/invariants.md#identidade) | [ADR-001](decisions/ADR-001-provider-identity-pp-mercadopago.md) | [runbook](runbooks/provider-id-migration.md) |
| Cartão: tipo (crédito/débito) | [invariantes](mercadopago/invariants.md#tipo-do-cartão) | [ADR-005](decisions/ADR-005-card-payment-type-from-brick.md) | [INV-001](investigations/INV-001-debit-card-sent-as-credit-card.md) |
| Cartão: idempotency key | [invariantes](mercadopago/invariants.md) (47, 48) | [ADR-014](decisions/ADR-014-card-order-idempotency-key-from-body.md) | [INV-008](investigations/INV-008-card-idempotency-key-per-session.md) |
| Cartão: tentativa ambígua e prazo | [README](mercadopago/README.md#prazo-da-tentativa-de-cartão-implementação-atual), [invariantes](mercadopago/invariants.md#tentativa-de-cartão-depois-do-prazo) | [ADR-015](decisions/ADR-015-card-ambiguous-order-reconciliation.md) (em parte substituído), [ADR-016](decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md) | [INV-009](investigations/INV-009-card-ambiguous-order-reconciliation.md), [E2E-CARD-ATTEMPT-DEADLINE](investigations/E2E-CARD-ATTEMPT-DEADLINE-2026-09-30.md) |
| Pix: criação na Review, payer | [README](mercadopago/README.md#fluxo-pix), [invariantes](mercadopago/invariants.md#pix) | [ADR-003](decisions/ADR-003-pix-charge-created-at-review.md), [ADR-010](decisions/ADR-010-pix-payer-name-from-billing-address.md) | [INV-003](investigations/INV-003-pix-sandbox-approval.md), [E2E-B-PRIME](investigations/E2E-B-PRIME-2026-09-29.md), [E2E-B](investigations/E2E-B-2026-09-29.md) |
| Pix depois do checkout (capability, janela) | [invariantes](mercadopago/invariants.md#capability-de-pagamento-paymentaccess) | [ADR-007](decisions/ADR-007-payment-access-capability-for-pix.md), [ADR-008](decisions/ADR-008-pix-payment-window-hides-artifacts.md), [ADR-009](decisions/ADR-009-payment-access-keeps-provider-status.md) | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#capability-de-pagamento-adr-007) |
| Webhook | [webhook.md](mercadopago/webhook.md) | [ADR-004](decisions/ADR-004-webhook-hmac-lowercase-data-id.md) | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#webhook-real-depois-do-hardening-2026-09-27-código-3a56150) |
| Captura | [invariantes](mercadopago/invariants.md#captura) | [ADR-002](decisions/ADR-002-orders-api-automatic-capture.md) | — |
| Exposição de dados na Store API | [invariantes](mercadopago/invariants.md#exposição-de-dados-ao-storefront) | [ADR-006](decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md) | [E2E-SANDBOX-2026-09-27](investigations/E2E-SANDBOX-2026-09-27.md#store-api-antes-e-depois-do-adr-006-2026-09-27), [INV-002](investigations/INV-002-store-order-retrieve-without-auth.md) |
| Reembolso | [invariantes](mercadopago/invariants.md#reembolso) | [ADR-011](decisions/ADR-011-mercadopago-refund-contract.md) | [INV-004](investigations/INV-004-refund-payment-amount-and-idempotency.md) |
| Cancelamento do pedido | [invariantes](mercadopago/invariants.md#cancelamento-do-pedido) | [ADR-013](decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md) (substitui em parte o [ADR-012](decisions/ADR-012-cancel-pending-pix-on-order-cancel.md)) | [INV-005](investigations/INV-005-cancel-order-with-pending-pix.md), [INV-006](investigations/INV-006-payment-collection-rollback.md) |
| `cancelPayment` | [invariantes](mercadopago/invariants.md#cancelamento-do-pagamento) | — | [E2E-CANCEL-PAYMENT](investigations/E2E-CANCEL-PAYMENT-2026-09-30.md) |
| Botão de pagamento do checkout | — | — | [INV-007](investigations/INV-007-payment-button-first-session.md) |
| Versão do Medusa / comportamento do core | [development.md](development.md#ambiente) | — | [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md) |

## Regras de navegação

- **Estado atual vs. histórico.** O comportamento atual está em `mercadopago/` e no código. INVs e registros E2E contam como se chegou lá; não usá-los como especificação.
- **ADR substituído.** Ler o substituto primeiro; o antigo só para o contexto que o substituto declara manter.
- **Documentos grandes.** INV-009 (~1800 linhas) e ADR-016 (~450 linhas) devem ser lidos pela seção indicada no link, nunca inteiros. Para localizar uma seção: `grep -n '^##' <arquivo>`.
- **Versão.** Afirmações marcadas **[core 2.20.1]** ou **[código 2.20.1]**, e todo E2E até 2026-09-30, foram obtidos no Medusa 2.20.1. Antes de usá-las no baseline atual, conferir a [INV-010](investigations/INV-010-medusa-2-21-2-upgrade.md#impacto-nos-documentos).
- **Cabeçalho antigo.** Um `Commit` antigo no cabeçalho indica até onde o documento foi conferido, não que esteja errado (ver Convenções). Na dúvida, verificar no código.
- **Quando parar.** Se o invariante e o README respondem à pergunta, não abrir o ADR; se o ADR responde, não abrir a INV.

## Convenções

**Cabeçalho obrigatório** em todo documento:

```text
> Status: vigente | em revisão | obsoleto · Última verificação: AAAA-MM-DD · Commit: <hash>
```

Investigações, registros de execução e ADRs usam o cabeçalho dos modelos em [investigations/README.md](investigations/README.md) e [decisions/README.md](decisions/README.md).

**O que o hash do cabeçalho significa.** `Commit` é o **último commit de código revisado**: o estado do código e dos testes contra o qual o documento foi conferido na data de `Última verificação`. Não é o commit que criou o documento nem o que o modificou por último.

- Atualizar o hash (e a data) **somente** quando o conteúdo do documento for conferido de novo contra o código, usando o commit de código que foi efetivamente lido.
- Commits que só alteram documentação **não** exigem atualizar o hash. Por isso não existe o ciclo "commit → atualiza hash → novo commit": o hash aponta para código, não para o próprio documento.
- Um documento com hash antigo não está necessariamente errado. Ele indica até onde foi conferido; mudanças de código depois desse commit ainda não foram revisadas nele.

**Fonte das afirmações.** Salvo marcação em contrário, o conteúdo foi verificado no código e nos testes no commit do cabeçalho. Marcações usadas:

- **[não validado]**: hipótese ou algo não confirmado; não tratar como fato.
- **[banco AAAA-MM-DD]**: obtido por consulta read-only ao banco na data indicada; é um retrato, não um valor permanente.
- **[commit `<hash>`]**: comprovado pelo Git: conteúdo/diff do commit ou histórico.
- **[mensagem de commit `<hash>`]**: apenas afirmado no texto da mensagem, sem verificação independente (por exemplo, "E2E validado").
- **[decisão humana AAAA-MM-DD]**: decisão ou confirmação dada pelo responsável do projeto na data indicada, sem evidência no código/Git.
- **[core X.Y.Z]** (ou **[código X.Y.Z]**): lido no código do Medusa X.Y.Z instalado em `node_modules`; vale para essa versão.
- **[sandbox AAAA-MM-DD]**: observado na Orders API sandbox do Mercado Pago na data indicada.
- **[MCP AAAA-MM-DD]**: documentação oficial ou dados da conta de teste consultados pelo MCP do Mercado Pago na data indicada.

Um item **[não validado]** nunca é especificação. Ele só passa a fato com evidência nova, e a marcação é atualizada junto.

**Dados de banco/produção** pertencem a evidências ou histórico (registros de execução em `investigations/`, `runbooks/`, e contagens atuais em `status.md`), não à documentação arquitetural (`architecture.md`, `mercadopago/`, `decisions/`), salvo quando forem necessários para explicar uma decisão. Contagens brutas ficam em um único lugar; os demais documentos apontam para ele.

**Referências a código** usam caminho de arquivo e nome de função, não trechos copiados. O código é a fonte da verdade: se um documento contradisser o código, corrija o documento.

## Glossário

| Termo | Significado neste projeto |
|---|---|
| Payment Session | Registro Medusa (`payment_session`) que guarda em `data` o estado da cobrança no Mercado Pago (campos `mercadopago_*`). |
| Payment | Registro Medusa criado quando a session é autorizada. |
| Order (Medusa) | Pedido criado pelo `completeCart`. |
| Order (Mercado Pago) | Cobrança criada na Orders API (`/v1/orders`). No Pix, `external_reference = cart_id`; no cartão, `<cart_id>-<ULID da tentativa>` (ADR-015). |
| Tentativa de cartão | Registro `mercadopago_card_attempt` (`mpca_<ULID>`) do módulo `mercadopagoCardAttempt`, com o token cifrado e o estado da autorização (ADR-015, ADR-016). |
| Registro de execução | Arquivo `investigations/E2E-<TEMA>-<data>.md`: o que foi executado e observado numa data, fora da numeração `INV`. |
| Provider token | Identificador `pp_<identifier>[_<id>]` registrado pelo módulo de pagamento. Aqui: `pp_mercadopago`. |
| Pix charge | Order Mercado Pago com `payment_method.id = 'pix'`, com QR/copia-e-cola/ticket. |
| Display status | Status de apresentação do Pix (`PixDisplayStatus`), derivado dos status nativos do Mercado Pago. Não é status Medusa. |
