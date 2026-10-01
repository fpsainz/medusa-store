# ADR-016: O prazo da tentativa de cartão controla replay e retenção do CardToken, não o fim da tentativa; tentativa ambígua depois do prazo é resolvida pela busca da Order

> Status: **aceito** em 2026-09-30 [decisão humana 2026-09-30]; implementado no working tree sobre `e822f52` (sem commit), com `H` sem valor aprovado (liberação por `total = 0` desligada) · Data: 2026-09-30 · Revisado: 2026-09-30 (valores de `Q`, margem, semântica de `H`, risco de falso negativo, `expired`, limpeza, contrato do storefront: seção 11) · Commits: nenhum ainda · Código revisado: working tree sobre `e822f52`

Substitui **em parte** o [ADR-015](ADR-015-card-ambiguous-order-reconciliation.md): só a interpretação do prazo (`created_at + 24 h`, decisão 12) como fim funcional da tentativa, e as consequências que dependem dela. O restante do ADR-015 continua válido (seção 10). A [INV-009](../investigations/INV-009-card-ambiguous-order-reconciliation.md) não é reaberta.

Marcadores próprios deste documento:
- **[doc oficial 2026-09-29]**, **[sandbox 2026-09-29]**: como definidos na INV-009;
- as regras numeradas (1–12) são as da [tabela de transições da INV-009](../investigations/INV-009-card-ambiguous-order-reconciliation.md#3a-transições), implementadas em `mercadopago-card-attempt/transitions.ts`.

**Decisão central:** o prazo de 24 h deixa de ser o fim funcional da Payment Attempt. Ele passa a controlar só o replay e a decifração, e a retenção do CardToken. Uma tentativa ambígua só libera um novo pagamento depois que o destino da Order anterior for determinado com segurança.

## 1. Contexto

- O ADR-015 criou a tentativa de cartão (`mercadopago_card_attempt`): token cifrado, `external_reference = <cart_id>-<attempt_id>`, replay idempotente (H1) e fallback do webhook (H7).
- A decisão 12 do ADR-015 usa um prazo único, `created_at + 24 h`, para replay, decifração, destruição do token **e** expiração. Passado o prazo, a tentativa aberta vira `expired` e o caso vai para tratamento manual.
- Implementação atual:
  - a expiração é lazy: `expireIfPastDeadline` (regras 10 e 2) só roda num Place order depois do prazo, via `readCardToken`/`resumeAuthorization`;
  - não há job, então uma tentativa `unknown` abandonada mantém o ciphertext além do prazo;
  - o webhook resolve uma tentativa `unknown` paga mesmo depois do prazo (fallback + regra 12). Uma vez `expired`, o fallback a recusa (Order paga → 503), e só o operador a resolve (regra 11).
- O item 14 de [status.md](../status.md) registra o conflito:
  - garantir a destruição em 24 h com um job que grava contradiz a decisão 11 do ADR-015 ("o job só lê e alerta");
  - expirar a tentativa impede a resolução tardia pelo webhook.
- O CardToken e a retenção:
  - o CardToken é de uso único, e cada nova tentativa tokeniza de novo;
  - o limite de 24 h para guardar o CardToken **não** é requisito oficial do Mercado Pago. É uma política do projeto [decisão humana 2026-09-30];
  - o limite do replay vem da retenção da idempotency key, que não foi validada (H2 [não validado]).
- A busca de Orders:
  - `GET /v1/orders` exige `begin_date`/`end_date` e aceita `external_reference`; a resposta é `{ data[], paging }` [doc oficial 2026-09-29];
  - **não documentados:** consistência/atraso de indexação, retenção e janela máxima de datas [doc oficial 2026-09-29];
  - observado no sandbox: filtro por igualdade exata, com atraso de indexação (0 resultados em ~1 s, 1 em ~36 s) [sandbox 2026-09-29].

## 2. Problema

1. **Retenção e lifecycle funcional estão acoplados.** Cumprir a retenção do ciphertext obriga a mudar o estado funcional (`expired`). Isso:
   - bloqueia o cart até um operador agir;
   - impede a resolução tardia pelo webhook;
   - exige um job que grava estado.
2. **O cliente que volta depois do prazo não consegue pagar sem operador,** mesmo quando o Mercado Pago permite determinar o destino da tentativa anterior.
3. **Liberar só porque o token foi destruído não é seguro.** A Order da tentativa antiga pode existir e estar paga, e uma nova tentativa geraria uma segunda cobrança.

## 3. Decisão

1. **O prazo (`created_at + 24 h`) controla só:**
   - o replay e a decifração (sem mudança: limitados por H2);
   - a retenção do ciphertext.

   **O prazo, por si só, não executa nenhuma transição funcional**, em nenhum estado.
2. **Retenção separada do lifecycle.** Depois do prazo, o ciphertext pode ser destruído sem mudar `state`.
   - É política de retenção, não lifecycle da Payment Attempt.
   - A destruição nunca impede a reconciliação pelo webhook (fallback + regra 12), que não usa o token.
3. **Cart e CardToken têm lifecycles independentes.** O Cart continua disponível. Um novo pagamento sempre usa uma **nova** tentativa, com:
   - novo CardToken;
   - novo `card_attempt_id`;
   - novo `external_reference`;
   - novo body;
   - nova idempotency key (fórmula do ADR-014, sem mudança).

   Nada da tentativa anterior é reutilizado.
4. **Resolver a tentativa antiga e criar uma nova são operações distintas.**
   - A resolução nunca autoriza um cartão novo.
   - Uma nova tentativa só nasce depois que a antiga estiver terminal **e** o cliente enviar o Brick de novo.
   - Nenhuma nova tentativa é criada enquanto a antiga estiver ambígua/bloqueante.
5. **Destruir o token não libera o pagamento.** Uma tentativa ambígua depois do prazo só libera um novo pagamento quando o destino da Order anterior é determinado por consulta ao Mercado Pago:
   - Order paga → reconciliar pelo mecanismo existente e concluir o Cart com essa Order;
   - Order `failed`/`canceled` → encerrar a tentativa (regra 9);
   - nenhuma Order confirmada, com todas as pré-condições (seção 4.3) atendidas → encerrar a tentativa pela transição atômica `unknown → failed` sem Order (seção 4.4).
6. **Erro ou ambiguidade nunca vira "Order inexistente".** Qualquer resultado não conclusivo mantém a tentativa bloqueada (seção 4.3).
7. **A resolução depois do prazo só lê.** Ela usa só a busca e `GET /v1/orders/{id}`. Não faz `POST /v1/orders`, não faz nova autorização e não cria tentativa.
8. **Nenhum estado novo.** Uma transição nova (`unknown → failed` sem Order), com precondição estrita, e o fim do disparo da regra 10 pelo prazo.
9. **A liberação não depende de job.** Ela acontece quando o cliente volta. Não existe job de expiração funcional.
10. **Risco residual aceito, não garantia.** O Mercado Pago não documenta garantia de consistência da busca, então existe risco de falso negativo. Tratar `total = 0` como "nenhuma Order confirmada" é um risco aceito **só** sob as condições deste ADR (seção 7). Não é uma garantia do Mercado Pago.
11. **A liberação por `total = 0` fica desligada até `H` ser validado** (seção 4.3). Os caminhos com Order encontrada (paga, `failed`/`canceled`) não dependem de `H` e funcionam desde a implementação.
12. **Tentativas já `expired` continuam na regra 11 (operador).** Não entram no resolvedor.
13. **A limpeza periódica do ciphertext não faz parte desta implementação.** Fica para uma decisão posterior de retenção. Nesta implementação, a destruição por retenção acontece só quando a tentativa é tocada pelo Place order depois do prazo.
14. **O storefront recebe um contrato mínimo** (seção 4.6): reenviar o Brick só quando a tentativa antiga está terminal, e numa Payment Session `pending` (depois da regra 9, numa **nova** Payment Session); nos demais casos, aguardar ou encaminhar para suporte.

## 4. Comportamento detalhado

### 4.1 Antes do prazo (sem mudança)

Continua como no ADR-015:
- `unknown`: replay com a mesma chave e o mesmo body (regra 4);
- `authorizing` recente: `card_attempt_in_progress`;
- `authorizing` parada há mais de 5 min: retomada (regra 5);
- Order já registrada na tentativa: só `GET` (`settleKnownCardOrder`).

**A busca nunca é usada antes do prazo:** o replay é determinístico (H1), a busca não.

### 4.2 Depois do prazo: retenção (nenhuma transição)

```text
prazo vencido
  ↓
o ciphertext pode ser destruído (encrypted_card_token = NULL, token_destroyed_at)
  ↓
state não muda
```

| Estado | Efeito do prazo |
|---|---|
| `submitted` | **nenhuma transição.** Ainda não houve `POST` (a regra 3 grava `authorizing` antes dele), então não há ambiguidade de Order criada. O ciphertext pode ser destruído por retenção. A tentativa continua `submitted` até uma nova submissão válida do Brick substituí-la (regra 2) ou a session ser removida. Um Place order sobre ela não obtém o token (a decifração é recusada depois do prazo) e exige nova submissão. |
| `authorizing`, `unknown` | **nenhuma transição.** O ciphertext pode ser destruído por retenção. A tentativa continua bloqueante até ser resolvida (4.3) ou pelo webhook. |
| terminais, `expired` | já sem token |

A destruição por retenção é um `UPDATE` condicional e idempotente, como `buildDestroyTokenStatement`, ampliado para estados que guardam token depois do prazo. Ele só toca `encrypted_card_token`, `token_destroyed_at` e `updated_at`. Nunca toca `state`, `mercadopago_order_id` ou `ended_at`.

**Nesta implementação**, a destruição por retenção é lazy: acontece quando um Place order toca a tentativa depois do prazo, antes da resolução (4.3), qualquer que seja o resultado dela.

**Limpeza periódica** do ciphertext de tentativas abandonadas (o cliente nunca volta): **fora desta implementação**, e fica para uma decisão posterior de retenção (seção 11). Até lá, esse ciphertext continua guardado, cifrado com a chave fora do banco e sem decifração possível depois do prazo. A divergência com a política de 24 h continua registrada em `status.md` (item 14). Se a limpeza existir, executa só esta destruição e nunca muda o estado funcional. A decisão 11 do ADR-015 continua valendo para reconciliação: um job de reconciliação só lê e alerta.

### 4.3 Depois do prazo: resolução da tentativa antiga

**Fluxo de retorno do cliente:**

```text
Place order depois do prazo
        ↓
resolver a tentativa antiga (só busca + GET; nenhum POST)
        ↓
┌─────────────────┬───────────────────────┬──────────────────────────┬────────────────────┐
│ Order paga      │ Order failed/canceled │ total = 0 com todas as   │ qualquer outro     │
│                 │                       │ pré-condições            │ resultado          │
↓                 ↓                       ↓                          ↓
recordOrder +     recordOrder +           unknown → failed           nenhuma escrita;
settleKnownCard-  regra 9                 sem Order (4.4)            continua bloqueada
Order + regra 12
↓                 └──────────┬────────────┘
Cart concluído               ↓
com a Order        tentativa antiga terminal
existente                    ↓
                   o Place order atual termina e NÃO autoriza um cartão novo
                             ↓
                   regra 9: a Payment Session fica `error` → o storefront
                   inicia uma NOVA Payment Session (initiatePaymentSession,
                   POST /store/payment-collections/:id/payment-sessions)
                   regra 13: a Payment Session continua `pending`
                             ↓
                   o cliente envia o Brick de novo, na session `pending`
                             ↓
                   nova tentativa (regra 1) + novo CardToken
                   (novo card_attempt_id, external_reference, body e idempotency key)
                             ↓
                   novo Place order
```

A liberação do Cart **não** significa que o mesmo Place order continue com um cartão novo.

**Payment Session depois da regra 9.** O provider resolve a Order `failed`/`canceled` pelo caminho existente (`settleKnownCardOrder`), que devolve `status: error` ao core. O Payment Module grava a session como `error` e recusa a autorização (`NOT_ALLOWED`, "Session … was not authorized with the provider"); a rota `complete` responde 400. Uma session `error` não é processável pelo `completeCartWorkflow` (`validateCartPaymentsStep` só aceita `pending`, `requires_more`, `authorized`, `captured` e `pending_authorization`) e **nunca é reutilizada**: um Brick enviado a ela cria uma tentativa que o Place order não alcança ("Payment sessions are required to complete cart") [sandbox 2026-09-30]. O novo pagamento usa o lifecycle normal do Medusa:
1. o storefront chama `initiatePaymentSession` (`POST /store/payment-collections/:id/payment-sessions`, `createPaymentSessionsWorkflow`);
2. o core remove a session antiga, chamando o `deletePayment` do provider, que aceita a tentativa `failed` sem mudança (estado terminal);
3. a nova session nasce `pending`, e só então o novo Brick cria a nova tentativa.

Comprovado no E2E 2b [sandbox 2026-10-01]: session antiga `error` removida, nova session `pending`, nova tentativa, 1 `POST` com chave e body novos, 1 Payment, 1 Capture e 1 pedido Medusa. Na regra 13 (pelo código; não exercitada em runtime, porque `H = null`) o provider lança um erro simples: a session não é alterada e continua `pending`, e o core responde 200 `PAYMENT_AUTHORIZATION_ERROR`.

**Ponto de entrada:** o Place order (`authorizePayment` do provider, dono das regras 3/4/5 pela opção B do ADR-015). Condições: tentativa `unknown`, ou `authorizing` parada, sem `mercadopago_order_id` e com o prazo vencido. Com `mercadopago_order_id` já registrado, o caminho existente (`settleKnownCardOrder`) é usado, sem busca.

**Pré-condições da busca (todas obrigatórias):**
- `authorizing` recente (menos de 5 min desde `authorizing_at`) **não** é sondada: responde `card_attempt_in_progress`;
- `authorizing` parada passa antes a `unknown` pela regra 8 (compare-and-set);
- **`Q`, período de quietude: 30 min.** Condição: `authorizing_at < now() − 30 min`, onde `authorizing_at` é o início do último `POST`.
  - `Q` impede a sondagem enquanto um `POST` ainda possa estar em andamento, ou enquanto a indexação da busca possa razoavelmente não ter acontecido.
  - Justificativa: é ~7× o pior caso do SDK (~247 s, 4 tentativas) e ~50× o atraso de indexação observado (~36 s [sandbox 2026-09-29]), e 6× o limite de `authorizing` parada (5 min).
  - Custo baixo: `Q` só atrasa quem volta menos de 30 min depois de um replay feito perto do prazo.
  - Residual: a distribuição do atraso de indexação em produção é desconhecida; 36 s é uma observação única no sandbox, não um limite.
- **`H`, horizonte da evidência negativa.**
  - **Semântica:** `total = 0` só pode liberar a tentativa se `now() − authorizing_at < H`, ou seja, se a Order procurada (que teria sido criada até ~247 s depois de `authorizing_at`) tiver menos de `H` de idade.
  - `H` é o maior intervalo em que há evidência de que a busca exata por `external_reference` ainda devolve uma Order existente. Ele limita o risco da retenção da busca, que não é documentada.
  - Não se aplica aos resultados com Order encontrada: uma Order devolvida é evidência positiva em qualquer idade.
  - **Valor: decisão posterior, condicionada a evidência.** Não há evidência hoje de que a busca devolva Orders com mais de ~36 s. Até existir, **a liberação por `total = 0` fica desligada**: um `total = 0` válido responde `card_attempt_manual_review` e não escreve nada.
  - **Como fixar `H`:** uma validação read-only no sandbox. Buscar com `external_reference` exato Orders conhecidas das E2E da INV-009 (criadas em 2026-09-29/30) em idades crescentes; `H` não pode passar da maior idade em que **todas** foram devolvidas. Para ter utilidade, `H` precisa de observações com mais de 24 h: a busca acontece depois do prazo, e o `POST` costuma ocorrer logo depois de `created_at`.
  - Mesmo validado, `H` é evidência de sandbox, não garantia de produção.
  - Além de `H`, a tentativa continua bloqueada (`card_attempt_manual_review`) e exige tratamento manual.

**Busca:**
1. `GET /v1/orders` com o `external_reference` **exato** da tentativa.
2. Janela de datas derivada da tentativa, com **margem de 1 h** nas duas pontas, em RFC 3339 UTC:
   - `begin_date = authorization_started_at − 1 h`;
   - `end_date = min(now(), authorizing_at + 1 h)`.
   - O primeiro `POST` começa em `authorization_started_at` e o último em `authorizing_at`; o SDK pode ainda criar a Order até ~247 s depois. A janela cobre esses instantes, independentemente de quando o cliente volta, e tem no máximo ~26 h.
   - A margem cobre a diferença entre o relógio do PostgreSQL (que grava `authorizing_at`) e o do Mercado Pago (data da Order), além dos ~247 s do SDK no fim da janela. 1 h é folga larga sobre segundos de diferença de relógio (NTP) e sobre os 247 s, e não custa nada: o filtro exato por `external_reference` torna os resultados independentes da largura da janela.
   - **[não validado]:** qual campo de data o filtro usa, se a API aceita uma janela de ~26 h e qual a janela máxima. Uma recusa da API (ex.: 400) é resultado não conclusivo e mantém a tentativa bloqueada.
3. Validar `paging.total`: presente e inteiro não negativo.
4. Exigir coerência com `data`: `total = data.length`, e todo item com `external_reference` idêntico ao da tentativa.
5. `total = 1` → `GET /v1/orders/{id}`.
6. Conferir na Order lida:
   - `external_reference` idêntico ao da tentativa;
   - valor igual ao `amount` da session (a mesma regra do fallback do webhook);
   - e o que `settleKnownCardOrder` já exige (payment presente).
7. Qualquer divergência → bloqueado.

**Resultados que mantêm a tentativa bloqueada** (nenhuma escrita além da associação de uma Order em status não final).

*Transitórios* (responde `card_attempt_pending`; o cliente pode tentar de novo):
- timeout;
- 429;
- 5xx;
- recusa da API à janela;
- resposta estruturalmente inválida;
- `paging.total` ausente ou não numérico;
- `total ≠ data.length`;
- `Q` ainda não atingido;
- 1 Order em status não final (associada à tentativa pelo caminho existente, que continua bloqueante até o status final).

*Persistentes* (responde `card_attempt_manual_review`):
- `total > 1`;
- `external_reference` divergente;
- valor divergente;
- `total = 0` além de `H`, ou com `H` ainda não validado.

Qualquer outro resultado não conclusivo é tratado como transitório.

**`total = 0`** só vale como "nenhuma Order confirmada" quando **todas** as pré-condições acima estiverem atendidas (incluindo `H` validado) e a resposta for estruturalmente válida. Mesmo assim, é evidência aceita sob risco (seção 7), não prova de ausência.

**Resultados conclusivos:**

| Resultado | Escritas (todas por compare-and-set) | Efeito |
|---|---|---|
| 1 Order paga | `recordOrder` (`mercadopago_order_id IS NULL`, índice único), depois `settleKnownCardOrder` (`GET`) → regra 12 | o Cart é concluído com a Order existente; nenhum `POST` |
| 1 Order `failed`/`canceled` | `recordOrder` → regra 9 (`unknown → failed`) | tentativa terminal; Payment Session `error`; o storefront inicia uma nova Payment Session e o cliente envia o Brick de novo nela |
| `total = 0` sob todas as pré-condições | `unknown → failed` sem Order (4.4) | tentativa terminal; o cliente precisa enviar o Brick de novo |

### 4.4 Transição atômica `unknown → failed` sem Order (regra 13)

Nova transição, sem estado novo, executada num único compare-and-set:

```text
UPDATE mercadopago_card_attempt
SET state = 'failed',
    last_error_class = 'order_not_found_after_deadline',
    ended_at = now(), updated_at = now(),
    encrypted_card_token = NULL,
    token_destroyed_at = COALESCE(token_destroyed_at, now())
WHERE id = ? AND deleted_at IS NULL
  AND state = 'unknown'
  AND mercadopago_order_id IS NULL
  AND <prazo vencido>
  AND authorizing_at < now() - Q
RETURNING id
```

(Esboço da semântica, não código: as condições seguem o padrão de `buildTransitionStatement`.)

- Só é executada depois de uma busca com `total = 0` que atendeu todas as pré-condições da seção 4.3.
- **`mercadopago_order_id IS NULL`** fecha a corrida com o webhook. Se o webhook associar uma Order (`recordOrder`) entre a busca e o encerramento, o `UPDATE` afeta 0 linhas e a tentativa segue pela Order registrada.
- **Atomicidade:** estado terminal, destruição do token e campos terminais na mesma instrução. Não há estado intermediário.
- **Por que não `expired → failed` (regras 10 + 11):**
  - criaria um `expired` artificial pelo processo automático;
  - um crash entre as duas instruções deixaria a tentativa em `expired`, que depende de intervenção manual;
  - as regras 10 e 11 também não conferem `mercadopago_order_id`.

  A regra 10 deixa de ser disparada pelo prazo. A regra 11 continua só para operador.

### 4.5 Concorrência

- **Os três caminhos competem pelo mesmo estado:** webhook (fallback, `recordOrder`, regras 9/12), Place order antes do prazo (regras 3–8) e resolução depois do prazo (`recordOrder`, regras 8, 9, 12, 13).
- **O compare-and-set define um único vencedor** (`UPDATE … WHERE state = … RETURNING id`).
- **0 linhas = outro caminho venceu.** O perdedor:
  - relê o estado e decide só pelo que encontra: Order registrada, estado terminal ou bloqueio;
  - **nunca** considera a busca anterior ainda válida;
  - **nunca** repete uma operação para "desfazer" o vencedor.
- **Associação da Order:** `recordOrder` só grava com `mercadopago_order_id IS NULL`, e o índice único impede a mesma Order em duas tentativas.
- **Uma tentativa viva por session:**
  - garantida pelo índice único parcial (estados vivos) e pela recusa de novo envio com tentativa bloqueante (`card_attempt_pending`);
  - a tentativa antiga não coexiste com uma nova enquanto o destino da sua Order for desconhecido;
  - o congelamento da session (decisão 8 do ADR-015) continua valendo.
- **Crash:**
  - entre a busca e a escrita: nada foi gravado, e a próxima resolução repete a busca do zero;
  - entre `recordOrder` e a regra 9/12: a tentativa fica `unknown` com Order registrada, e a próxima chamada segue `settleKnownCardOrder` (caminho existente).

  Nenhum caso depende de `expired`.
- **Sem transação distribuída:** como no ADR-015, a Order do Mercado Pago, o módulo da tentativa e o Payment Module não são atômicos entre si.

### 4.6 Contrato mínimo com o storefront

Usa os códigos que já existem (`CARD_ATTEMPT_ERROR_CODES`, `NOT_ALLOWED` → 400 com `code` preservado); nenhum código novo. O storefront não recebe IDs nem dados da tentativa. Hoje ele não trata esses códigos: tratá-los faz parte da implementação.

**Place order** (`complete` do cart):

| Resposta | Situação | Ação do storefront |
|---|---|---|
| pedido criado | Order paga reconciliada | seguir para a confirmação |
| cart + erro de autorização de pagamento (200, como a recusa atual) | tentativa antiga terminal pela regra 13, ou `submitted` depois do prazo; a session continua `pending` | **reenviar o Brick** (novo cartão/token) na mesma session `pending` e fazer um novo Place order |
| 400 `not_allowed` ("Session … was not authorized with the provider"), session `error` | tentativa antiga terminal pela regra 9 (Order `failed`/`canceled`) | **iniciar uma nova Payment Session** (`initiatePaymentSession`), reenviar o Brick nela e fazer um novo Place order; nunca reutilizar a session `error` |
| 400 `card_attempt_in_progress` | `authorizing` recente | **aguardar** e repetir o Place order depois; não reenviar o Brick |
| 400 `card_attempt_pending` | resolução transitória/não conclusiva (4.3) | **aguardar** e repetir o Place order depois; não reenviar o Brick |
| 400 `card_attempt_conflict` | outro caminho venceu a corrida | repetir o Place order (a próxima chamada lê o novo estado) |
| 400 `card_attempt_manual_review` | resultado persistente (4.3), além de `H`, `H` não validado, ou tentativa `expired` | **não reenviar o Brick**; informar que o pagamento está em análise e encaminhar para suporte |

**Envio do Brick** (rota de update da session): `400 card_attempt_pending` ou `card_attempt_manual_review` significa que existe uma tentativa bloqueante. O storefront não repete o envio: faz o Place order (que dispara a resolução) ou segue a linha correspondente acima.

`card_token_unavailable` não pode chegar ao storefront por estes fluxos. Uma `submitted` depois do prazo responde como a linha "reenviar o Brick".

## 5. Alternativas consideradas

- **Manter a decisão 12 (prazo → `expired` → manual).** Todo retorno depois do prazo depende de operador, a resolução tardia pelo webhook se perde, e a retenção exige um job que grava estado. Rejeitada.
- **Liberar quando o token é destruído, sem consultar o Mercado Pago.** Risco de cobrança dupla. Rejeitada.
- **Só webhook, sem busca.** Sem notificação, a tentativa fica bloqueada para sempre. Rejeitada como mecanismo único; o webhook continua como caminho principal de reconciliação.
- **Replay depois do prazo.** Depende de H2 e H4 [não validado]; fora da retenção da idempotência, pode criar uma segunda Order. Rejeitada.
- **Busca antes do prazo.** A busca não é determinística; o replay é (H1). Rejeitada.
- **Busca por `external_reference = cart_id`.** Não identifica a tentativa (INV-009). Rejeitada.
- **Encerrar por `unknown → expired → failed` (regras 10 + 11 pelo sistema).** Não é atômica, cria `expired` artificial, deixa um crash dependendo de operador e não confere `mercadopago_order_id`. Rejeitada em favor da regra 13.
- **Estado novo (ex.: `abandoned`).** Os estados existentes bastam. Rejeitada.
- **Job de expiração funcional.** Contraria a separação entre retenção e lifecycle. Rejeitada.
- **Continuar o Place order atual com um cartão novo depois da liberação.** Misturaria resolução e nova tentativa, e reutilizaria o contexto de autorização da tentativa antiga. Rejeitada: a nova tentativa exige novo envio do Brick.

## 6. Consequências

- **O cliente não depende de operador quando a Order pode ser determinada.**
- **Order paga:** o Cart é concluído com a Order existente, sem nenhum `POST` nem nova cobrança.
- **Order `failed`/`canceled`, ou nenhuma Order confirmada sob as pré-condições:**
  - a tentativa antiga é encerrada, e o Place order corrente termina sem autorizar um cartão novo;
  - na regra 9 a Payment Session fica `error`: o storefront inicia uma nova Payment Session (`initiatePaymentSession`), e o core remove a antiga;
  - o cliente envia o Brick de novo, numa session `pending`, e faz um novo Place order;
  - a tentativa antiga não é reutilizada.
- **Falhas transitórias ou resultados ambíguos da busca** deixam a tentativa bloqueada. O cliente pode tentar mais tarde.
- **Até `H` ser validado, a liberação por `total = 0` não acontece:** esses casos ficam em `card_attempt_manual_review`. Com `H` validado, só além de `H`.
- **Resolução tardia pelo webhook continua possível** depois do prazo, mesmo com o ciphertext destruído.
- **`expired`** deixa de ser produzido pelo prazo. Tentativas já `expired` continuam só com o operador (regra 11).
- **Ciphertext de tentativas abandonadas** continua guardado (cifrado) até uma decisão posterior sobre limpeza periódica.
- **O storefront** passa a tratar os códigos da seção 4.6.
- **O provider passa a usar `Order.search`** (SDK 3.6.1), só depois do prazo.
- **Sem mudança em:** lógica fora de workflows (dívida já registrada em `status.md`), Pix, webhook, fórmula de idempotência (ADR-014), `cancelPayment` e reembolso.

## 7. Riscos e mitigações

| Risco | Mitigação | Residual |
|---|---|---|
| **Falso negativo da busca** (existe uma Order paga, mas a busca devolve `total = 0`) → cobrança dupla depois da nova tentativa | só depois do prazo, de `Q` (30 min) e dentro de `H` validado; liberação por `total = 0` desligada até lá; `external_reference` exato; janela que cobre todos os `POST` com margem de 1 h; resposta estruturalmente válida | **aceito sob estas condições; não impede a arquitetura; sem mitigação adicional nesta implementação.** O Mercado Pago não documenta garantia de consistência nem de retenção da busca [doc oficial 2026-09-29]; as condições reduzem a probabilidade, sem eliminá-la. Detecção existente: o webhook da Order paga encontra a tentativa `failed`, o fallback recusa com `logger.error` e 503, e o Mercado Pago reenvia. Não existe job de leitura hoje; sem entrega do webhook, a cobrança dupla só é detectada fora do sistema. Correção: operador (reembolso) |
| Retenção desconhecida da busca | `H` só com evidência; até lá, `total = 0` não libera; além de `H`, também não | tentativa bloqueada (`card_attempt_manual_review`) até tratamento manual |
| Corrida webhook × encerramento | `mercadopago_order_id IS NULL` no mesmo `UPDATE`; índice único da Order; releitura sem reaproveitar a busca | nenhum identificado |
| Sondar um `POST` em andamento ou antes da indexação | `authorizing` recente não é sondada; `Q` = 30 min | atraso de indexação em produção desconhecido (36 s é observação única no sandbox) |
| Busca com erro/429/5xx/ambígua | nenhum desses resultados libera; nenhuma escrita | o cliente espera |
| Order em status não final | associada e bloqueante | depende do webhook ou de nova consulta |
| Crash durante a resolução | escritas atômicas por compare-and-set; nenhum estado intermediário artificial | nenhum identificado |
| Janela da busca errada (relógios, semântica do filtro de data) | margem de 1 h nas duas pontas; recusa da API é não conclusiva | campo de data do filtro e janela máxima [não validado] |
| Ciphertext de tentativa abandonada (o cliente não volta) | destruição lazy no Place order (4.2); limpeza periódica é decisão posterior | o ciphertext continua cifrado, com a chave fora do banco e sem decifração depois do prazo, até ser destruído |
| Order de terceiros com o mesmo `external_reference` | `total > 1` bloqueia; valor conferido | operador |

## 8. Estratégia de testes

**Módulo (unitários e integração com a tabela real, como T1–T4):**
- regra 13, `unknown → failed` sem Order:
  - efetiva com todas as condições: estado `failed`, `last_error_class`, `ended_at`, token destruído na mesma instrução;
  - 0 linhas com `mercadopago_order_id` preenchido, antes do prazo, com `authorizing_at` dentro de `Q`, ou fora de `unknown`;
- corrida `recordOrder` (webhook) × regra 13: exatamente um vencedor, e nunca `failed` com Order registrada;
- crash simulado entre a busca e a escrita, e entre `recordOrder` e a regra 9/12: nenhuma tentativa em `expired`, e a próxima resolução conclui pelo caminho existente;
- a destruição por retenção anula o ciphertext sem mudar `state`, `ended_at` ou `mercadopago_order_id`, é idempotente e vale para `submitted`, `authorizing` e `unknown` depois do prazo;
- o prazo sozinho não executa transição nenhuma, nem em `submitted`;
- nova submissão:
  - recusada (`card_attempt_pending`) enquanto a tentativa antiga está `unknown`/`authorizing`;
  - aceita só depois da tentativa terminal.

**Provider (`authorizePayment` depois do prazo, com `Order.search`/`get` simulados):**
- Order paga → `recordOrder` + `GET` + regra 12, **zero chamadas a `POST /v1/orders`**;
- `failed`/`canceled` → regra 9;
- `total = 0` com todas as pré-condições e `H` validado → regra 13, e o Place order corrente responde como recusa (não autoriza cartão novo, nenhum `POST`);
- `total = 0` com `H` não configurado/validado → `card_attempt_manual_review`, sem escrita;
- `total = 0` além de `H` → `card_attempt_manual_review`, sem escrita;
- `total = 0` com `Q` não atingido → `card_attempt_pending`, sem escrita;
- transitórios (timeout, 429, 5xx, recusa da janela, resposta inválida, `paging` ausente, `total` não numérico, `total ≠ data.length`) → `card_attempt_pending`, sem escrita;
- persistentes (`total > 1`, `external_reference` divergente na busca ou no `GET`, valor divergente) → `card_attempt_manual_review`, sem escrita;
- janela da busca: `begin_date = authorization_started_at − 1 h`, `end_date = min(now, authorizing_at + 1 h)`;
- tentativa `expired` → `card_attempt_manual_review`, sem busca;
- `submitted` depois do prazo → resposta de recusa (reenviar o Brick), nunca `card_token_unavailable`;
- destruição lazy do ciphertext no Place order depois do prazo, em qualquer resultado da resolução;
- `authorizing` recente → `card_attempt_in_progress`, sem busca;
- `authorizing` parada → regra 8 e depois busca;
- antes do prazo → replay atual, sem busca;
- parâmetros da busca: `external_reference` exato e janela derivada de `authorization_started_at`/`authorizing_at`.

**Storefront:** cada linha da tabela da seção 4.6 leva à ação indicada; em particular, o Brick só é reenviado na resposta de recusa, nunca em `card_attempt_pending`, `card_attempt_in_progress` ou `card_attempt_manual_review`.

**Nova tentativa depois da liberação:** novo `card_attempt_id`, novo `external_reference`, novo `body_sha256` e nova idempotency key (ADR-014), sem nenhum valor da tentativa antiga.

**Webhook (regressão):** tentativa `unknown` depois do prazo, com o ciphertext destruído → fallback + regra 12 resolvem, sem mudança.

**E2E sandbox (com autorização):** exige vencer o prazo (esperar 24 h, ou antecipar `created_at` no banco de desenvolvimento, que é uma escrita que exige autorização). Cenários:
- paga → pedido com a mesma Order e 1 cobrança;
- `failed` → recusa, novo Brick, nova tentativa com nova chave;
- sem Order → idem;
- erro simulado → bloqueado.

Todo invariante novo ou alterado ganha teste correspondente em `docs/mercadopago/invariants.md`.

## 9. Migração e implementação

- **Schema:** nenhuma migration prevista. Estados, colunas (`authorization_started_at`, `authorizing_at`, `token_destroyed_at`, `mercadopago_order_id`, `last_error_class`, `ended_at`) e índices já existem.
- **Código afetado (previsto):**
  - `mercadopago-card-attempt` (`transitions.ts`, `service.ts`):
    - a regra 13;
    - a destruição por retenção sem transição;
    - `expireIfPastDeadline` deixando de produzir `expired`/`replaced` pelo prazo;
  - provider (`authorizePayment`): resolvedor depois do prazo, reusando a conferência de valor do fallback do webhook e `settleKnownCardOrder`.
- **Parâmetros:** `Q` (30 min) e margem (1 h) como constantes em `attempt-states.ts`, junto de `CARD_ATTEMPT_TTL_HOURS`. `H` sem valor padrão: enquanto não for fixado por evidência, a liberação por `total = 0` fica desligada.
- **Antes de ligar `H`:** a validação read-only da busca no sandbox (seção 4.3), registrada como evidência. Ela é uma consulta externa e precisa de autorização.
- **Dados existentes:**
  - tentativas `authorizing`/`unknown` além do prazo passam a ser elegíveis à resolução quando o cliente voltar;
  - tentativas já `expired` continuam só com o operador (regra 11);
  - o artefato residual de sandbox da INV-009 não é decidido aqui.
- **Documentação, na mesma alteração da implementação:**
  - status do ADR-015 → "substituído em parte pelo ADR-016";
  - tabela de `decisions/README.md`;
  - `mercadopago/README.md` (seção do prazo);
  - `invariants.md`, com testes;
  - item 14 de `status.md`.
- **Fora do escopo:** job de limpeza periódica, UX detalhada do storefront (só o contrato da seção 4.6 faz parte), H2/H3/H4, Pix, webhook, `cancelPayment`, fórmula de idempotência.

## 10. Relação com o ADR-015 e a INV-009

Este ADR substitui **somente** a interpretação do prazo como fim funcional da tentativa. Nem o ADR-015 nem a INV-009 são invalidados como um todo.

**Continua válido do ADR-015:**
- decisões 1 a 11 e 13;
- o fluxo de erros no provider e a opção B;
- segurança e criptografia;
- a não-atomicidade;
- o prazo como limite de replay e decifração.

**Continua válido da INV-009:**
- H1, H7;
- as regras 1–12 (a 10 sem o disparo pelo prazo; a 11 só para operador);
- a reconciliação validada nos E2E.

**Substituído:**
- decisão 12, "passado o prazo, a tentativa aberta vira `expired` […] tratamento manual" → o prazo não executa transição funcional; depois dele, a tentativa é resolvida pela seção 4.3;
- da seção "Retenção" do ADR-015, o vínculo entre a destruição do token no prazo e uma transição de estado. A destruição continua, sem transição;
- consequência "tentativas com mais de 24 h exigem intervenção manual" → só quando a busca não é conclusiva, além de `H`, ou para tentativas já `expired`.

**Refinado, não invertido:** a INV-009 concluiu que busca vazia não prova ausência. Isso continua sendo fato, e continua valendo sem exceção antes do prazo. Este ADR **aceita conscientemente** o risco de tratar `total = 0` como "nenhuma Order confirmada", só depois do prazo, de `Q`, dentro de `H` e com as validações da seção 4.3 (seção 7).

## 11. Decisões desta revisão e pendências

Recomendações fechadas na revisão de 2026-09-30. Passam a valer como decisão quando este ADR for aprovado.

| Ponto | Decisão recomendada | Risco residual |
|---|---|---|
| `Q` | 30 min desde `authorizing_at` (4.3) | atraso de indexação em produção desconhecido |
| `H` | semântica: idade máxima da Order procurada em que `total = 0` pode liberar. **Valor não fixado:** sem evidência, a liberação por `total = 0` fica desligada (`card_attempt_manual_review`). Fixado depois por validação read-only no sandbox (4.3) | mesmo validado, é evidência de sandbox, não garantia de produção |
| Margem da janela | 1 h nas duas pontas; `end_date = min(now, authorizing_at + 1 h)` | campo de data do filtro e janela máxima [não validado] |
| Falso negativo | aceito sob as condições do ADR; não impede a arquitetura; sem mitigação adicional além da detecção já existente no webhook | cobrança dupla possível, corrigida por reembolso; sem webhook, não detectada pelo sistema |
| Tentativas já `expired` | continuam na regra 11 (operador); fora do resolvedor. Hoje nenhum caminho automático as produz em massa: só um Place order depois do prazo, antes desta implementação | carts dessas tentativas dependem de operador |
| Limpeza periódica do ciphertext | fora desta implementação; decisão posterior de retenção. Só a destruição lazy no Place order | ciphertext de tentativas abandonadas continua guardado (cifrado) |
| Storefront | contrato mínimo da seção 4.6, com os códigos existentes | UX detalhada não definida |

**Ainda pendente, sem bloquear a aprovação:**
1. **Valor de `H`**, depois da validação read-only da busca no sandbox. Essa validação é uma consulta externa e exige autorização. Até lá, a liberação por `total = 0` fica desligada.
2. **Limpeza periódica do ciphertext** (decisão de retenção).
3. **UX detalhada do storefront** sobre o contrato da seção 4.6.
4. **Artefato residual de sandbox da INV-009:** decisão separada, com prazo em 2026-10-01 13:06Z.
