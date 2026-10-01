# INV-009: reconciliação de operação ambígua do cartão após timeout

> Status: **concluída** (2026-09-30) [decisão humana 2026-09-30].
> - Destino: [ADR-015](../decisions/ADR-015-card-ambiguous-order-reconciliation.md), **aceito** em 2026-09-30.
> - Implementação concluída (Fases 2–5), publicada em `6f5acdd` [commit `6f5acdd`].
> - H1 confirmada ([E2E](#e2e-h1-e-h7-sandbox-2026-09-29)).
> - H7 real **aprovado** no webhook, com fallback pela tentativa e regra 12 ([H7 no webhook real](#h7-no-webhook-real-2026-09-30-aprovado)).
> - Cenários E2E 1, 2, 3, 7, 8 e 9 e as regressões de Pix e reembolso **aprovados** em 2026-09-30 ([E2E restantes](#e2e-restantes-sandbox-2026-09-30)).
> - Continuam pendentes, sem bloquear a conclusão:
>   - o [que ficou fora dos E2E](#o-que-continua-sem-execução);
>   - um [artefato residual de sandbox](#dados-criados-e-pendência) em `unknown`, com a MP Order paga e sem pedido Medusa, **não resolvido**. Ele pode ser resolvido por uma reentrega do webhook ou por um Place order antes do prazo; não vira `expired` sozinho (correção de 2026-09-30: a expiração é lazy, ver [README do Mercado Pago](../mercadopago/README.md#prazo-da-tentativa-de-cartão-implementação-atual)).
>
> [Plano de implementação](#plano-de-implementação-adr-015-proposto), revisado pela [revisão de armazenamento do `card_token`](#revisão-armazenamento-do-card_token-2026-09-30) (2026-09-30) · Aberta em: 2026-09-29 · Commit: `6f5acdd`

Marcações próprias deste documento: **[MCP 2026-09-29]** = documentação oficial do Mercado Pago (MLB, pt) consultada pelo MCP `search_documentation` nessa data; **[doc oficial 2026-09-29]** = referência da API lida em `mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/{create-order,search-order}` nessa data. Código do Medusa e do SDK: pacotes instalados (`@medusajs/*` 2.20.1, `mercadopago` 3.6.1), lidos em 2026-09-29.

Não reabre a [INV-008](INV-008-card-idempotency-key-per-session.md) nem o [ADR-014](../decisions/ADR-014-card-order-idempotency-key-from-body.md): a chave está correta para a mesma operação. Esta investigação trata da limitação registrada no ADR-014 ("Timeout e operação ambígua").

## Achado

Depois de uma falha de transporte em `POST /v1/orders` (cartão), o resultado externo é desconhecido. Se o usuário reenviar o cartão pelo Brick, o body muda, a chave muda (invariante 47) e uma segunda Order é criada. Se a primeira foi aceita e só a resposta se perdeu, há duas cobranças.

Pergunta: como distinguir, com segurança, "Order não criada" de "Order criada, resposta perdida", antes de permitir uma nova cobrança?

## Fatos

### Projeto (`service.ts`, `authorizePayment` do cartão)

- O body é função pura de `session.data` persistida: `type`, `external_reference = cart_id`, `total_amount`, `currency`, `processing_mode`, `description = "Medusa cart <cart_id>"`, `payer`, `transactions.payments[0].{amount, payment_method.{id, token, type, installments}}`.
- Chave enviada: `sha256("<mercadopago_idempotency_key>:card:<sha256(canonicalJson(body))>")`. A chave derivada **não é persistida**, mas é **recalculável** enquanto `session.data` não mudar (invariante 47).
- `orderClient.create(...)` não tem `try/catch`. Qualquer erro do SDK é propagado. Nada é gravado antes da chamada.
- Depois de um 2xx, `!order.id` ou `!payment` lança `MedusaError(UNEXPECTED_STATE)`. É um caso ambíguo do lado do projeto: **a Order existe**, mas o ID não foi guardado.
- O cliente não controla a chave (invariante 2). A rota de update faz `{ ...previousData, ...allowedData }`: cada `onSubmit` do Brick sobrescreve `card_token` (o Brick gera um token novo a cada envio, [INV-008](INV-008-card-idempotency-key-per-session.md)). **Depois de um reenvio, o body da tentativa anterior não pode mais ser reconstruído.**
- Webhook (invariante 19): `data.id` → `GET /v1/orders/{id}` → cart por `external_reference` → session com `data.mercadopago_order_id === data.id`. Ordem paga sem session → 503 + `logger.warn` (invariante 20).

### SDK `mercadopago` 3.6.1 (`utils/restClient`, `utils/config`, `clients/order`)

- `DEFAULT_TIMEOUT = 60000` ms por tentativa, com `AbortController`. `DEFAULT_RETRIES = 3`. `retryOn = [429, 500, 502, 503, 504]`.
- **Erros de rede e timeout também são repetidos** (`catch (networkError)`), com backoff de 1 s, 2 s e 4 s (`jitter = false`), e **a mesma** `X-Idempotency-Key` (calculada uma vez, fora da função repetida). Esgotadas as tentativas, lança `MPConnectionError` (`error: 'connection_error'`).
- Pior caso de uma chamada: 4 × 60 s + 7 s ≈ **247 s**.
- `423` (`MPResourceLockedError`), `409` e `402` não são repetidos.
- Um 2xx cujo corpo não é JSON válido vira `{}` (`response.json().catch(() => ({}))`). No projeto isso cai no `!order.id` acima.
- O SDK expõe `Order.search` → `GET /v1/orders` com `begin_date`/`end_date` (obrigatórios), `external_reference`, `status`, `payment_method_id`, `page`, `page_size`, `sort_by` etc. **O projeto não o usa.**
- Observação lateral: cada método do cliente `Order` faz `this.config.options = { ...this.config.options, ...requestOptions }`, então o último `idempotencyKey` fica gravado no `MercadoPagoConfig` do provider. Toda escrita do projeto passa uma chave explícita (conferido por `grep`), e `GET` não envia o header. Sem efeito hoje; relevante se surgir uma escrita sem chave explícita.

### Medusa 2.20.1

- `completeCartWorkflow`: `acquireLockStep` (timeout 30 s, **TTL 2 min**) → validações → `createOrdersStep` → links, `completed_at`, reservas, `order.placed` → **`authorizePaymentSessionStep` por último** → `addOrderTransactionStep`.
- `authorizePaymentSession` (`@InjectManager`, sem transação):
  - provider **lança** → nada é gravado;
  - provider **retorna** status fora de `authorized`/`captured`/`pending_authorization` → grava `status` e `data` na session e lança `NOT_ALLOWED`. A gravação fica, porque o módulo não participa da compensação do workflow (INV-008: session `error` persistida);
  - `captured`/`authorized` → `authorizePaymentSession_` (`@InjectTransactionManager`): grava session, cria e captura o Payment. Se falhar, chama `provider.cancelPayment` e relança.
- `authorizePaymentSessionStep`: erro não Medusa (é o caso de `MercadoPagoError`) é engolido; a session é relida; `pending` → `PAYMENT_AUTHORIZATION_ERROR`. Erro Medusa é relançado como está.
- `POST /store/carts/:id/complete`: `PAYMENT_AUTHORIZATION_ERROR` e `PAYMENT_REQUIRES_MORE_ERROR` → **200** `{ type: "cart", cart, error }`; qualquer outro erro → lançado (4xx/5xx).
- `validateCartPaymentsStep` aceita sessions `pending`, `requires_more`, `authorized`, `captured` e `pending_authorization`.

### Storefront

- `MercadoPagoPaymentButton` → `placeOrder(cart.id)`. Com 200 `type: "cart"`, `placeOrder` devolve o cart e **o botão não mostra erro**: o spinner some e o botão volta a ficar habilitado. Erro lançado → mensagem exibida.
- O Brick (`MercadoPagoPaymentContainer`) só renderiza para a session `pp_mercadopago` com `status === "pending"`.

### Mercado Pago

- `X-Idempotency-Key`: "garante que uma requisição repetida com a mesma chave retorne o resultado original sem processar a operação novamente"; mesma chave com outro body → `409 idempotency_key_already_used` ("nas últimas 24 horas") [MCP 2026-09-29].
- **Não existe consulta por idempotency key.** A resposta do `POST /v1/orders` não devolve a chave nem outro identificador do request. A retenção do "resultado original" não é documentada; só a janela de 24 h do `409` é [doc oficial 2026-09-29].
- `423 resource_locked`: "A chave de idempotência está temporariamente bloqueada. Aguarde alguns instantes e tente executar a requisição novamente." `500 idempotency_validation_failed`: "Tente reenviar a requisição com uma chave de idempotência nova e única" [MCP 2026-09-29].
- **Busca:** `GET /v1/orders` ("Buscar order"), com `begin_date`/`end_date` RFC 3339 obrigatórios (senão `400 required_search_params`) e filtro opcional `external_reference`. Resposta `{ data[], paging }`. **Não documentados:** atraso de indexação/consistência, retenção, semântica exata do filtro e janela máxima de datas [doc oficial 2026-09-29].
- `external_reference`: obrigatório, até 64 caracteres, `[A-Za-z0-9_-]`, sem PII. Um guia de migração (Point) diz "Deve ser único por order" [MCP 2026-09-29], mas a referência de criação **não** documenta rejeição de duplicados [doc oficial 2026-09-29]. Na prática o sandbox aceitou uma Order com o mesmo `external_reference` de outra (teste negativo do webhook, [status.md](../status.md#webhook-real-depois-do-hardening-2026-09-27-código-3a56150), 2026-09-27), e o projeto reutiliza `cart_id` em várias Orders do mesmo cart (tentativas de cartão, gerações de Pix).
- O payload do webhook traz `data.external_reference` [MCP 2026-09-29]; o projeto usa o valor lido do `GET` autenticado.

## Modelo da operação

```text
Payment Session (payses_X) ─ data persistida: base key, card_token, payer, parcelas, tipo, valor, cart_id
  ↓
body = f(session.data)          key = sha256(base:card:sha256(canon(body)))      (nada é persistido)
  ↓
POST /v1/orders  ── SDK: até 4 envios com a MESMA key (rede, timeout, 429, 5xx), até ~247 s
  ├─ 2xx com id  → provider retorna status → session/Payment gravados com mercadopago_order_id
  ├─ 402/400/409/422 → lança → nada gravado (resultado definitivo: não cobrado por esta key)
  └─ AMBÍGUO: MPConnectionError · 423 · 5xx final (inclui idempotency_validation_failed) · 2xx sem id
        → lança → nada gravado → session pending, sem mercadopago_order_id
  ↓
identificadores que voltam do MP: order.id, payments[0].id, external_reference (= cart_id), status
  ↓
webhook: data.id → GET → cart (external_reference) → session com mercadopago_order_id == data.id
        Order A da operação ambígua: nenhuma session a guarda → paga: 503 (retry) · não paga: 200
```

## Respostas às perguntas

### 1. Identificadores

| Identificador | Origem | Enviado ao MP | Retorna do MP | Permite lookup | Unicidade | Seguro para reconciliação |
|---|---|---|---|---|---|---|
| Idempotency key derivada | provider, no `authorizePayment`; recalculável de `session.data` | sim (header) | não | **não há endpoint**; só o replay (mesma key + mesmo body) devolve o resultado original | única por (session, body) | **sim, por replay**, enquanto o body for reconstruível e dentro da retenção do MP [não validado: retenção] |
| Base key (`mercadopago_idempotency_key` = `payses_…`) | Payment Module → `initiatePayment` | não (só compõe a chave) | não | não | única por session | não (não está no MP) |
| `external_reference` (= `cart_id`) | Medusa (cart) | sim | sim (Order e webhook) | sim, por `GET /v1/orders` com janela de datas | **não**: várias Orders do mesmo cart; o MP não rejeita duplicados | **não**: prova o cart, não a tentativa |
| Payment Session ID | Payment Module | não | não | não | única | não chega ao MP |
| Cart ID | Medusa | sim (`external_reference`, `description`) | sim | igual a `external_reference` | não por Order | não |
| `card_token` | Brick (MP) | sim (body) | não (a Order devolve `payment_method.id/type/installments`, não o token) | não | único, uso único | não chega de volta |
| Order ID (`ORD…`) | MP, na criação | — | sim, **só na resposta perdida** ou no webhook/busca | `GET /v1/orders/{id}` | única | sim, depois que se sabe que pertence à tentativa, o que é exatamente o que falta |
| Payment ID (`PAY…`) | MP | — | sim, na resposta | não há `GET` por ele na Orders API | única | idem |
| `x-request-id` do MP | MP | — | só no header da resposta perdida | suporte manual | — | não |

### 2. `external_reference`

- Enviado: sim, com `cart_id`.
- Aparece: sim, no `GET /v1/orders/{id}`, no webhook e (pelo contrato) na busca.
- Pesquisável: sim, por `GET /v1/orders`, com janela de datas obrigatória. Igualdade exata (sem prefixo) e atraso de indexação de alguns segundos observados no sandbox: [E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29).
- Determinístico: **não**. Vários candidatos por cart (tentativas recusadas: o `402` persiste uma Order `failed`, [E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29); Pix de outras sessions; Orders criadas por terceiros com o token). E "nenhum resultado" não prova inexistência sem garantia de consistência.
- Duas Orders com o mesmo valor: sim, comprovado no sandbox em 2026-09-27.
- **Não é seguro** para reconciliação no formato atual. Escolher entre candidatos por valor ou horário seria heurística.

### 3. Idempotency key

- Lookup por chave: **não existe**. Nenhum endpoint de idempotência ou de retry documentado [doc oficial 2026-09-29].
- Retenção: não documentada para o "resultado original"; o `409` cita 24 h. Tratar ≤ 24 h como limite [não validado].
- **O replay devolve o resultado original**, não uma Order nova: documentado [MCP 2026-09-29]. Observado para **recusa**: `402` repetido com o mesmo payment ID ([INV-008](INV-008-card-idempotency-key-per-session.md#correção-e-regressão-2026-09-29), sandbox 2026-09-29). **Não observado para `201`** [não validado].
- Serve depois de uma perda de resposta? **Sim, com duas condições:**
  - o body exato tem que continuar reconstruível (hoje é, até o próximo `onSubmit` do Brick);
  - o replay tem que acontecer dentro da retenção.

  Se a primeira operação nunca chegou ao MP, o replay **a executa agora** (uma única vez, pela mesma chave). Se ela chegou, devolve a Order original. Nos dois casos, a chave produz no máximo uma Order.
- O próprio SDK já faz isso dentro de uma chamada: uma resposta perdida na tentativa 1 costuma ser resolvida pela tentativa 2 com a mesma chave. A ambiguidade residual é: indisponibilidade sustentada (~4 min), `423`, `5xx` final, 2xx sem `id`, ou o processo morrer no meio da chamada.

### 4. Webhook

- Fluxo atual: `data.id → GET /v1/orders/{id} → external_reference → session com mercadopago_order_id === data.id → evento`.
- Suficiente para reconciliar? **Não.** Depois da operação ambígua nenhuma session guarda o ID da Order A. O webhook de A responde 503 (paga) ou 200 (não paga) e **nunca a associa**. Por construção (invariante 19), não pode: nada no `GET` liga A à chave ou à tentativa.
- Order paga antes do webhook: sim, sempre há essa janela. O tempo de entrega não tem limite garantido: observados segundos e até ~2 dias com o túnel fora do ar ([status.md](../status.md), #83).
- Protege contra a segunda cobrança? **Não.** O `logger.warn` do 503 ("paid order … has no payment session holding it") é o único sinal do problema, e só para a conciliação manual.
- Janela perigosa: **todo o intervalo** entre a falha e o reenvio do Brick. O webhook de A pode chegar antes, durante ou depois de B, e em nenhum caso impede B.
- Efeito colateral útil: como o 503 faz o MP reenviar, **se a session passar a guardar o ID de A** (por exemplo, por um replay), um webhook posterior de A é processado normalmente. Não é preciso mudar o webhook.

### 5. Estado Medusa depois do timeout

Mesmo caminho de código do `402` na INV-008 (erro do SDK que não é `MedusaError`). O estado foi observado no sandbox naquela ocasião, para o `402`.

| Entidade | Estado |
|---|---|
| Payment Session | `pending`; `data` **inalterada** (`card_token`, payer etc. da tentativa, sem `mercadopago_order_*`); body e chave reconstruíveis |
| Payment | nenhum |
| Cart | aberto: `completed_at` gravado por `updateCartsStep` e revertido na compensação |
| Payment Collection | inalterada (`maybeUpdatePaymentCollection_` não é chamado) |
| Order Medusa | criada por `createOrdersStep` **antes** da autorização e removida na compensação (`deleteOrders`), junto com links e reservas. Não observado em E2E de timeout [não validado] |
| Resposta HTTP | `200 { type: "cart", error: PAYMENT_AUTHORIZATION_ERROR }`; o botão não mostra mensagem |

Variante: 2xx sem `id` → `UNEXPECTED_STATE` (erro Medusa) → a rota lança (não 200); o mesmo estado Medusa, com **a Order já existindo** no MP.

### 6. Nova tentativa hoje

1. **Place order de novo, sem mexer no pagamento:** mesmo body, mesma chave. Replay seguro: devolve a Order original, ou a cria se ela nunca existiu.
2. **Voltar ao pagamento e reenviar o Brick** (outro cartão **ou o mesmo**: o token é sempre novo) → `POST /store/mercadopago/payment-sessions/:id` sobrescreve `card_token` → **o body de A deixa de ser reconstruível** → Place order → `authorizePayment` → nova chave → `orderClient.create` (`service.ts`, `authorizePayment`) → **Order B**. É aqui que nasce a segunda cobrança.
3. **Trocar de método ou mudar o total do cart** → nova session (a anterior é apagada; `deletePayment` não faz nada para cartão) → nova base key → nova Order. Mesmo risco, e o rastro de A se perde junto com a session.
4. **Concorrência:** a rota de update não passa pelo lock do `completeCart`. Um reenvio do Brick em outra aba durante uma chamada em andamento produz o mesmo resultado do item 2. E o TTL do lock (2 min) é menor que o pior caso do SDK (~247 s): um segundo `completeCart` pode começar enquanto o primeiro ainda espera o MP [não validado: efeito sobre o pedido criado antes da autorização].

## Estratégias (sem escolha)

**A — lookup direto por idempotency key.** Indisponível: não há endpoint. A variante **A′ — replay com a mesma chave e o mesmo body** está disponível e é determinística, mas **só enquanto o body não mudar**. Hoje nada garante isso.

**B — lookup por `external_reference`.**
- **B1, como está (`cart_id`):** não é único, a consistência da busca não é documentada, e "sem resultado" não prova inexistência. Inaceitável como prova.
- **B2, `external_reference` por tentativa** (por exemplo `cart_id` + sufixo derivado da chave; cabe em 64 caracteres): permitiria atribuir exatamente uma Order do webhook ou da busca à tentativa. Custos:
  - muda a derivação do cart no webhook (invariante 19): exige ADR;
  - a unicidade depende do próprio projeto, não do MP;
  - continua sem provar a **ausência** de uma Order (índice).

**C — webhook/eventos.** Com a correlação atual, impossível (seção 4). Só funciona com B2, e ainda assim não bloqueia B antes de o webhook chegar.

**D — estado explícito de operação desconhecida**, que congela o body até a resolução. Mecanismo disponível no core: o provider **retorna** um status em vez de lançar. O Payment Module grava `status` e `data` antes de lançar `NOT_ALLOWED`, sem ser revertido.
- `requires_more`: continua processável pelo `validateCartPaymentsStep`; o Brick não renderiza para ela.
- `pending` + marcador em `data`.
- `error` **não serve**: o storefront obriga a escolher o método de novo, o que recria a session e apaga o rastro.

O congelamento precisa também de:
- recusa no `updatePayment`/rota de update quando o body mudaria;
- decisão sobre `deletePayment` (bloquear a troca de método e o refresh por mudança de total, ou registrar a tentativa pendente fora da session).

Sozinho, D bloqueia mas não resolve.

**E — combinação D + A′** (+ B2 opcional):
- a falha ambígua grava o marcador (hash do body, data) e congela o body;
- o próximo `authorizePayment` na mesma session reconstrói o body, confere o hash e faz o replay com a mesma chave:
  - `201` → segue o fluxo normal e grava `mercadopago_order_id`, e o webhook de A passa a ser processado;
  - `402` ou outro erro definitivo → limpa o marcador e libera um novo cartão;
  - ambíguo de novo → mantém o marcador;
- marcador mais velho que a retenção → não faz replay: estado manual;
- B2 cobriria a session apagada, a retenção vencida e a atribuição pelo webhook.

| Estratégia | Segurança contra A+B pagas | Falso positivo | Falso negativo | Latência | Depende do MP | A nunca criada | A criada e paga | A falhou | UX | Complexidade | Medusa 2.20.1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A (lookup por key) | — | — | — | — | inexistente | — | — | — | — | — | — |
| A′ (replay), sem congelar | só se o usuário não reenviar o Brick | nenhum | alto: o reenvio destrói o body | 1 request | idempotência documentada; retenção não | executa agora (1 cobrança) | devolve A | devolve a falha | nenhuma mudança | nenhuma (já é o comportamento) | sim |
| B1 (`cart_id`) | insuficiente | alto: candidatos de outras tentativas | índice/consistência | busca + janela | busca sem garantias | "vazio" não prova nada | acha A entre outras | idem | espera | média | sim |
| B2 (ref por tentativa) | detecta; não prova ausência | baixo (unicidade do projeto) | consistência da busca [não validado] | busca/webhook | busca e webhook | não prova | atribui A exatamente | atribui | espera | média-alta + ADR (inv. 19) | sim |
| C (webhook atual) | nenhuma | — | total | indefinida | entrega do webhook | — | 503 eterno, órfã | — | — | — | — |
| D (congelar) | alta (sem novo body até resolver) | bloqueia também quando A nunca existiu | — | até a resolução | não | fica bloqueado sem resolvedor | bloqueia B | bloqueia sem necessidade | cartão travado | média | sim (status retornado) |
| E (D + A′) | **alta**: uma única chave por tentativa não resolvida | nenhum (a resolução é pela própria chave) | só depois da retenção ou com a session apagada | 1 replay no próximo Place order | idempotência documentada; replay de `201` e retenção [não validado] | o replay a executa: o usuário é cobrado uma vez, pela tentativa que fez | o replay devolve A e não cria B | o replay devolve a falha e libera um novo cartão | troca de cartão só depois de resolver; mensagem explícita | média | sim |

## Conclusão

**Classificação: é necessário um novo estado/mecanismo, apoiado num mecanismo parcialmente suficiente que já existe.**

- **Não existe reconciliação segura disponível hoje.** Não há lookup por idempotency key. `external_reference = cart_id` não é único, e a busca não tem garantia de consistência. O webhook não consegue atribuir a Order de uma operação ambígua.
- **O mecanismo parcialmente suficiente é o replay idempotente** (mesma chave, mesmo body), documentado pelo MP e já usado pelo SDK dentro de uma chamada. Ele distingue "não criada" de "criada" sem heurística: na pior hipótese, executa a operação uma única vez.
- **O que falta:** garantir que o body da tentativa ambígua não seja substituído antes do replay (o reenvio do Brick, a troca de método e o refresh da session destroem o rastro), e limitar o replay à janela de retenção.

## Perguntas em aberto (exigem teste ou decisão)

- **H1: CONFIRMADA** [sandbox 2026-09-29]: replay com a mesma chave e o mesmo body depois de um `201` devolve a **mesma** Order (mesmo `id`), sem criar outra ([E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29)).
- **H2** [não validado]: retenção do resultado original: 24 h, como a janela do `409`?
- **H3** [não validado]: replay enquanto a original ainda está em processamento → `423`?
- **H4** [não validado]: um `card_token` já consumido, reenviado por replay depois da retenção → erro definitivo?
- **H5: observada, sem garantia** [sandbox 2026-09-29]: igualdade exata; busca imediata vazia, ~36 s depois exatamente 1 resultado ([E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29)). Não serve como prova de ausência.
- Decisão: status do marcador (`requires_more` × `pending` + marcador), política de `deletePayment` e comportamento depois da retenção (manual).

## Plano de validação (proposto, não executado)

**E2E mínimo para H1**, sem código novo:
- criar uma Order de cartão no sandbox (`APRO`, Visa) com a chave K;
- reenviar exatamente o mesmo body com K;
- esperado: mesmo `order.id`, mesmo `payment.id`, nenhuma segunda Order (`GET /v1/orders/{id}`; sem busca).

Dados criados: 1 Order sandbox paga, sem cart nem session. Pode ser feito pelo caminho real (`medusa exec`, como na INV-008), o que também deixa 1 cart concluído. Risco: mais uma Order órfã no sandbox (webhook → 503 se não houver session). Sem alteração administrativa. H3 pode ser observado no mesmo teste, com dois envios simultâneos. **Aguarda autorização.**

H2 e H4 exigem esperar mais de 24 h. H5 só importa se B2 for escolhida.

## Próximo passo (se E for escolhida; não implementado)

**Menor implementação:**
1. `authorizePayment` (cartão) classifica o erro do `create`:
   - **definitivo** (`400`, `401`, `402`, `403`, `409`, `422`, `429` final): lança, como hoje;
   - **ambíguo** (`MPConnectionError`, `423`, `5xx` final, 2xx sem `id`/payment): **retorna** o status escolhido com `data.mercadopago_card_pending_attempt = { body_hash, at }`, sem persistir a chave (invariante 47 mantido).
2. `authorizePayment` com o marcador presente: reconstrói o body, exige `sha256(body) === body_hash` e faz o replay com a mesma chave:
   - resultado definitivo → remove o marcador (sucesso grava a Order como hoje);
   - ambíguo → mantém o marcador;
   - marcador vencido → `NOT_ALLOWED`, que leva à conciliação manual.
3. `updatePayment` (provider) recusa mudanças no body do cartão com o marcador presente. A rota de update já passa por ele.
4. `deletePayment`: com o marcador, recusar ou registrar (decisão).
5. Storefront: mostrar a mensagem de pagamento em confirmação. Hoje o erro 200 fica silencioso.

**Testes unitários (`S`, `PS`):**
- cada classe de erro → lança × retorna com marcador;
- o marcador não contém a chave nem o token;
- replay com a mesma chave e o mesmo body;
- replay `201` / `402` / ambíguo;
- hash divergente → recusa;
- marcador vencido;
- update e delete com o marcador;
- Pix, reembolso e webhook inalterados.

**E2E mínimo:** `medusa exec` com um wrapper do `fetch` que deixa o `POST /v1/orders` chegar ao MP e descarta a resposta em todas as tentativas → session com marcador e Order A criada → Place order sem o wrapper → replay → mesma Order A, 1 Payment, pedido criado → reenvio do Brick com o marcador → recusado.

**Impactos:**
- **Webhook:** nenhuma mudança. O 503 de A vira processamento normal depois do replay.
- **Payment Session:** novo campo em `data` e um status persistido fora de `pending`. Exige invariante novo e ADR.
- **UX:** depois de uma falha ambígua, o cliente só pode confirmar a mesma tentativa ("estamos confirmando seu pagamento"), até ela ser resolvida.

## Definição arquitetural (2026-09-29)

Direção proposta pelo responsável, **não aprovada** [decisão humana 2026-09-29]:
- estado nativo `pending_authorization`;
- tentativa ambígua congelada, sem troca de cartão enquanto indefinida;
- idempotência do MP para retry da mesma operação;
- identificador durável por tentativa;
- webhook como caminho principal, reconciliação só na falta dele;
- nenhum estado customizado se o nativo bastar.

Esta seção verifica cada parte contra o Medusa 2.20.1 instalado e a Orders API, e propõe um plano. Não há código, ADR nem E2E.

O backend carrega `@medusajs/core-flows` e `@medusajs/payment` pelo `@medusajs/medusa` 2.20.1; os arquivos são idênticos aos lidos acima (`diff` em 2026-09-29).

### Verificações no Medusa 2.20.1

**`pending_authorization`**:
- **Onde é tratado:** `authorizePaymentSession` (módulo), `authorizePaymentSessionStep`, `validateCartPaymentsStep`, `completeCartWorkflow`, `processPaymentWorkflow`, `authorizePaymentSessionForOrderWorkflow`, o subscriber `payment-webhook` e o Admin. No projeto, só o Pix o usa (`resolvePixStatus`).
- **Provider retorna `pending_authorization`:** o módulo grava `status` e `data`, recalcula a collection e devolve `null`. O step devolve `null` sem erro, e o `completeCartWorkflow` **segue**: cria o pedido Medusa, grava `completed_at`, reserva estoque e emite `order.placed`. A rota responde `type: "order"`, e o storefront redireciona para a confirmação. É o cenário A do Pix.
- **Reutilização da session:** continua ligada à collection, agora do pedido. `authorizePaymentSession` volta a chamar o provider enquanto não há `payment` + `authorized_at`.
- **O cliente consegue alterar os dados?** Pelo core, não: as rotas de cart recusam cart concluído. **Pela rota do projeto `POST /store/mercadopago/payment-sessions/:id`, sim.** Ela não confere `status` nem `completed_at` e chama `updatePaymentSession`, que mantém o status. Um novo `card_token` gravado ali seria usado no próximo `authorizePayment` (webhook ou Admin), gerando outra chave e outra Order.
- **APIs nativas de reautorização:**
  - `POST /admin/orders/:id/payment-sessions/authorize` (`authorizePaymentSessionForOrderWorkflow`): exige `pending_authorization`, chama o provider e adiciona as transações do pedido. O dashboard lista as sessions `pending_authorization` do pedido e oferece essa ação (`useAuthorizePaymentSession`).
  - `processPaymentWorkflow`: ramo "authorize-existing-order" (só com ação `authorized`) e ramo de auto-captura (ação `captured`, sem Payment). Esse último é o que o Mercado Pago usa hoje.
  - **Não existe rota da Store** para reautorizar.
- **Falha:** o subscriber `payment-webhook` **descarta** as ações `failed`, `canceled`, `requires_more`, `pending_authorization` e `pending`. O core não tem caminho nativo para uma autorização diferida que falha: o pedido fica criado e sem pagamento.
- **Cancelamento:** o wrapper do ADR-013 só age em session Pix `pending_authorization`. Um pedido de cartão nesse estado seria cancelado pelo core sem nenhuma ação no MP, com o risco de a Order paga chegar depois (padrão da INV-005).

**Outros pontos**:
- **Status retornado × lançado:** qualquer status fora de `authorized`/`captured`/`pending_authorization` é gravado (`status` + `data`) e seguido de `NOT_ALLOWED`. A gravação fica, porque `@InjectManager` não tem transação e o módulo não participa da compensação do workflow. Um provider que **lança** não grava nada.
- **Gravar antes do `POST`:** o provider não consegue; o módulo só grava o que ele retorna. O único ponto nativo antes da autorização é o hook exportado `completeCartWorkflow.hooks.validate`:
  - roda sob o lock do cart, antes de `create-order`;
  - aceita `compensateFn` (`workflows-sdk` 2.20.1, `createHook`);
  - só admite um handler, e **o projeto não o usa**.

  `beforePaymentAuthorization` e `orderCreated` existem, mas não são exportados (`hooks: [validate]`).
- **Apagar a session:** `createPaymentSessionsWorkflow` e `refreshPaymentCollectionForCartWorkflow` apagam as sessions por `deletePaymentSessionsStep` (→ `provider.deletePayment`). Se o provider lança, `validateDeletedPaymentSessionsStep` lança `UNEXPECTED_STATE` e a operação é desfeita. É o mesmo mecanismo que já impede descartar um Pix pago (invariante 7).
- **Exposição:**
  - a Store API genérica devolve o `status` da session (coluna, não redigida) e, de `data`, só `payment_method_id` (invariante 24);
  - a rota de update do projeto devolve `payment_session` **inteiro**, com `data`: pendência de segurança já registrada no status.md.
  - O storefront só considera ativa a session `pending` (`payment/index.tsx`, `payment-wrapper`, Brick). O `PaymentButton` usa `payment_sessions[0]`, qualquer que seja o status.

### `pending_authorization` é adequado?

**Não, para "autorização iniciada, resultado externo desconhecido" com o cart aberto.** No Medusa 2.20.1 ele significa "o provider aceitou e confirmará depois": o core trata o status como sucesso da conclusão e cria o pedido. Consequências para o cartão:

| Caso | Com `pending_authorization` |
|---|---|
| Order nunca criada | Pedido Medusa existe e o cliente vê "pedido realizado". Ninguém tenta de novo: não há rota da Store, o core ignora falhas, e uma nova tentativa com outro cartão exige cancelar o pedido e refazer o checkout. **Viola os casos 1 e 6.** |
| Order `failed` | O webhook `failed` é descartado pelo core. O pedido fica sem pagamento até alguém cancelá-lo. **Viola o caso 3.** |
| Order paga | Funciona: webhook → auto-captura, se a correlação achar a session (ver webhook). |
| Pix | Sem conflito de código (o step de cancelamento filtra Pix), mas o mesmo status passaria a significar "cobrança existe e aguarda pagamento" (Pix) e "talvez não exista cobrança" (cartão). |

Só seria adequado se o produto aceitasse **"pedido realizado, pagamento em confirmação" para cartão**, com um caminho próprio de falha: cancelar o pedido e avisar o cliente. Isso é outra decisão de produto e contradiz os critérios 1, 3 e 6 como formulados.

**Adaptação proposta: cart aberto, com o estado da tentativa em `data` e o status `pending`.** Não há estado customizado: nenhum status novo, só um campo em `data`. Nenhum status nativo significa exatamente "resultado desconhecido". Comparação dos candidatos:

| Status da session durante a indefinição | Efeito |
|---|---|
| `pending` + marcador em `data` (**proposto**) | O cart fica aberto e nenhum pedido Medusa é criado. `validateCartPaymentsStep` aceita a session, e o webhook pago conclui o cart pelo fluxo nativo (`completeCartAfterPaymentStep`). O congelamento é feito no servidor (provider e rota), onde ele precisa estar de qualquer forma. O storefront precisa de um sinal público (ver UX). |
| `requires_more` | Nativo, e o Brick some sozinho. Mas `getStatusFromGateway` já mapeia `in_mediation`/`requires_more` do MP para ele (dois significados), e o efeito sobre as etapas do checkout não foi verificado. |
| `pending_authorization` | Ver acima. |
| `error` | O storefront obriga a escolher o método de novo → nova session → `deletePayment`. Só seria seguro com o bloqueio, e aí a UX fica pior sem ganho. |

### Identificador da tentativa (`authorization_attempt_id`)

- (Substituído pela [opção B](#ownership-das-regras-3-4-e-5-opção-b-2026-09-30) e pelo módulo próprio: a tentativa nasce na rota de update e passa a `authorizing` no provider.) **Onde nasce:** no **hook `validate` do `completeCartWorkflow`**, no servidor, a cada Place order com cartão, quando a session não tem tentativa aberta. É aleatório (por exemplo, um ULID), não derivado de dados do cliente.
  - Na mesma operação, o hook grava em `session.data` o estado `authorizing`, **antes** do `POST`. Precedente: a ação transitória do Pix via `updatePaymentSession` (invariante 5).
- **Estabilidade:**
  - retries do SDK e replays reutilizam o mesmo ID, porque o ID faz parte do body e o body é reconstruído de `data`;
  - um Place order concorrente encontra `authorizing` e é recusado;
  - um Place order depois de `unknown` faz o replay com o mesmo ID.
- **Novo ID:** só depois de um estado terminal (`failed` definitivo, ou tentativa resolvida sem Order), no próximo Place order com dados novos do Brick. Enquanto houver tentativa `authorizing`/`unknown`, a rota de update e o `updatePayment` **recusam** qualquer mudança nos campos do body do cartão.
- **Compensação do hook:**
  - estado ainda `authorizing` → o provider lançou erro definitivo, ou o workflow falhou antes da autorização → a tentativa é removida;
  - estado `unknown` (gravado pelo provider) → mantido.

  Se o processo morrer durante o `POST`, a compensação não roda e o estado `authorizing` fica gravado: é exatamente o que tem de ficar.
- **Onde vive:** `session.data.mercadopago_card_attempt = { id, state, started_at, updated_at, body_sha256, order_id? }`. É copiado para `payment.data` na autorização.
- **Vai ao MP:** sim, **dentro de `external_reference`** (ver abaixo). É isso que permite ao webhook atribuir a Order à tentativa.
- **Webhook:** chega em `data.external_reference` e no `GET /v1/orders/{id}`, que é o valor usado.
- **Storefront:** não precisa. A Store API genérica já o remove (invariante 24). A rota de update ainda devolve `data` inteiro: fechar essa pendência junto.

### `external_reference`

| Pergunta | Resposta | Fonte |
|---|---|---|
| Onde é enviado | raiz do body do `POST /v1/orders`, obrigatório, até 64 caracteres, `[A-Za-z0-9_-]`, sem PII | [MCP 2026-09-29], [doc oficial 2026-09-29] |
| Aparece na Order / `GET /v1/orders/{id}` | sim | #83 (status.md), INV-003, código do webhook |
| Aparece no webhook | sim, em `data.external_reference` | [MCP 2026-09-29] (exemplo de notificação) |
| Busca por ele | sim, `GET /v1/orders?begin_date&end_date&external_reference`; não documentados: igualdade exata e atraso. Observado: exata, com atraso de indexação | [doc oficial 2026-09-29], [E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29) |
| Unicidade | **só convenção da aplicação**. "Deve ser único por order" aparece num guia de migração, mas a referência de criação não documenta rejeição, e o sandbox aceitou um duplicado | status.md 2026-09-27 |

**Correlação determinística para exatamente uma tentativa?** **Sim, com as condições abaixo**; caso contrário, fica descartado.
1. O valor tem um componente que só o projeto gera e nunca reutiliza em outra tentativa: `<cart_id>-<attempt_id>` (31 + 1 + 26 = 58 caracteres; `cart_id` não tem `-`).
2. O valor é lido do `GET` autenticado da Order, nunca do corpo da notificação.
3. Exatamente uma session do cart tem `data.mercadopago_card_attempt.id === attempt_id`.
4. O valor da Order bate com o da session (como o Pix, invariante 10).
5. **Só associa se a session ainda não guarda outra Order.** Se já guarda uma diferente, é uma segunda Order da mesma tentativa, o que só é possível com um replay fora da retenção do MP ou com um terceiro usando o token. Nesse caso não associa: alerta, e 503 se estiver paga.

Sem o `attempt_id` no `external_reference` (formato atual `cart_id`), a correlação é impossível e **o webhook não pode ser o caminho principal**. Nesse caso, só o replay resolve.

**Ressalvas:**
- muda o invariante 19 (o cart deixa de ser o `external_reference` inteiro) e exige ADR;
- o parser precisa aceitar os dois formatos (Pix e Orders de cartão antigas continuam com `cart_id`);
- a unicidade vem do projeto, não do MP;
- formato validado no `GET` (H7 parcialmente confirmada; webhook não observado): [E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29).

### Webhook

- **Opção 1 = Opção 3** (Order ID → session por `mercadopago_order_id`): é o fluxo atual (invariante 19). Robusto e exato, mas **cego** para a operação ambígua, porque nenhuma session guarda o ID.
- **Opção 2** (Order ID → `GET` → `external_reference` → `attempt_id` → session): é o único caminho que encontra a Order ambígua, desde que atenda às 5 condições acima.
- **Recomendação: Opção 3 primeiro e Opção 2 só como fallback,** quando nenhuma session guarda `data.id`, a Order tem `attempt_id`, e a session da tentativa está `authorizing`/`unknown` sem `order_id`.
  - Nesse caso, o webhook grava `order_id` na tentativa **antes** de emitir o evento: por um step de workflow, não por `updatePaymentSession` direto na rota (dívida técnica já registrada).
  - Em seguida, `processPaymentWorkflow` (auto-captura) chama `authorizePayment`, que encontra `order_id` e **lê** a Order em vez de criar outra (padrão `reauthorizePixOrder`).
- **Order `failed`/`canceled`:** o core descarta a ação. O webhook (ou o provider no próximo Place order) grava o estado terminal na tentativa, o que libera um novo cartão sem passar pelo `processPaymentWorkflow`.
- **Não muda:** HMAC, `data.id` da query, 503 para Order paga sem session, e a correlação atual para Pix e cartão sem tentativa.

### Linha do tempo

Estados da tentativa: `authorizing` (hook, antes do `POST`) → `unknown` (resposta ambígua) → `resolved` (Order associada) ou `failed` (definitivo, libera novo cartão).

| Cenário | Sequência proposta |
|---|---|
| T0–T3, T2 = Order criada e **aprovada**, resposta perdida | T0: hook grava `authorizing(A)`. O SDK esgota as tentativas; o provider retorna `pending` com `unknown(A)` (gravado); `NOT_ALLOWED` → 400; cart aberto. T5: novo cartão → rota/`updatePayment` recusam; Place order → replay de A (mesma chave e body) → a Order original volta → `captured` → pedido. Ou o webhook chega antes: fallback por `attempt_id` → associa → auto-captura → cart concluído sem o navegador. **Nenhuma Order B.** |
| T2 **nunca aconteceu** | Webhook nenhum. T5: o novo cartão é recusado; Place order → replay → o MP processa A agora (primeira vez) → 201/402 → estado terminal. Com 402, o próximo envio do Brick cria a tentativa B. |
| T2 aconteceu, Order **failed** (402 perdido) | Webhook `order.failed` (se houver): fallback → estado `failed(A)`. Ou o replay devolve o 402 original → `failed(A)` → o novo cartão é liberado. |
| Processo morreu durante o `POST` | Estado `authorizing(A)` persistido (sem compensação). Tratado como `unknown`: mesmo caminho. |
| Place order concorrente com `authorizing` | Recusado (409/400); não chama o MP. |

**Limite:** tentativa `unknown` mais velha que a retenção da idempotência (≤ 24 h, [não validado]) não faz replay. Busca read-only por `external_reference`: encontrada → associa; não encontrada → estado manual (alerta), nunca uma nova chave automática.

### Reconciliação

| Mecanismo | Segurança | Custo | Latência | Complexidade | Dependência | Risco de cobrança dupla | UX |
|---|---|---|---|---|---|---|---|
| A — só webhook | Não prova ausência; exige `attempt_id` no `external_reference` | baixo | segundos a dias | média (fallback) | entrega do webhook | baixo com o congelamento; o cliente pode ficar travado sem webhook | espera indefinida quando a Order não existe |
| B — replay idempotente | Determinístico: devolve a original ou executa uma vez | 1 request | imediata, no próximo Place order | baixa | retenção do MP [não validado]; H1 | nenhum dentro da retenção | o cliente precisa confirmar; pode executar o cartão antigo |
| C — polling periódico (busca/GET) | Encontra; não prova ausência (consistência não documentada) | job + chamadas | minutos | média | busca (H5) | nenhum se for só leitura | invisível |
| D — resolução explícita no próximo Place order | = B, disparado pelo cliente | — | ação do cliente | baixa | idem B | idem B | clara, se houver mensagem |
| **E — webhook + replay no próximo Place order + job só de leitura** | **a mais robusta:** cada caso tem um resolvedor determinístico, e nenhum caminho cria uma chave nova sem estado terminal | moderado | segundos (webhook) / ação (replay) / minutos (job) | média-alta | webhook, idempotência, busca | nenhum dentro da retenção; fora dela, manual | clara |

**Recomendação: E.**
- **Webhook**, com o fallback por `attempt_id`: caminho principal.
- **Replay** só por ação do cliente (Place order) ou do operador. Um replay automático em segundo plano executaria uma cobrança confirmada pelo cliente, mas talvez sem ele presente: fica como decisão de produto.
- **Job** só com busca/`GET` e alerta; nunca cria nem repete Orders.

### UX (sem implementar)

- **Sinal público:** o storefront não enxerga o marcador (invariante 24). Opções, que exigem decisão/ADR:
  1. ampliar a allowlist de redação com um campo derivado, por exemplo `payment_state: "confirming"`;
  2. uma rota de estado, como `carts/:id/pix`.
- **Com tentativa `authorizing`/`unknown`:**
  - Brick oculto;
  - troca de método bloqueada: o servidor já recusa, pelo `deletePayment`;
  - mensagem: "Estamos confirmando seu pagamento anterior";
  - o botão vira "Confirmar pagamento" (replay), desabilitado enquanto `authorizing`.
  - O cliente **não troca de cartão** até a tentativa ser resolvida. Se a Order nunca existiu, confirmar executa o cartão já informado: o texto precisa dizer isso.
- **Aprovação pelo webhook:** o cart é concluído pelo servidor. A Review precisa detectar isso (como o 410 do Pix) e redirecionar para o pedido.
- **Order `failed`:** a tentativa vira `failed`, a session continua `pending` sem marcador, e o Brick volta ("pagamento recusado, tente outro cartão").
- **Nova tentativa legítima:** só depois de `failed` (ou de resolução sem Order): novo envio do Brick + Place order → novo `attempt_id`, novo body, nova chave.
- **Mudança no cart** (itens, frete): bloqueada durante a indefinição, porque o refresh da collection apaga a session e o `deletePayment` recusa. A mensagem precisa explicar.
- **Admin:** com o cart aberto não há pedido, então o dashboard não mostra nada. A visibilidade operacional vem do log/alerta do job.

### Dados

| Campo | Onde | Por quê | Exposto ao storefront |
|---|---|---|---|
| `mercadopago_card_attempt.id` | `session.data` → `payment.data` | correlação | não (invariante 24; rota de update a corrigir) |
| `.state`, `.started_at`, `.updated_at` | idem | congelamento, retenção | só um derivado público, se aprovado |
| `.body_sha256` | idem | garantir que o replay use o mesmo body (a chave já depende dele) | não |
| `.order_id` / `mercadopago_order_id` | idem | correlação do webhook | não |
| `card_token`, `payer` (e-mail, CPF) | **já persistidos hoje** (ADR-006) | **necessários para o replay**, a única prova determinística de ausência | não |
| body completo, CVV, número do cartão | nunca | CVV e PAN não passam pelo backend (Brick); o body é reconstruído | — |

Justificativa para manter o `card_token` até a resolução: sem ele o body não pode ser reconstruído, e a tentativa `unknown` só se resolveria por busca, que não prova ausência. Em troca, propõe-se **apagar `card_token` (e reduzir `payer`) quando a tentativa chega a estado terminal**, o que reduz a exposição em relação a hoje. Decisão à parte.

### Concorrência (lock de 2 min × ~247 s do SDK)

- **Lado pagamento (segundo `POST` durante uma chamada em andamento):** coberto por esta arquitetura. O estado `authorizing` gravado pelo hook antes do `POST` faz o segundo Place order e o reenvio do Brick serem recusados.
- **Lado pedido Medusa:** um segundo `completeCart` depois do TTL encontra o link `order_cart` do pedido criado pelo primeiro (ainda não compensado) e devolve esse pedido sem autorizar; depois o primeiro compensa e o apaga. É um comportamento do core, independente do Mercado Pago. **Vira investigação separada** (proposta: INV-010, "lock do `completeCart` expira antes da autorização"), a abrir depois desta; nenhum arquivo criado agora.

### Verificações (resumo)

| Componente | Suportado nativamente? | Adaptação necessária | Risco |
|---|---|---|---|
| `pending_authorization` para "desconhecido" | parcial: cria o pedido e ignora falhas | substituir por `pending` + marcador (cart aberto) | com ele: pedido sem pagamento, sem novo cartão |
| Gravar estado antes do `POST` | sim, pelo hook `validate` com compensação | handler único + ação interna no `updatePayment` | uso de um hook de validação para gravar; compensação correta é crítica |
| Gravar estado na resposta ambígua | sim: provider **retorna** status + `data` | classificar erros no provider | resposta 400 em vez de 200: o storefront precisa tratar |
| Congelar os dados do cartão | não (a rota do projeto grava sempre) | recusa na rota e no `updatePayment` | rota sem guarda hoje: também vale para Pix/autorizado |
| Impedir apagar a session | sim (`deletePayment` que lança) | regra nova no `deletePayment` do cartão | trava mudanças no cart durante a indefinição |
| Retry da mesma operação | sim (SDK + idempotência do MP; H1 confirmada, [E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29)) | replay explícito com hash do body | retenção [não validado] |
| Lookup pela chave | **não** existe | — | — |
| Identificador no MP | sim (`external_reference`) | formato `<cart_id>-<attempt_id>` + parser | unicidade só do projeto; invariante 19 muda; H7 |
| Webhook achar a Order ambígua | não (invariante 19) | fallback por `attempt_id` + step que grava `order_id` | correlação nova: precisa das 5 condições e de testes |
| Webhook `failed` | ignorado pelo core | tratar na rota/provider (estado terminal) | — |
| Conclusão pelo webhook | sim (auto-captura + `completeCartAfterPaymentStep`) | provider lê a Order por `order_id` | — |
| Reautorizar pelo Admin | só para pedido `pending_authorization` | não se aplica ao cart aberto | sem visibilidade no Admin: alerta por log/job |
| Exposição | `data` redigido (invariante 24) | sinal público derivado; rota de update devolve `data` inteiro | a pendência de segurança existente passa a incluir o marcador |

## Plano técnico (proposto, não aprovado)

> **Substituído** pelo [plano de implementação do ADR-015](#plano-de-implementação-adr-015-proposto). Mantido como histórico. Diferenças principais: a compensação do hook não remove mais uma tentativa `authorizing`, e o erro definitivo é retornado pelo provider, não lançado.

### O que dá para implementar como proposto
- Idempotência do MP para retry da mesma operação.
- Identificador durável por tentativa, gravado antes do `POST`.
- Congelamento do cartão durante a indefinição.
- Webhook como caminho principal.
- Nenhum status customizado.

### O que precisa ser adaptado
- `pending_authorization` → `pending` + marcador em `data`.
- O identificador nasce no hook `validate`, não no Brick nem no provider.
- O webhook ganha um fallback por `attempt_id`, sem substituir a correlação por `mercadopago_order_id`.
- A reconciliação sem webhook é o replay por ação do cliente/operador, e o job é só de leitura.

### O que não é seguro
- Usar `external_reference = cart_id` para achar a Order.
- Concluir ausência por busca vazia.
- Gerar uma chave nova para uma tentativa `unknown`.
- Replay fora da retenção.
- Replay automático em segundo plano sem decisão de produto.
- Reusar a chave da tentativa ambígua com o body do cartão novo como "cerca": depende de semântica não documentada (uma requisição recebida mas não processada registra a chave?).

### E2E antes da implementação (etapa separada, aguarda autorização)

**Teste único no sandbox, sem código do projeto** (script/`curl` com o access token de teste):
1. `POST /v1/orders` de cartão (Visa `APRO`, `card_token` via `POST /v1/card_tokens`), com a chave K e `external_reference = cart_<ulid>-<ulid>` no formato proposto (58 caracteres).
2. Reenviar o mesmo body com K → **H1:** mesmo `order.id` e mesmo `payments[0].id`.
3. (Opcional) dois envios simultâneos com uma chave nova K2 e o mesmo body → **H3:** um `201` e um `423` ou o mesmo resultado.
4. `GET /v1/orders/{id}` → **H7:** `external_reference` idêntico ao enviado.
5. `GET /v1/orders?begin_date&end_date&external_reference=<valor>` logo em seguida e depois de 60 s → **H5:** exatamente 1 resultado; latência de indexação.
6. Com o túnel ativo: notificação `order.processed` com `data.external_reference` igual (H7-webhook). O backend responde 503 (Order paga sem session): esperado.

**Dados criados:** 1 Order sandbox paga, sem cart real (1 a mais com o passo 3). Nenhuma escrita no banco, nenhuma alteração administrativa.

**Evidência:** IDs truncados, HTTP, hash do body, tempo, respostas da busca. Nenhum token nem dado de cartão registrado.

**Aprovação:**
- H1 e H7 confirmados → a arquitetura segue;
- H1 falha → o replay não resolve, e a arquitetura volta à análise;
- H5 só define se o job usa a busca;
- H3 só define a mensagem de "processando".

**Risco:** notificações 503 repetidas da Order órfã (como a da INV-003). A busca foi bloqueada por um hook de segurança do ambiente na INV-008: pode exigir liberação.

H2 (retenção de 24 h) não é testada antes: o desenho trata qualquer marcador mais velho que 24 h como manual.

### Sequência de implementação (depois do E2E e do ADR)

0. **ADR** (substitui em parte o invariante 19 e complementa o ADR-014) e **invariantes novos** em `invariants.md`, na mesma alteração do código.
1. **Modelo de dados:** tipo de `mercadopago_card_attempt` e funções puras de transição de estado. Testes unitários primeiro.
2. **Provider, sem mudar o fluxo:** classificação de erros do `create` (definitivo × ambíguo) como função pura testada, e `external_reference` com `attempt_id` só quando houver tentativa.
3. **Hook `validate`:** grava `authorizing` + `attempt_id` + `body_sha256` via ação interna do `updatePayment` (transitória, como a do Pix); compensação que remove só `authorizing`; nada para Pix, nem para session já autorizada ou cart já com pedido.
4. **`authorizePayment` (cartão):**
   - `authorizing` → `POST`;
   - ambíguo → retorna `pending` + `unknown`;
   - definitivo → lança (a compensação limpa);
   - `unknown` + hash igual + dentro da retenção → replay;
   - `order_id` presente → `GET` (sem criar);
   - vencido → `NOT_ALLOWED`.
5. **Congelamento:** `updatePayment` e a rota de update recusam mudanças do cartão com `authorizing`/`unknown`; `deletePayment` recusa (mensagem clara). A rota de update passa a devolver dados redigidos (pendência existente).
6. **Webhook:** fallback por `attempt_id` (5 condições), step que grava `order_id` antes do evento, estado terminal para `failed`/`canceled`, 503 para duplicidade paga.
7. **Job de leitura:** tentativas `unknown`/`authorizing` com mais de N minutos → `GET`/busca → associa se achar exatamente 1; senão, alerta.
8. **Storefront:** sinal público, estados da Review, detecção de conclusão pelo webhook, mensagens.
9. **Testes:**
   - unitários em cada etapa;
   - E2E no sandbox com um wrapper do `fetch` que deixa o `POST` chegar e descarta a resposta (todas as tentativas do SDK), cobrindo os cenários da linha do tempo.
   - Regressão: cartão aprovado/recusado (INV-008), Pix #111, reembolso, cancelamento.

### Critérios de aceitação

| # | Caso | Verificação objetiva |
|---|---|---|
| 1 | Order não criada → nova tentativa possível | Wrapper derruba a conexão **antes** de enviar → `unknown`; Place order → exatamente 1 `POST` com a mesma chave → 201 ou 402. Com 402, a tentativa fica `failed`, o novo Brick é aceito e o próximo Place order usa novo `attempt_id` e nova chave. No MP: ≤ 1 Order por `attempt_id` (busca/GET). |
| 2 | Order criada e paga → sem segunda cobrança | Wrapper descarta a resposta **depois** do envio → `unknown`; novo Brick → recusado (4xx, `data` inalterada); `deletePayment`/troca de método → recusado; Place order → replay → mesmo `order.id`; 1 Payment, 1 Capture, 1 pedido; nenhum `POST` com outra chave. |
| 3 | Order criada e `failed` → nova tentativa | Cartão de recusa + resposta descartada → replay devolve o mesmo 402 (mesmo payment ID) → `failed`; novo Brick aceito; nova tentativa com novo `attempt_id` → 201. |
| 4 | Webhook atrasado → sem segunda cobrança | Caso 2 sem Place order: durante a espera, todo novo cartão/troca de método é recusado. Quando o webhook chega: fallback por `attempt_id` → `order_id` gravado → auto-captura → cart concluído, 1 pedido. |
| 5 | Retry da mesma tentativa | Teste unitário: para `attempt_id`/`data` iguais, o body canônico e a chave são idênticos em cada chamada (SDK, replay, Place order repetido); `body_sha256` confere. |
| 6 | Nova tentativa legítima | Teste unitário: depois de `failed`, os dados novos do Brick + Place order geram novo `attempt_id` e, portanto, novo `external_reference`, novo body e nova chave; nunca enquanto `authorizing`/`unknown`. |
| 7 | Correlação existente preservada | Testes `W` atuais passam sem mudança; Order com `external_reference` = `cart_id` (Pix, cartão antigo) continua correlacionada por `mercadopago_order_id`. |
| 8 | Nenhum dado sensível novo exposto | Testes `R`: marcador ausente de toda resposta da Store API; nenhum log com token/chave. |

### Novas investigações

- **INV-010 (proposta):** expiração do lock do `completeCart` (2 min) antes do fim da autorização (~247 s): efeito sobre o pedido criado antes da autorização. Separada, porque é do core.
- As hipóteses H1, H3, H5 e H7 não viram investigação: são resolvidas pelo E2E acima.
- H2 (retenção) fica como limite de projeto (24 h → manual) até haver evidência.

## E2E H1 e H7 (sandbox, 2026-09-29)

Executado em 2026-09-29, 23:06 no horário local (2026-09-30T02:06Z). Nenhum arquivo do projeto foi alterado, nenhuma configuração do Mercado Pago foi mexida, e não houve reembolso nem cancelamento.

### Método

- **Credencial:** a do `.env` do backend, conferida antes como usuário de teste (`GET /users/me`: `site_id` MLB, tag `test_user`). As Orders criadas têm prefixo `ORDTST`.
- **Script:** `medusa exec` com um script fora do repositório, chamando **o `authorizePayment` real do provider** (`paymentProviderService_.retrieveProvider("pp_mercadopago")`) duas vezes com o mesmo `input` (cópias profundas). Body e chave foram montados pelo código atual (`service.ts`, ADR-014); nenhuma session, cart ou Payment do Medusa foi criado ou lido.
- **Valor de H7:** o `external_reference` foi passado como `cart_id` no `input`, porque o provider usa `cart_id` sem transformação como `external_reference` (e em `description`). Os IDs são sintéticos e novos, sem cart real: `cart_<ULID>-<ULID>`, 58 caracteres. A chave base também é sintética (`payses_<ULID>`, sem session).
- **Cartão:** Visa de teste oficial do MLB, titular `APRO`, tokenizado por `POST /v1/card_tokens`. Payer: e-mail `@testuser.com` e o CPF de teste. PAN, CVV e token não foram registrados; só o prefixo do SHA-256 do token (`6bd38a805a97`).
- **Captura:** um wrapper do `fetch` global registrou, para `api.mercadopago.com`: método, path, HTTP, `x-request-id`, `X-Idempotency-Key` e o SHA-256 do body enviado. `Authorization` não foi registrado.
- **Leitura depois do teste:** `GET /v1/orders/{id}` e `GET /v1/orders` (busca), feitos só pelo SDK dentro do `medusa exec`. Uma tentativa de busca pelo shell, lendo o `.env`, foi bloqueada pelo hook de segurança do plugin Mercado Pago e não foi repetida por esse caminho.

### H1: replay depois de `201` (CONFIRMADA)

| Item | Chamada 1 | Chamada 2 (replay) |
|---|---|---|
| HTTP | 201 | 201 |
| `x-request-id` | `d2b34845-…` | `6fd76621-…` (outra requisição, recebida pelo MP) |
| `X-Idempotency-Key` (prefixo) | `d7397aba683020c6` | **igual** (`key_equal: true`) |
| SHA-256 do body | `b4e16ae51d1e7731…` | **igual** (`body_equal: true`) |
| `order.id` | `ORDTST01M3R110VCXBZXEPWPGXYXD33A` | **o mesmo** |
| payment ID | `PAY01M3R110VT23HQ2MCQ4WS6A98B` | **o mesmo** |
| status | `processed/accredited` | `processed/accredited` |
| retorno do provider | `captured` | `captured` |

Contagem no Mercado Pago:
- **1 Order:** o replay devolveu o mesmo `order.id`, e a busca exata pelo `external_reference`, feita cerca de 36 s depois, devolveu exatamente essa Order (`total: 1`).
- **1 Payment:** `GET` com `transactions.payments` de tamanho 1, `processed/accredited`.
- **1 captura:** `processing_mode` automático; `total_paid_amount = paid_amount = total_amount = 110.00`, sem segundo débito. O Mercado Pago não tem objeto Capture separado nesse modo.

No Medusa: 0 Payment e 0 Capture, porque o teste chamou o provider direto, sem Payment Module.

**Consequência para a arquitetura:** o replay com a mesma chave e o mesmo body é um resolvedor determinístico depois de um `201` perdido. Ele devolve a Order original, sem nova cobrança, pelo mesmo código que o `authorizePayment` usa hoje.
- Já estava observado para o `402` na INV-008.
- **Ainda não validado:** retenção (H2), replay concorrente (H3, fora desta etapa), token vencido (H4).

### H7: `external_reference` por tentativa (PARCIALMENTE CONFIRMADA)

- **No `GET`: confirmado.** `GET /v1/orders/ORDTST01M3R110VCXBZXEPWPGXYXD33A` devolveu `external_reference` idêntico, byte a byte, ao valor enviado (58 caracteres, `-` preservado). A comparação foi feita no `GET`, não na resposta do `POST`.
- **Webhook: não observado, por limitação do ambiente.**
  - O backend (`medusa develop`, porta 9000) estava no ar, mas não recebeu nenhuma requisição em `/hooks/payment/*` desde a subida (1h28 antes do teste) nem até ~1,5 min depois dele.
  - Nenhum processo de túnel foi encontrado no WSL.
  - O `notifications_history` do MCP [MCP 2026-09-29] não listou a Order do teste. As entregas mais recentes que ele mostra falharam com 404/502 antes de chegar ao backend, o que é compatível com um host de túnel desatualizado.
  - Não é falha de H7: é ausência de entrega. O caminho do webhook usa o mesmo `GET /v1/orders/{id}` que confirmou o valor ([webhook.md](../mercadopago/webhook.md), passo 7). Falta observar o valor chegando ao log da rota.

### H5: busca (observação, sem garantia)

| Momento | Filtro | Resultado |
|---|---|---|
| ~1 s depois da criação | `external_reference` exato | **0 resultados** |
| ~36 s depois | `external_reference` exato | **1**, a Order do teste |
| ~36 s depois | só o prefixo `cart_…` (sem o `-<attempt_id>`) | **0**: o filtro é por igualdade, não por prefixo |
| ~36 s depois | sem filtro (janela de 2 h) | 6 Orders da conta de teste |

Confirma a regra já adotada: busca vazia não prova ausência. Há atraso de indexação. A busca serve ao job de leitura, não ao congelamento nem à decisão de criar uma chave nova.

### Achado lateral: o `402` persiste uma Order `failed`

A listagem sem filtro mostrou duas Orders do cart da regressão da INV-008 (`cart_01M3QV3WZ32ZDPD0QKE4T0CPA7`), criadas com 5 s de diferença:

| Order | Status | Payment |
|---|---|---|
| `ORDTST01M3QV48R03YE7617AMDQ270S7` | `failed/failed` | `PAY01M3QV48RDN7Z1V61E6DAHS7E2`, `failed/rejected_by_issuer`: o mesmo payment ID do `402` registrado na INV-008 |
| `ORDTST01M3QV4DR1NTR0FW912SPCYVNC` | `processed/accredited` | a Order aprovada da mesma INV-008 |

Leitura read-only por `GET` [sandbox 2026-09-29]. Conclusões:
- a resposta `402` não traz o ID da Order, mas **a Order existe e fica `failed`**. Isso responde à limitação registrada na INV-008 (a INV-008 não foi editada);
- **o mesmo `external_reference = cart_id` tem mais de uma Order no mesmo cart** (uma `failed` e uma `processed`), mais uma evidência de que `cart_id` não identifica a tentativa.

Também apareceu `ORDTST01M3QV1TATVR69FTXJAHBX7G43` (`failed/rejected_by_issuer`) no cart `cart_01M3QV1E9W4S0TVW25YDV8XMN4`, da INV-008.

### Dados criados

| Dado | Detalhe |
|---|---|
| Order sandbox | 1: `ORDTST01M3R110VCXBZXEPWPGXYXD33A`, `processed/accredited`, R$ 110,00, `external_reference = cart_01M3R10T30G0Q87C26WB38ENQA-01M3R10T31SGZP3K3C7AM3GSRT` (IDs sintéticos; nenhum cart com esse ID existe) |
| Payment MP | 1: `PAY01M3R110VT23HQ2MCQ4WS6A98B` |
| Card token | 1 (uso único, consumido) |
| Medusa | nada: nenhuma escrita no banco |

A Order paga não pertence a nenhuma session. Se uma notificação dela chegar a um backend ligado, a resposta esperada é 503 (invariante 20: o cart do `external_reference` não existe, então nenhuma session guarda a Order), e o Mercado Pago tende a reenviar. É o mesmo caso da Order órfã da INV-003. Sem reembolso nem cancelamento, conforme o escopo.

### Conclusão da etapa

- **H1 confirmada:** o replay com a mesma chave e o mesmo body devolve a mesma Order e o mesmo payment, sem segunda cobrança.
- **H7 parcialmente confirmada:** o valor `<cart_id>-<attempt_id>` (58 caracteres) é aceito e preservado intacto no `GET`; a entrega pelo webhook não foi observável neste ambiente.
- **A arquitetura pode avançar para ADR.** As duas premissas críticas do Mercado Pago (resolução pelo replay e transporte do `attempt_id`) se sustentam.
- **Pendente antes de concluir a implementação:** observar uma notificação real com o novo formato. Pode ser feito no E2E da própria implementação, com túnel ativo. Não bloqueia o ADR, porque o webhook lê o mesmo `GET` já verificado.

## Plano de implementação (ADR-015, proposto)

> **Parcialmente substituído** pela [revisão de armazenamento de 2026-09-30](#revisão-armazenamento-do-card_token-2026-09-30). A tentativa e o token saem de `PaymentSession.data` e vão para um módulo próprio. As fases 1–5 mudam conforme a tabela "Alterações no plano" daquela seção; as fases 6–8 continuam valendo com os ajustes listados lá.

Não implementado. Conferido em 2026-09-29 contra:
- o código instalado do Medusa 2.20.1: `completeCartWorkflow`, `createHook` (`workflows-sdk`), `authorizePaymentSession`, `authorizePaymentSessionStep`, `processPaymentWorkflow`, `refreshPaymentCollectionForCartWorkflow`, `deletePaymentSessionsStep`/`validateDeletedPaymentSessionsStep`, o `error-handler` HTTP e `completeCartFields`;
- `service.ts`, a rota do webhook, a rota de update da session e o storefront do projeto;
- as skills `mercadopago-medusa` e `medusa-2-20-1`.

### Divergências entre a formulação inicial e o código

| Formulação inicial | Código real | Ajuste no plano |
|---|---|---|
| Erro definitivo → lançar → a compensação remove a tentativa | (a) Se o `POST` teve sucesso e a transação de `authorizePaymentSession_` falhou, os dados da session são revertidos e a tentativa continua `authorizing`; removê-la liberaria um segundo cartão com a Order paga. (b) Um replay de tentativa `unknown` que recebe `402` precisa **encerrar** a tentativa, e um provider que lança não grava nada. | Depois de enviar (ou tentar enviar) o `POST`, o provider **sempre retorna**: sucesso → status mapeado; definitivo → `pending` sem tentativa; ambíguo → `pending` + `unknown`. A compensação do hook converte `authorizing` em `unknown` e nunca remove. |
| Não persistir `card_token` | O replay (H1) exige o body idêntico, que contém o token; o token já é persistido pela rota de update | O token fica em `session.data` só enquanto a tentativa está aberta e é removido no estado terminal. **Requer confirmação humana** (ADR-015). |
| Erro retornado ao storefront por `CONFLICT` | O `error-handler` do Medusa 2.20.1 **substitui a mensagem** de `CONFLICT` (409) por uma genérica | Usar `NOT_ALLOWED` (400), que preserva `message` e `code`, com `code` estável. |
| Congelar "alterações relevantes no cart" | `refreshPaymentCollectionForCartWorkflow` só apaga as sessions quando o total ou a moeda mudam | Ficam bloqueadas só as mudanças que alteram o total ou a moeda (itens, frete, promoções, impostos). Endereço e e-mail sem efeito no total seguem livres. |
| Recusa (`402`) continua `200 { type: "cart", error }` | Um status retornado ≠ `authorized`/`captured`/`pending_authorization` leva o módulo a lançar `NOT_ALLOWED` | A recusa passa a responder **400** no `complete`. O storefront trata. |

### Fase 1: modelo da tentativa

Arquivo novo `apps/backend/src/modules/mercadopago/card-attempt.ts`, só com funções puras.

```text
session.data.mercadopago_card_attempt = {
  id: string                 // ULID de 26 caracteres, gerado no servidor
  state: "authorizing" | "unknown"
  started_at: ISO string     // criação da tentativa (base da janela de 24 h)
  updated_at: ISO string
  body_sha256: string        // sha256(canonicalJson(body)) do body da tentativa
  external_reference: string // `${cart_id}-${id}` (≤ 64, [A-Za-z0-9_-])
  order_id?: string          // quando conhecida (resposta, replay ou webhook)
}
```

- **Funções:** `formatAttemptReference(cartId, attemptId)`, `parseOrderReference(value)` (→ `{ cartId, attemptId? }`; aceita `cart_id` puro), `isOpenAttempt`, `isAttemptExpired(attempt, now)` (> 24 h), `isAttemptStale(attempt, now)` (`authorizing` há mais de 5 min, acima do pior caso de ~247 s do SDK), `classifyCreateError(error)` e `buildCardOrderBody(data, externalReference)`. O body sai do `authorizePayment` atual, para que o hook e o provider usem a mesma montagem.
- **Terminal = ausência da tentativa.**
  - No sucesso, `authorizePayment` grava `mercadopago_order_id` como hoje e **remove** `mercadopago_card_attempt` e `card_token`.
  - No erro definitivo, remove os dois.
- **Nunca persistidos:** CVV, número do cartão, body, chave derivada.
- **Persistidos até o fim da tentativa:** `card_token` (já persistido hoje) e `payer` (fora do escopo: ADR-006).

### Fase 2: hook `validate`

> **Substituído** [decisão humana 2026-09-30, opção B]: não existe hook `validate`. As regras 3, 4 e 5 são executadas pelo provider, sem compensação. Ver a [decisão de ownership](#ownership-das-regras-3-4-e-5-opção-b-2026-09-30).

Arquivo novo `apps/backend/src/workflows/hooks/complete-cart-validate.ts`: `completeCartWorkflow.hooks.validate(handler, compensate)`. O hook está livre no projeto e admite um só handler.
- **Entrada:** `{ input: { id }, cart }`. O `cart` traz `payment_collection.payment_sessions.*` (`completeCartFields`). Roda sob o lock do cart (`acquireLockStep`), antes de `create-order`.
- **O handler não faz nada quando:**
  - não há session `pp_mercadopago` processável;
  - a session é Pix (`isPixSession`);
  - a session não está `pending`;
  - o cart já tem pedido (consulta `order_cart`, porque o workflow conclui carts já concluídos sem autorizar).
- **Sem tentativa:** chama `paymentModule.updatePaymentSession` com a ação transitória `mercadopago_card_attempt_action: "begin"` (mesmo padrão de `mercadopago_pix_action`, invariante 5). O provider (Fase 3) gera `id`, `external_reference` e `body_sha256` e grava `authorizing`. O handler devolve `StepResponse(void, { session_id, attempt_id, previous: null })`.
- **Tentativa `unknown`, ou `authorizing` antiga (`isAttemptStale`):** ação `"resume"` → estado `authorizing`, mesmo `id`, mesmo `body_sha256`; `previous = "unknown"`.
- **Tentativa `authorizing` recente:** lança `NOT_ALLOWED`, code `mercadopago_card_attempt_in_progress`. Não chama o Mercado Pago.
- **Tentativa expirada (> 24 h):** lança `NOT_ALLOWED`, code `mercadopago_card_attempt_manual_review`. Não chama o Mercado Pago.
- **Compensação:** relê a session. Se a tentativa tem o **mesmo `id`** e está `authorizing`, grava `unknown` (ação `"settle_unknown"`). Qualquer outro estado (removida pelo provider, `unknown` gravado pelo provider, outra tentativa) → não faz nada.
  - Crash durante o `POST`: a compensação não roda, e `authorizing` expira como antiga (tratada como `unknown`).
  - Custo aceito: uma falha do workflow **antes** da autorização (por exemplo, estoque) também deixa `unknown`. O próximo Place order bem-sucedido faz o replay da tentativa que o cliente já confirmou.
- **Nova tentativa depois de um estado terminal:** a tentativa não existe mais → o próximo Place order com os dados novos do Brick cria outro `id`.

### Fase 3: provider (`service.ts`)

**`updatePayment`**, ações transitórias, nunca persistidas e descartadas pela allowlist da rota:
- `begin`:
  - exige session de cartão com `card_token`, `payment_method_id`, `payment_type_id`, `payer`, `cart_id`, e nenhuma tentativa aberta;
  - gera o ULID, monta `external_reference` e o body com `buildCardOrderBody`, e grava `body_sha256` e `authorizing`.
- `resume` e `settle_unknown`: transições da Fase 2.
- `attach_order` (webhook):
  - exige o mesmo `attempt_id`, tentativa aberta e nenhum `order_id`/`mercadopago_order_id` diferente;
  - grava `order_id`;
  - com a Order `failed`/`canceled`, remove a tentativa e o `card_token` (terminal).
- **Sem ação e com tentativa aberta:** recalcula o body com os dados recebidos e, se `sha256` ≠ `body_sha256`, lança `NOT_ALLOWED` (`mercadopago_card_attempt_pending`). Assim nenhuma mudança de cartão, parcelas, payer, tipo ou valor passa enquanto a tentativa está aberta, venha de qualquer caller.

**`deletePayment`:** com tentativa aberta, lança `NOT_ALLOWED`. O `validateDeletedPaymentSessionsStep` transforma isso em falha de `createPaymentSessions`/refresh do cart, pelo mesmo mecanismo do invariante 7.

**`authorizePayment` (cartão):**
1. **`order_id` conhecido** (`attempt.order_id` ou `mercadopago_order_id`): `GET /v1/orders/{id}`, **nunca `POST`**. Confere `external_reference` e valor.
   - paga → `captured`/`authorized`: grava `mercadopago_order_*` e remove tentativa e token;
   - `failed`/`canceled` → `pending` sem tentativa;
   - pendente → `pending` + `unknown`.
2. **Sem tentativa `authorizing`:** `pending` com os dados inalterados. É uma chamada fora do Place order; nenhum `POST` sem a tentativa gravada antes.
3. **Validação local falha** (token, tipo, parcelas, payer ausentes): `pending` sem tentativa (terminal; o cliente precisa reenviar o cartão).
4. **Body diferente do registrado** (`sha256(body) ≠ body_sha256`): `pending` + `unknown`, sem `POST`, com `logger.error`. Pelo congelamento, isso não deveria acontecer.
5. **`POST`** com `external_reference = attempt.external_reference`, body de `buildCardOrderBody` e chave `getCardOrderIdempotencyKey(base, body)` (ADR-014, inalterado; como o body passa a conter o `attempt_id`, a chave muda por tentativa e se mantém nos replays).
   - **2xx com `id` e payment:** status de `getStatusFromGateway`. Grava os `mercadopago_order_*`, remove tentativa e token. (`error` continua deixando a session `error`, como hoje.)
   - **Definitivo** (`MPBadRequestError` 400, `MPAuthenticationError` 401, `MPPaymentError` 402, `MPForbiddenError` 403, `MPValidationError` 422): `pending` sem tentativa e sem token.
   - **Ambíguo** (todo o resto: `MPConnectionError`, 409, 423, 429 final, 5xx final, 2xx sem `id`/payment, erro desconhecido): `pending` + `unknown`, com `last_error_class`, sem mensagem nem body.
6. O módulo grava o retorno e lança `NOT_ALLOWED` para `pending`. O step relança, e o `complete` responde **400**.

Pix, reembolso, `cancelPayment`, `retrievePayment`, `getPaymentStatus` e `getWebhookActionAndData`: sem mudança.

### Fase 4: rota de update (`POST /store/mercadopago/payment-sessions/:id`)

- Depois da verificação de posse e **antes** de `updatePaymentSession`: se `paymentSession.data.mercadopago_card_attempt` está aberta, `MedusaError(NOT_ALLOWED, "A previous card payment is still being confirmed.", "mercadopago_card_attempt_pending")` → **400** `{ type: "not_allowed", code: "mercadopago_card_attempt_pending", message }`, sem chamar o provider. O provider (Fase 3) é a segunda barreira.
- A resposta deixa de devolver `data` inteiro: passa pelo `toPublicMercadoPagoData` (fecha a pendência de segurança do status.md; o storefront não usa o corpo, segundo `updateMercadoPagoPaymentSession` em `lib/data/cart.ts`).
- `mercadopago_card_attempt` e as ações transitórias ficam fora da allowlist (invariante 2).

### Fase 5: webhook (`api/hooks/payment/[provider]/route.ts`)

Os passos 1–7 não mudam (HMAC, `data.id`, `GET`). Mudam o passo 8 em diante:

1. `parseOrderReference(order.external_reference)` → `cartId` (formato antigo = valor inteiro; novo = antes do `-`) e `attemptId?`. Formato inválido → 200 sem processar, como "sem `external_reference`" hoje.
2. **Correlação primária (atual):** sessions do cart com `mercadopago_order_id === data.id`. Uma → segue como hoje; mais de uma → 503.
3. **Fallback,** só com zero na primária **e** `attemptId`: sessions do cart com `data.mercadopago_card_attempt.id === attemptId`.

   | Resultado | Order paga | Order não paga |
   |---|---|---|
   | nenhuma | 503 + `logger.warn` (como hoje) | 200 |
   | mais de uma | 503 + `logger.error` (impossível por construção) | 503 + `logger.error` |
   | uma, tentativa aberta, sem `order_id`/`mercadopago_order_id` diferente, valor igual | associa (step abaixo) → emite `payment.webhook_received` com `sessionId` → `processPaymentWorkflow` (auto-captura → `authorizePayment` caminho 1 → `completeCartAfterPaymentStep`) | pendente: associa e responde 200; `failed`/`canceled`: associa como terminal (remove tentativa e token) e responde 200 |
   | uma, mas já guarda outra Order, ou tentativa terminal, ou valor diferente | 503 + `logger.error` (segunda Order da tentativa: conciliação manual) | 200 + `logger.warn` |

4. **Associação:** step novo `apps/backend/src/workflows/steps/attach-card-attempt-order.ts`, dentro de um workflow curto chamado pela rota. Faz `updatePaymentSession` com a ação `attach_order` e não chama `updatePaymentSession` direto na rota (dívida técnica registrada).
5. O Pix nunca tem `attemptId` e não passa pelo fallback.

### Fase 6: UX (sem implementar)

- **Sinal público:** rota nova `GET /store/mercadopago/carts/:id/card-payment-state` → `{ state: "none" | "confirming" | "manual_review" }`.
  - Sem IDs, `Cache-Control: no-store`, 410 sem corpo com o cart concluído (como `carts/:id/pix`, invariante 26).
  - O invariante 24 não muda.
- **Review com `confirming`:**
  - mensagem "Estamos confirmando seu pagamento anterior. Nenhuma nova cobrança será feita até a confirmação.";
  - Brick oculto e "Editar pagamento"/troca de método desabilitados;
  - o botão vira "Confirmar pagamento" (mesmo `placeOrder`), com o texto dizendo que confirmar pode concluir a cobrança no cartão já informado;
  - polling da rota de estado (5 s, como o Pix); 410 → conclusão pelo webhook → Place order devolve o pedido existente.
- **`manual_review`:** mensagem de contato com o suporte; nenhuma ação de pagamento.
- **Erros do `complete`:**
  - 400 `mercadopago_card_attempt_in_progress` → "confirmando";
  - 400 genérico do módulo → consultar a rota de estado: `confirming` → estado acima; `none` → "Pagamento recusado. Tente outro cartão." e Brick liberado.
- **Mudança no cart que altera o total durante `confirming`:** falha no servidor; o storefront consulta o estado e mostra a mesma mensagem.
- **Terminal:** estado `none` → o fluxo normal volta, e um novo envio do Brick + Place order gera nova tentativa.

### Fase 7: reconciliação

- **Webhook:** Fase 5. Caminho principal.
- **Replay pelo cliente:** Place order com tentativa `unknown` → hook `resume` → provider faz o `POST` com a mesma chave e o mesmo body (H1).
- **Replay pelo operador:** executar o mesmo `completeCartWorkflow` do cart (runbook, `medusa exec`), dentro de 24 h. Nenhum endpoint novo de cobrança.
- **Job** `apps/backend/src/jobs/watch-card-payment-attempts.ts`, a cada 15 min, **somente leitura**:
  - lista as sessions `pp_mercadopago` `pending` recentes e filtra em código as que têm tentativa aberta há mais de 5 min;
  - com `order_id`: `GET`;
  - sem `order_id`: busca exata por `external_reference` (janela `started_at` −5 min … +2 h);
  - registra `logger.warn` (achou 0, 1 ou mais Orders, e o status), e `logger.error` se passou de 24 h;
  - não grava na session, não associa, não cria nem repete Order.
- **Depois de 24 h:** o hook recusa (`manual_review`). Runbook novo `docs/runbooks/card-attempt-manual-review.md`:
  1. `GET`/busca read-only;
  2. se existe Order paga: associar (script com `attach_order`) e concluir pelo fluxo normal, ou reembolsar;
  3. se não existe: liberar a tentativa (script que a remove, com registro), e o cliente usa um cartão novo.

  Associar e liberar são sempre ações humanas.

### Fase 8: testes

**Unitários** (specs novos e existentes; `S`, `PS`, `W`, `J`, mais `CA` = `card-attempt.unit.spec.ts` e `CV` = `complete-cart-validate.unit.spec.ts`):
- **`CA`:**
  - formato e parse do `external_reference` (antigo, novo, inválido, ≤ 64);
  - `classifyCreateError` para cada classe/HTTP;
  - `isAttemptStale`/`isAttemptExpired`;
  - `buildCardOrderBody` igual ao body atual, exceto o `external_reference`.
- **Criação e estabilidade:**
  - `begin` gera `id`, `external_reference` e `body_sha256`, e recusa Pix e tentativa já aberta;
  - dois `authorizePayment` com a mesma tentativa → mesmo body e mesma chave (caso 5);
  - nova tentativa → novo `id`, novo body e nova chave (caso 6).
- **Hook (`CV`):**
  - não faz nada nos casos da Fase 2;
  - `begin`/`resume`;
  - `authorizing` recente → `NOT_ALLOWED` sem chamar o MP;
  - expirada → `manual_review`.
- **Compensação:**
  - `authorizing` com o mesmo `id` → `unknown`;
  - não toca em `unknown` gravado pelo provider, em tentativa removida nem em outra tentativa.
- **Erro definitivo:** 400/401/402/403/422 → `pending` sem tentativa e sem token.
- **Erro ambíguo:** `MPConnectionError`/409/423/429/5xx/2xx sem `id`/desconhecido → `pending` + `unknown`.
- **Sem tentativa:** nenhum `POST`.
- **`order_id` conhecido:** `GET` sem `POST`.
- **Bloqueio de update:**
  - rota → 400 com `code`, sem `updatePaymentSession`;
  - provider → `NOT_ALLOWED` com body diferente; body idêntico passa;
  - `deletePayment` recusa;
  - resposta da rota redigida.
- **Webhook (`W`):**
  - associação por Order ID sem mudança (os testes atuais continuam passando);
  - fallback 0 / 1 / >1;
  - session com outra Order;
  - valor diferente;
  - Order `failed` → terminal;
  - `external_reference` antigo e inválido;
  - Pix não passa pelo fallback.
- **Job (`J`):** nenhuma escrita (mocks sem `update*`) e alertas por idade.
- **Regressão:**
  - testes do ADR-014 ajustados ao novo `external_reference`;
  - Pix, reembolso e cancelamento sem mudança;
  - rota de estado (410, sem IDs).

**E2E sandbox** (`medusa exec` + rotas reais; um wrapper do `fetch` injeta a falha em `POST /v1/orders`):

| # | Cenário | Injeção | Aprovação |
|---|---|---|---|
| 1 | Order não criada → nova tentativa possível | aborta **antes** de enviar, nas 4 tentativas do SDK | `unknown`; Place order → 1 `POST` com a mesma chave → 201 (ou 402 → terminal → novo cartão aceito com nova chave); ≤ 1 Order por `attempt_id` |
| 2 | Criada e paga, resposta perdida | envia e descarta a resposta (4×) | `unknown`; Place order → mesma `order.id`; 1 Payment, 1 Capture, 1 pedido; nenhuma outra chave |
| 3 | Criada `failed`, resposta perdida | cartão `OTHE` + descarte | replay → mesmo 402 → terminal → novo cartão → novo `attempt_id` → 201 |
| 4 | Webhook depois do timeout | como o 2, sem Place order | notificação real → fallback → associação → auto-captura → cart concluído sem o navegador |
| 5 | Fallback por `attempt_id` | = 4 | log da rota com a correlação por tentativa; `mercadopago_order_id` gravado |
| 6 | Timeout sem webhook | como o 2, túnel desligado | job alerta sem escrever; Place order resolve |
| 7 | Retry idêntico | Place order repetido em `unknown` | mesma chave e mesmo hash de body (log do wrapper) |
| 8 | Troca de cartão bloqueada | novo envio do Brick e troca de método em `unknown` | 400 `mercadopago_card_attempt_pending`; `data` inalterada; troca de método falha |
| 9 | Terminal → novo cartão | depois do 3 | Brick aceito; nova tentativa aprovada |
| H7 | Webhook com o novo formato | **obrigatório, com túnel ativo** | `data.external_reference`/`GET` com `<cart_id>-<attempt_id>` observado no log da rota |

Regressão E2E: cartão aprovado sem falha, recusa `OTHE` (agora 400), Pix #111 e reembolso.

**Pré-requisito humano:** túnel ativo e URL de notificação configurada no painel (runbook `dev-webhook-tunnel`). O agente não altera a configuração do Mercado Pago.

### Arquivos

**Serão alterados ou criados** (backend):
- `modules/mercadopago/service.ts`;
- `modules/mercadopago/card-attempt.ts` (novo);
- `workflows/hooks/complete-cart-validate.ts` (novo);
- `workflows/steps/attach-card-attempt-order.ts` (novo) e o workflow que o envolve;
- `api/hooks/payment/[provider]/route.ts`;
- `api/store/mercadopago/payment-sessions/[id]/route.ts`;
- `api/store/mercadopago/carts/[id]/card-payment-state/route.ts` (novo);
- `jobs/watch-card-payment-attempts.ts` (novo);
- os specs correspondentes.

**Serão alterados ou criados** (storefront e docs):
- storefront: `lib/data/cart.ts`, `modules/checkout/components/payment-button/index.tsx`, `payment/index.tsx`, `mercadopago-payment-container/index.tsx` e um componente novo de estado na Review;
- docs, na mesma alteração do código: `mercadopago/invariants.md` (novos invariantes; o 19 muda; o 47 ganha a nota do `external_reference`), `mercadopago/README.md`, `mercadopago/webhook.md`, runbook novo, ADR-015 → aceito depois do E2E, `status.md`.

**Não serão alterados:**
- `medusa-config.ts` (identidade `pp_mercadopago`, ADR-001);
- o caminho Pix inteiro (`preparePixOrder`, `createPixOrder`, `authorizePix`, rotas Pix, capability, `payment-access`);
- `refundPayment` (ADR-011), `cancelPayment`, os workflows de cancelamento (ADR-012/013);
- `redact-mercadopago-data.ts` e o middleware (invariante 24 mantido);
- schema e migrations: nenhum campo nem tabela nova (tudo em `data` jsonb);
- dependências e SDK;
- o Brick em si, e `getWebhookActionAndData`.

### Pontos que ainda dependem de validação

- **H7 no webhook:** obrigatório no E2E final.
- **H2 (retenção da idempotência):** o limite de 24 h é uma escolha conservadora.
- **H3 (replay concorrente, `423`):** fora do escopo.
- **H4 (token vencido em replay tardio):** coberto pelo limite de 24 h, não validado.
- **Se um `422` deixa uma Order:** tratado como definitivo, não validado.
- **Efeito dos 400 do `complete` na Review atual:** a verificar na implementação.
- **Confirmação humana:** retenção do `card_token` até o estado terminal (ADR-015).

### Riscos remanescentes

- **Não-atomicidade:** falha do core depois de um `POST` aprovado (transação de `authorizePaymentSession_`, e `cancelPayment` do cartão chamado pelo módulo, que não tem teste) deixa a tentativa `unknown`. É resolvida pelo replay, que devolve a mesma Order, mas depende do fluxo seguinte.
- **Custo de UX:** uma falha antes da autorização (por exemplo, estoque) também deixa `unknown`, e o cliente não troca de cartão sem antes confirmar a tentativa.
- **Webhook sem entrega e cliente ausente:** a tentativa fica aberta até o alerta do job e o runbook.
- **Fora da janela de 24 h, ou Orders criadas por terceiros com o token:** conciliação manual.
- **Lock do `completeCart` (2 min) × SDK (~247 s):** o lado do pagamento fica coberto por `authorizing` recente; o lado do pedido Medusa é a INV-010 (proposta, não aberta).
- **`payer` (CPF) continua em `session.data`:** fora do escopo (ADR-006).

## Revisão: armazenamento do `card_token` (2026-09-30)

Pergunta: onde guardar o `card_token` de uma tentativa ambígua, para permitir o replay do **mesmo** body, sem expô-lo sem necessidade? "O token já está em `PaymentSession.data`" não foi aceito como justificativa. Nenhum código, migration ou escrita no banco.

### Fatos verificados

- **Por que o token é necessário:** o body do `POST /v1/orders` contém `transactions.payments[0].payment_method.token`, e a chave é derivada do body (ADR-014). O Mercado Pago não devolve o token (nem no `POST`, nem no `GET` da Order). Uma nova tokenização gera outro token, portanto outro body e outra chave: não é replay (H1).
- **Onde o token está hoje** [banco 2026-09-30, consulta read-only só com contagens, por `medusa exec`]:

  | Local | Linhas com `card_token` |
  |---|---|
  | `payment_session.data` | 38, todas ativas |
  | `payment.data` (cópia feita pelo Payment Module na autorização) | 33 |
  | `workflow_execution` (contexto persistido), só `complete-cart` | 13 de 34 |

  O `workflow_execution` guarda o token porque:
  - o `completeCartWorkflow` tem `store: true` e `retentionTime` de 3 dias;
  - o `workflow-engine-inmemory` 2.20.1 grava no banco o contexto das execuções terminadas com retenção (`saveToDb`);
  - o step `cart-query` lê `payment_collection.payment_sessions.*` (`completeCartFields`), que inclui `data`.

  Qualquer input de step que carregue o token também seria persistido.
- **Admin:** a consulta padrão de pedido (`admin/orders/query-config`) inclui `*payment_collections.payments`, com `data`. A redação do ADR-006 cobre só `/store`. [código 2.20.1; não verificado em requisição real]
- **Store:** a API genérica redige `data` (invariante 24). A rota de update do projeto devolve `data` inteiro, e a Server Action `updateMercadoPagoPaymentSession` (`lib/data/cart.ts`) repassa a resposta ao componente cliente.
- **Isolamento do provider:** o container de um provider é o container local do Payment Module: `manager`, `configModule`, `logger`, `__pg_connection__`, event bus, caching e os serviços do próprio módulo (`load-internal.js`). Outros módulos só entram se declarados em `dependencies` na declaração do módulo (`InternalModuleDeclaration.dependencies`, somados em `register-modules.js`). O provider guarda o container (`AbstractPaymentProvider`: `this.container = cradle`) e pode resolver o serviço de forma lazy. **Não exercitado em runtime.**
- **Criptografia disponível:** o projeto não tem helper. O `@medusajs/auth` 2.20.1 usa AES-256-GCM com `node:crypto` (`utils/mfa.js`: IV de 12 bytes, tag, `v1:iv:tag:ciphertext`), mas é um módulo interno, não API pública. O caminho é reproduzir a construção com `node:crypto`, sem criptografia própria nem importar o arquivo interno.
- **Redis:** não configurado (`redisUrl not found. A fake redis instance will be used`, log do `medusa exec`).
- **Precedente de módulo com tabela própria:** `paymentAccess` (ADR-007), com `model.define`, `MedusaService` e uma migration própria aplicada isoladamente.
- **Uso único e validade de até 7 dias do CardToken:** informação do responsável [decisão humana 2026-09-30]; não localizada na busca de documentação desta sessão. O desenho não depende dela, porque destrói o token em no máximo 24 h.

### Comparação

| Opção | Segurança | Durabilidade | Complexidade | Exposição ao storefront | Restart seguro | Recomendação |
|---|---|---|---|---|---|---|
| **A**: `PaymentSession.data` (texto claro) | baixa: o token se espalha para `payment.data`, `workflow_execution` (3 d) e o Admin; a limpeza da session não os alcança | alta | baixa | redigido na Store genérica; em claro na resposta da rota de update | sim | **não** |
| **A′**: `PaymentSession.data` criptografado | média: sem texto claro, mas o ciphertext se espalha pelos mesmos lugares; "destruir" não é real | alta | baixa-média | ciphertext na rota de update | sim | não |
| **B**: módulo próprio, token criptografado | **alta**: um único lugar, só o ciphertext, decifrado só no provider, destruído de fato, chave fora do banco | **alta** (PostgreSQL) | média-alta: módulo, migration, `dependencies`, chave | **nenhuma** (nenhuma rota lê a tabela) | **sim** | **sim** |
| **C**: Redis / secret manager | média-alta (TTL natural) | Redis: depende de persistência não configurada; secret manager: alta | alta: infraestrutura nova | nenhuma | Redis: incerto | não |
| **D**: não guardar o token | máxima | — | — | — | — | **impossível**: sem token não há o mesmo body (H1). Só em memória: perde no restart, no deploy e entre instâncias |

### Arquitetura recomendada (B)

```text
Brick onSubmit → rota de update (servidor)
   ├─ PaymentSession.data  ← só dados não secretos: payment_method_id, payment_type_id, issuer_id,
   │                          installments, payer, cart_id, amount … e card_attempt_id (referência)
   └─ mercadopago_card_attempt ← { attempt_id, payment_session_id, cart_id, state: submitted,
                                   card_token_encrypted, ... }        (token cifrado antes de gravar)
Place order → hook validate (sob o lock) → tentativa submitted → authorizing (+ body_hash, external_reference)
→ provider.authorizePayment → lê a tentativa (dependency) → decifra o token → monta o body → POST
   → registra o resultado na tentativa (resolved/failed/unknown; token destruído se terminal)
Webhook → correlação atual → fallback: external_reference → attempt_id → tentativa → grava order_id → evento
Job (só leitura) → tentativas abertas → GET/busca → alerta ; 24 h → token destruído, manual_review
```

**Modelo** (`mercadopago_card_attempt`):

> Esboço substituído pelo [desenho da entidade de 2026-09-30](#desenho-da-entidade-mercadopago_card_attempt-2026-09-30): sem `attempt_id` separado, `superseded` → `replaced`, sem `released`, e `encrypted_card_token` com `kid` no envelope.

- colunas: `id` (PK com prefixo), `attempt_id` (ULID de 26 caracteres, único), `payment_session_id`, `cart_id`, `state`, `body_hash`, `external_reference` (único), `card_token_encrypted` (anulável), `encryption_key_id`, `mercadopago_order_id` (anulável), `last_error_class` (anulável), `submitted_at`, `authorizing_at`, `resolved_at`, `token_destroyed_at`, `created_at`, `updated_at`, `deleted_at`;
- estados: `submitted` → `authorizing` → `unknown` | `resolved` | `failed`; e também `superseded` (novo envio antes do Place order), `released` (liberação manual) e `expired` (24 h);
- índice único parcial: no máximo **uma** tentativa em `submitted`/`authorizing`/`unknown` por `payment_session_id`.

### Ciclo de vida do CardToken

| Momento | Token | Detalhe |
|---|---|---|
| **Criação** | entra cifrado | na rota de update, no envio do Brick com `card_token`. Uma tentativa `submitted` anterior da mesma session vira `superseded`, e o token dela é destruído; com tentativa `authorizing`/`unknown`, o envio é recusado (400 `mercadopago_card_attempt_pending`). O token nunca vai para `PaymentSession.data`. |
| **`submitted`** | disponível | até o Place order, a remoção da session ou 24 h |
| **`authorizing`** | disponível | do hook até o resultado do `POST` (normalmente segundos; pior caso do SDK ~247 s) |
| **`unknown`** | disponível | só para o replay da mesma tentativa, pelo Place order ou por um operador, **até 24 h depois de `submitted_at`** |
| **Terminal** (`resolved`, `failed`, `superseded`, `released`) | **destruído** | coluna anulada e `token_destroyed_at` gravado na mesma operação da transição |
| **Falha de aplicação antes do `POST`** | disponível | a tentativa fica `authorizing`; a compensação do hook (se rodar) a torna `unknown`; se o processo morreu, ela é tratada como `unknown` depois de 5 min. O replay executa uma vez: se o `POST` nunca saiu, é a primeira execução |
| **Restart/deploy** | disponível | persistido no PostgreSQL, com a chave na variável de ambiente (a mesma entre deploys) |
| **Timeout** | disponível | a tentativa fica `unknown`, e o token é mantido para o replay |
| **24 h** | **destruído** | `expired`, sem replay; o hook recusa com `manual_review`; o job registra `logger.error`; o runbook define a conciliação manual |
| **Remoção da session** | destruído se `submitted`; recusa se aberta | `deletePayment` recusa com `authorizing`/`unknown` (congelamento); com `submitted`, destrói |

A destruição é **atualização da coluna para `NULL`**, não exclusão do registro: os metadados continuam para auditoria.

### Criptografia

- **Algoritmo:** AES-256-GCM, `node:crypto`, com a mesma construção do `encryptSecret` do `@medusajs/auth`:
  - IV aleatório de 12 bytes e tag de 16 bytes;
  - **AAD = `attempt_id` + `payment_session_id`**, para que o ciphertext só abra no próprio registro;
  - formato `v1:<kid>:<iv>:<tag>:<ciphertext>`.
- **Chave:**
  - 32 bytes aleatórios, em variável de ambiente (por exemplo `MERCADOPAGO_CARD_TOKEN_KEYS`, com `kid` → chave em base64, e `MERCADOPAGO_CARD_TOKEN_KEY_ID` = `kid` atual);
  - lida nas opções do módulo, **nunca no banco**, nunca no `.env.template` com valor, e nunca registrada em log;
  - o módulo recusa a inicialização sem chave válida.
- **Rotação:** incluir a nova chave no anel e trocar o `kid` atual; a chave antiga sai 24 h depois (vida máxima do token). Nenhuma recriptografia em massa.
- **Onde cifra e decifra:**
  - cifra no serviço do módulo, antes de criar ou atualizar a entidade: a entidade nunca recebe texto claro, e nenhum input de step leva o token;
  - decifra **só** no provider, dentro de `authorizePayment`, imediatamente antes do `POST`, e nunca devolve nem registra o token.
- **Hash do token:** não é guardado. Não há busca nem deduplicação por token, e o hash não permite replay. O `body_hash` serve só para conferir que o replay reconstrói o mesmo body.

### Retenção

| Dado | Retenção |
|---|---|
| `card_token_encrypted` | até o primeiro de: estado terminal, remoção da session ou 24 h desde `submitted_at` |
| Metadados da tentativa (IDs, estado, `body_hash`, `external_reference`, Order, timestamps, `last_error_class`) | proposta de 90 dias depois do fim (auditoria e conciliação); decisão a confirmar |
| `PaymentSession.data` | sem token e sem dados da tentativa além de `card_attempt_id` |
| `workflow_execution` | sem token: nem a session nem os inputs de step o carregam |

**Job de limpeza** (junto do job de vigilância ou separado, no padrão do `cleanup-payment-access-grants`):
- anula tokens vencidos (24 h) e marca `expired`;
- depois de 90 dias, apaga os metadados de tentativas terminais;
- é idempotente e registra só contagens.

### Impacto no Medusa 2.20.1

- **Módulo novo** `src/modules/mercadopago-card-attempt/` (`model.define`, `MedusaService`, migration), no padrão do `payment-access`.
- **Transações:**
  - as transições de estado são métodos do serviço com `@InjectTransactionManager` e atualização condicional (`where state = <esperado>`), resolvendo a concorrência por compare-and-set;
  - o índice único parcial garante uma tentativa aberta por session.
- **Acesso:**
  - rota de update, hook `validate`, webhook, rota de estado e jobs: `container.resolve("mercadopagoCardAttempt")` (container global);
  - provider: por `dependencies: ["mercadopagoCardAttempt"]` na declaração do `@medusajs/medusa/payment` em `medusa-config.ts`, resolvido de forma lazy no provider (não no construtor). **Spike obrigatório antes da implementação:** confirmar que `this.container.mercadopagoCardAttempt` resolve em `medusa develop`, em `medusa exec` e nos testes.
- **Compensação:**
  - o hook `validate` passa `{ attempt_id, previous_state }` à compensação. A compensação faz `authorizing → unknown` (compare-and-set) e nada em qualquer outro estado;
  - o resultado gravado pelo provider é independente da transação do Payment Module e não é revertido.
- **Provider sem tentativa aberta:** não faz `POST` de cartão. As autorizações de cartão só saem pelo Place order.
- **Workflow checkpoints:** nenhum step recebe ou devolve o token. O hook trabalha com `attempt_id` e estado.

### Migrations necessárias

- **1 migration** do módulo novo (tabela `mercadopago_card_attempt` + índices), gerada com `db:generate` e aplicada com `db:migrate`, só com autorização explícita (CLAUDE.md). É aditiva: não altera nenhuma tabela existente.
- **Nenhuma migration** em tabelas do Medusa.
- **Dados existentes** (fora da migration; exige autorização para escrita no banco):
  - remover `card_token` de `payment_session.data` e de `payment.data` antigos (38 e 33 linhas em 2026-09-30);
  - o `workflow_execution` expira sozinho (3 dias) depois que o token deixar de entrar em `data`.

### Alterações no plano da INV-009

| Fase | Antes (plano de 2026-09-29) | Agora |
|---|---|---|
| 1. Modelo | `session.data.mercadopago_card_attempt` | módulo `mercadopagoCardAttempt` (tabela acima); `session.data` só com `card_attempt_id` |
| 2. Hook `validate` | grava em `session.data` via `updatePaymentSession` com ação transitória | faz a transição `submitted → authorizing` no módulo (compare-and-set), com `body_hash` e `external_reference`; compensação `authorizing → unknown` |
| 3. Provider | retornava `pending` para gravar a tentativa na session; recusava pelo `body_sha256` em `updatePayment` | lê a tentativa pelo `dependency`, decifra só para o `POST` e registra o resultado no módulo; **relança** erros definitivos e ambíguos (a session fica `pending`, como hoje; `complete` → 200 com `PAYMENT_AUTHORIZATION_ERROR`). Deixa de existir a mudança "recusa → 400" |
| 4. Rota de update | recusava com tentativa aberta | também: `card_token` vai **para o módulo, cifrado**, e sai de `data`; nova tentativa `submitted` (a anterior `submitted` → `superseded`); resposta redigida |
| 5. Webhook | fallback pesquisava sessions por `data` e associava via `updatePaymentSession` | fallback por `attempt_id` no módulo (índice único) → confere session/cart/valor → grava `mercadopago_order_id` na tentativa → emite o evento; o provider faz `GET` por esse ID |
| 6. UX | rota de estado lia `data` | rota de estado lê o módulo; mesmos estados públicos |
| 7. Reconciliação | job lia `data` | job lê o módulo; job de limpeza de token e metadados |
| 8. Testes | — | acrescentar: cifra/decifra com AAD, `kid` e rotação; ciphertext trocado entre registros falha; o token nunca aparece em `session.data`, `payment.data`, inputs/outputs de step, logs ou respostas; destruição em cada transição terminal e em 24 h; compare-and-set concorrente; `dependencies` resolvido no provider; restart (novo processo decifra e faz o replay) |

**Arquivos adicionais:**
- novos: `src/modules/mercadopago-card-attempt/` (modelo, serviço, criptografia, migration, specs) e o job de limpeza;
- alterados: `medusa-config.ts` (registro do módulo e `dependencies` do payment, **sem `id`**) e `.env.template` (nomes das variáveis, sem valor).

**Arquivos que deixam de ser alterados** para guardar a tentativa: nenhum dado de tentativa em `redact-mercadopago-data.ts`; o invariante 24 fica como está.

### Riscos remanescentes

- ~~**`dependencies` do payment module não exercitado em runtime**~~: resolvido pelo [spike de 2026-09-30](#spike-dependency-injection-do-módulo-próprio-2026-09-30) (suportado, com restrições).
- **Chave de criptografia:** perda da chave = tentativas abertas sem replay (vão para manual); vazamento da chave + banco = tokens de ≤ 24 h expostos. Mitigação: a chave fora do banco e o prazo curto.
- **Crash entre a resposta do Mercado Pago e a gravação no módulo:** a tentativa fica `authorizing` → `unknown` → o replay devolve a mesma Order (H1).
- **Dados antigos:** tokens já gravados em `payment_session.data`, `payment.data` e `workflow_execution` continuam lá até a limpeza autorizada.
- **Uso único e validade de 7 dias do token:** não verificados nesta sessão; o desenho não depende deles.
- **Continuam valendo:** H2, H3, H7 no webhook e a INV-010 (proposta).

## Spike: dependency injection do módulo próprio (2026-09-30)

Pergunta: um módulo próprio, declarado como dependência do payment module, é resolvido e utilizável pelo provider, por workflows e pelo webhook no Medusa 2.20.1 deste projeto? Em que transação ficam as operações dele?

### Investigação (código instalado, 2.20.1)

- **Definição e registro:**
  - `Module(nome, { service })` (`@medusajs/framework/utils`, `modules-sdk/module.js`) monta a definição;
  - no `medusa-config.ts`, `{ resolve: "./src/modules/<m>" }`;
  - a chave no container é o `nome` do `Module()` (o `serviceName` do joiner config; `define-config.js`); nenhum `id` é exigido;
  - módulo sem modelos não gera migration nem tabela.
- **Dependência:**
  - `dependencies: ["<chave>"]` na declaração do `@medusajs/medusa/payment` é somado às dependências da definição (`register-modules.js`, `getInternalModuleResolution`);
  - cada dependência é registrada no container **local** do módulo como `asFunction(() => container.resolve(dep, { allowUnregistered: true }))` (`load-internal.js`);
  - os providers do módulo são construídos com esse container local (`localContainer.cradle`), e o `AbstractPaymentProvider` o guarda em `this.container`.
- **Ciclo de vida:**
  - os módulos carregam em paralelo (`promiseAll`, `module-loader.js`);
  - serviços e providers são singletons do awilix, criados no primeiro `resolve`;
  - a dependência é resolvida a cada acesso, devolvendo o singleton global.
- **Workflow e webhook:** usam o container global (`container` do step, `req.scope` da rota), acessível pela chave do módulo.
- **Transação:**
  - o Payment Module chama o provider só com `input`, sem `sharedContext` (`payment-provider.js`), e `authorizePaymentSession` usa `@InjectManager`, sem transação, na chamada ao provider;
  - `@InjectTransactionManager` só entra numa transação existente se o chamador passar `sharedContext.transactionManager`; senão abre e **confirma** a própria (`inject-transaction-manager.js`);
  - o "rollback" de workflow é compensação, não rollback de banco.

**Conclusão da investigação: DEPENDENCY SUPPORTED WITH CONSTRAINTS.**
1. Acessar a dependência de forma **lazy** (no método, nunca no construtor), porque o carregamento é paralelo.
2. **Checar a presença:** uma dependência declarada com chave errada ou ainda não registrada devolve `undefined` (`allowUnregistered`), sem erro.
3. A chave em `dependencies` é o nome do `Module()`. No payment module, nunca adicionar `id` (ADR-001).
4. As operações do módulo ficam **fora** de transações de outros módulos e sobrevivem à falha do workflow. Em compensação, **não são desfeitas sozinhas**: cada reversão precisa ser uma compensação explícita.

### Execução do spike (temporário, removido)

- **Artefatos temporários**, todos marcados `[SPIKE]`:
  - módulo `spikeDependencyProbe` sem modelos, com `health()` e `transactionProbe()`: uma transação na conexão PG do módulo que só atribui um xid (`pg_current_xact_id()`), sem gravar linha;
  - `dependencies: ["spikeDependencyProbe"]` no payment module;
  - método `spikeDependencyProbe()` no provider;
  - workflow de 2 steps (probe + falha forçada, com compensação);
  - rota `GET /spike/dependency-probe`;
  - log no início da rota real do webhook.
- **Runtime:** `medusa develop` real na porta 9001 (processo próprio), `curl` local e `medusa exec`. Nenhum dado de produção, nenhuma chamada ao Mercado Pago, nenhuma escrita em tabela.

| Teste | Execução 1 (pid 157465) | Execução 2, depois de restart completo (pid 157751) |
|---|---|---|
| Provider (`retrieveProvider("pp_mercadopago").container.spikeDependencyProbe`) | `ok`; transação `5208` → `committed` | `ok`; `5211` → `committed` |
| Rota (`req.scope`) | `ok` | `ok` |
| Workflow bem-sucedido (step resolve o módulo) | 0 erros | 0 erros |
| Workflow com falha depois do step | erro forçado; compensação executada (log); transação do step `5210` → **`committed`** depois da falha | idem (`5213` → `committed`) |
| Provider e global são o mesmo singleton | `true` | `true` |
| Webhook real (`POST /hooks/payment/mercadopago` sem `data.id`) | log `[SPIKE] ... {"status":"ok"}`; resposta **400** (comportamento normal) | idem |
| `medusa exec` (pid 157896) | provider resolveu, transação `5214`, mesmo singleton | — |
| Negativo: provider acessando módulo **não declarado** (`paymentAccess`) | `AwilixResolutionError`; no container global, o módulo existe | — |

**Conclusões:**
- a dependência funciona no runtime real (servidor, restart e `medusa exec`);
- o isolamento do container do provider é real: sem `dependencies`, o acesso falha;
- uma transação do módulo aberta num step continua confirmada depois da falha e da compensação do workflow.

O spike não mede a criação de um registro de tabela sob `@InjectTransactionManager` num `MedusaService` com modelo (não havia tabela); isso segue a regra do decorador acima.

**Limpeza:**
- os 3 arquivos novos foram removidos, e as 3 edições foram revertidas (hash SHA-256 idêntico ao de antes do spike);
- nenhum resíduo `spike` no repositório, inclusive em `.medusa/` (ignorado);
- nenhuma migration, tabela ou dado criado;
- os servidores de teste foram encerrados, e a porta 9001 ficou livre;
- o `medusa develop` de outra sessão (porta 9000) recarregou os arquivos temporários pelo watcher e voltou ao normal depois da remoção (`/health` 200, rota do spike 404).

**Depois da limpeza:** `tsc --noEmit` limpo; `service.unit.spec.ts` e `route.unit.spec.ts` do webhook: 2 suítes, 131 testes passando.

## Desenho da entidade `mercadopago_card_attempt` (2026-09-30)

Fase 1 (investigação e spike). **Fase 2 (módulo definitivo e migration) aguarda autorização explícita.** Referências no código 2.20.1:
- DML `model.define` / `MedusaService`;
- `build-indexes.js`: índice com `where` em string; o Medusa acrescenta `AND deleted_at IS NULL`;
- precedente do projeto: `payment_access_grant` (IDs de outros módulos como `text`, sem FK).

### Schema proposto

A migration gerada por `medusa db:generate` para este modelo, no spike, está reproduzida abaixo (nomes de índice com o prefixo definitivo).

| Campo | Tipo | Null | Índice/constraint | Finalidade |
|---|---|---:|---|---|
| `id` | `text` (`model.id({ prefix: "mpca" })`) | não | PK | ID da tentativa (`mpca_<ULID>`); o ULID compõe o `external_reference` |
| `payment_session_id` | `text` | não | índice; **único parcial** `WHERE state IN ('submitted','authorizing','unknown','expired') AND deleted_at IS NULL` | session da tentativa. **Sem FK:** é de outro módulo, a session é apagada fisicamente pelo core e a tentativa precisa sobreviver para auditoria |
| `cart_id` | `text` | não | — | conferência do webhook (cart do `external_reference`). **Sem FK:** outro módulo |
| `state` | `text` + `CHECK` (`model.enum`) | não | índice | máquina abaixo |
| `external_reference` | `text` | não | **único** | `<cart_id>-<ULID do id>` (≤ 64, `[A-Za-z0-9_-]`, validado no código); chave do fallback do webhook |
| `body_sha256` | `text` | sim | — | hash do body canônico, gravado em `authorizing`; confere o replay |
| `encrypted_card_token` | `text` | sim | — | envelope `v1:<kid>:<iv>:<tag>:<ciphertext>` (base64url); `NULL` depois da destruição |
| `token_destroyed_at` | `timestamptz` | sim | — | quando o token foi destruído |
| `mercadopago_order_id` | `text` | sim | **único parcial** `WHERE mercadopago_order_id IS NOT NULL AND deleted_at IS NULL` | Order associada (resposta, `GET` ou webhook); uma Order nunca pertence a duas tentativas |
| `last_error_class` | `text` | sim | — | classe do último erro do `POST` (sem mensagem nem body) |
| `authorization_started_at` | `timestamptz` | sim | — | primeiro `POST`; base da janela de 24 h do replay |
| `authorizing_at` | `timestamptz` | sim | — | última entrada em `authorizing`; detecção de `authorizing` antiga (5 min) |
| `ended_at` | `timestamptz` | sim | — | entrada em estado terminal; base da retenção (90 dias) |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | não/não/sim | `deleted_at`: índice parcial | automáticos do DML; `created_at` = envio do cartão |

Decisões:
- **Sem `attempt_id` separado:** o ULID do `id` basta, e o `external_reference` é a chave única de busca.
- **Sem coluna de `kid`:** a chave usada fica dentro do envelope, e a rotação é de 24 h, sem consulta por chave.
- **Sem colunas de valor ou moeda:** o `body_sha256` cobre o body, e a conferência do valor usa a session.
- **Nenhum soft delete na operação:** os estados terminais substituem a exclusão. A limpeza de retenção apaga fisicamente as linhas terminais com mais de 90 dias. `deleted_at` fica só porque o DML o cria.

### Máquina de estados

Estados **vivos** (no máximo um por session, pelo índice único parcial): `submitted`, `authorizing`, `unknown`, `expired`. Estados **que bloqueiam** novo cartão, troca de método e alteração do total: `authorizing`, `unknown`, `expired`. **Token mantido:** `submitted`, `authorizing`, `unknown`. **Token destruído na mesma atualização da transição:** `resolved`, `failed`, `replaced`, `expired`. **Replay:** só a partir de `unknown` (→ `authorizing`), dentro de 24 h desde `authorization_started_at`.


> Ownership das regras 3, 4, 5 e 8 nesta tabela substituída pela [opção B](#ownership-das-regras-3-4-e-5-opção-b-2026-09-30): provider, sem compensação do hook.

| # | De → para | Quem | Condição (compare-and-set: `UPDATE … WHERE id = ? AND state = ?`) |
|---|---|---|---|
| 1 | ∅ → `submitted` | rota de update (envio do Brick) | na mesma transação da regra 2; o índice único recusa uma segunda tentativa viva |
| 2 | `submitted` → `replaced` | rota de update (novo envio), `deletePayment`, job (> 24 h sem Place order) | `state = 'submitted'` |
| 3 | `submitted` → `authorizing` | hook `validate` (Place order) | `state = 'submitted'`; grava `body_sha256`, `authorization_started_at`, `authorizing_at` |
| 4 | `unknown` → `authorizing` | hook `validate` (replay) | `state = 'unknown'` e dentro de 24 h |
| 5 | `authorizing` → `authorizing` | hook `validate` (`authorizing` antiga, crash) | `state = 'authorizing' AND authorizing_at < now() - 5 min` |
| 6 | `authorizing` → `resolved` | provider (2xx; ou `GET` paga) | `state = 'authorizing'`; grava `mercadopago_order_id` |
| 7 | `authorizing` → `failed` | provider (erro definitivo; ou `GET` `failed`/`canceled`) | `state = 'authorizing'` |
| 8 | `authorizing` → `unknown` | provider (ambíguo); compensação do hook | `state = 'authorizing'` |
| 9 | `unknown` → `failed` | webhook (Order da tentativa `failed`/`canceled`) | `state = 'unknown'` |
| 10 | `authorizing`/`unknown` → `expired` | job (24 h desde `authorization_started_at`) | `state IN (...)` e janela vencida |
| 11 | `expired` → `resolved` / `failed` | operador (runbook) | `state = 'expired'`; decisão humana registrada |

- **Sem transição de estado:** o webhook, ao encontrar a Order paga de uma tentativa `authorizing`/`unknown`, só grava `mercadopago_order_id` (se ainda for nulo). O provider faz a transição 6 no `GET`.
- **Fora da máquina:**
  - `superseded` virou `replaced`;
  - `released` foi removido, porque a liberação manual é a regra 11 para `failed`;
  - `expired` a partir de `submitted` não existe: uma tentativa nunca confirmada vira `replaced`, sem bloquear.

### Unicidade: uma tentativa viva por Payment Session

- **Banco:** índice **único parcial** em `payment_session_id` `WHERE state IN ('submitted','authorizing','unknown','expired') AND deleted_at IS NULL`, declarado no DML (`where` em string) e gerado por `db:generate`. Estados terminais não entram no índice, então o histórico é ilimitado.
- **Transições:** sempre por compare-and-set (`UPDATE … WHERE id = ? AND state = <esperado> RETURNING id`). Zero linhas significa que outra requisição ganhou e a operação é recusada. É um método próprio do serviço (knex do `baseRepository_` ou `nativeUpdate`), porque o `update` gerado pelo `MedusaService` não expressa a condição de estado.
- **Novo envio do cartão:** numa única transação do módulo, faz a regra 2 (`submitted` → `replaced`), se houver, e a regra 1 (`insert`). Uma corrida entre dois envios termina com um `insert` recusado pelo índice (o serviço traduz para "já existe"), sem duas tentativas vivas.
- Validação só no código não basta, e o spike mostrou o índice e o compare-and-set funcionando sob concorrência (abaixo).

### Segurança (ciclo do ciphertext, sem implementar a criptografia)

- **Coluna:** `encrypted_card_token` `text` com o envelope `v1:<kid>:<iv>:<tag>:<ciphertext>`. Gravada só na regra 1, já cifrada pelo serviço do módulo.
- **Destruição:** na transição para `resolved`/`failed`/`replaced`/`expired`, na mesma instrução: `encrypted_card_token = NULL` e `token_destroyed_at = now()`.
- **Metadados mantidos depois da destruição:** `id`, `payment_session_id`, `cart_id`, `state`, `external_reference`, `body_sha256`, `mercadopago_order_id`, `last_error_class` e os timestamps.
- **Nenhum token real foi gravado neste spike.**

### Transação: teste real com linha persistida (2026-09-30)

**Método:**
- **Módulo temporário** `spikeInv009CardAttempt`, com o **modelo proposto** acima sob a tabela `spike_inv009_card_attempt`, registrado no `medusa-config.ts` e declarado em `dependencies` do payment module, mais um método temporário no provider.
- **Migration** gerada por `medusa db:generate spikeInv009CardAttempt`. Só o `up()` dessa migration foi executado, por `medusa exec`: nenhuma outra migration rodou e nada foi registrado em `mikro_orm_migrations`.
- **Linhas:** fictícias (`payses_SPIKE_*`, `cart_SPIKE`), sem token nem dado de pagamento.
- **Execuções:** o script inteiro rodou duas vezes (a primeira saída perdeu o T4c no filtro), com resultados idênticos.

| Teste | Resultado |
|---|---|
| **T1:** workflow → step `createSpikeCardAttempts` (linha no PostgreSQL) → step seguinte falha → compensação executa (log) → `SELECT` direto | **1 linha**: sobreviveu |
| **T2:** workflow → step → **provider** → dependência → `create` → falha → compensação → `SELECT` | **1 linha**: sobreviveu |
| **T3:** controle: `create` com `transactionManager` explícito de uma transação externa do próprio módulo, que lança | **0 linhas**: participa e reverte |
| **T4a:** dois `insert` concorrentes (`Promise.allSettled`) para a mesma session | um ok, um recusado ("already exists"); **1** tentativa viva |
| **T4b:** tentativa anterior `replaced` → novo `insert` | ok |
| **T4c:** três compare-and-set concorrentes `submitted → authorizing` | `[0, 1, 0]`: exatamente um vence |
| **T4d:** o mesmo `mercadopago_order_id` em duas tentativas | recusado (`23505`) |
| Limpeza no script | linhas 4 → 0; tabela removida (`to_regclass` → `null`) |

**Classificação: A, a persistência sobrevive ao rollback do workflow,** em todos os caminhos que a arquitetura usa (step de workflow e provider por dependência, sem contexto transacional).
- O controle T3 mostra que a tentativa **participaria** de uma transação se o chamador passasse `transactionManager` explicitamente. Isso não é comportamento implícito: nenhum caminho do Medusa passa esse contexto a um provider, e um step só o passa se o código escrever isso.
- **Regra obrigatória para a implementação** (candidata a invariante, com teste): chamadas ao `mercadopagoCardAttempt` nunca recebem o `transactionManager` de outra operação. Cada transição é a própria transação.

### Conclusão

**ENTITY DESIGN READY.**

Pendências que não bloqueiam a Fase 2:
- retenção de 90 dias: decisão;
- H2, H3 e H7 no webhook;
- INV-010.

### Fase 2 (aguarda autorização explícita)

1. Criar `apps/backend/src/modules/mercadopago-card-attempt/`:
   - `models/mercadopago-card-attempt.ts` (o schema acima);
   - `service.ts` (`MedusaService` + método de compare-and-set mínimo para o teste);
   - `index.ts` (`Module("mercadopagoCardAttempt", …)`).
2. Registrar o módulo em `medusa-config.ts` e declarar `dependencies: ["mercadopagoCardAttempt"]` no `@medusajs/medusa/payment` (**sem `id`**, ADR-001).
3. `medusa db:generate mercadopagoCardAttempt` e revisão do SQL (deve ser igual ao do spike, com os nomes definitivos).
4. **Aplicar só essa migration** (isolada, como a do `paymentAccess`), com autorização para escrita no schema.
5. Validar o startup (`medusa develop`) e a leitura e escrita do módulo (linha fictícia criada e apagada).
6. Repetir T1–T4 com a tabela definitiva e apagar as linhas de teste.
7. `tsc`, testes afetados, `git diff --check`.

Fora da Fase 2: provider, webhook, criptografia (AES-256-GCM, anel de chaves), token real, replay, reconciliação, jobs, storefront.

### Arquivos temporários do spike (removidos)

- **Criados e removidos:** `src/modules/spike-inv009-card-attempt/` (`index.ts`, `models/spike-card-attempt.ts` e `migrations/Migration20260930025332.ts` + `.snapshot-spike-inv009card-attempt.json`, gerados).
- **Editados e revertidos:** `medusa-config.ts` (módulo + `dependencies`) e `service.ts` (método `spikeCreateAttempt`). O hash SHA-256 é idêntico ao de antes do spike.
- **Verificado depois** (por `medusa exec`, só contagens): tabela `spike_inv009_card_attempt` inexistente, 0 tabelas e 0 índices `spike`, 0 registros em `mikro_orm_migrations`.
- `tsc` limpo; `service.unit.spec.ts` e specs do `payment-access`: 3 suítes, 123 testes.
- O `medusa develop` de outra sessão (porta 9000) recarregou pelo watcher e voltou ao normal (`/health` 200).

## Fase 2: módulo definitivo e migration (2026-09-30)

Executada por autorizações separadas [decisão humana 2026-09-30]:
- **Gate 0:** implementar e gerar a migration;
- **Gate 1:** revisão do SQL;
- **Gate 2:** aplicar **somente** `Migration20260930030200`.

Fora desta fase continuam: provider, webhook, rotas, criptografia, token real, replay, reconciliação, jobs e storefront.

### Implementado (Gate 0)

- **`apps/backend/src/modules/mercadopago-card-attempt/`:**
  - `attempt-states.ts`: os 7 estados, os estados vivos e o predicado SQL do índice único, derivado da lista;
  - `models/mercadopago-card-attempt.ts`: o schema do [desenho](#desenho-da-entidade-mercadopago_card_attempt-2026-09-30);
  - `service.ts`: `MedusaService` com o CRUD gerado, sem máquina de estados;
  - `index.ts`: `Module("mercadopagoCardAttempt")`;
  - `__tests__/attempt-states.unit.spec.ts`: 3 testes;
  - `migrations/Migration20260930030200.ts` + `.snapshot-mercadopago-card-attempt.json`, gerados por `medusa db:generate mercadopagoCardAttempt`.
- **`medusa-config.ts`:** módulo registrado; `dependencies: ['mercadopagoCardAttempt']` no `@medusajs/medusa/payment`, **sem `id`** (ADR-001).
- **Revisão (Gate 1):**
  - o SQL gerado é **idêntico**, depois de trocar o nome da tabela, ao validado no spike (10 comandos, `diff` mecânico);
  - migration aditiva e isolada, sem FK;
  - os dois `alter table if exists … drop constraint if exists` iniciais são padrão do gerador e se referem só a esta tabela (sem efeito, porque ela não existia).

### Aplicação (Gate 2)

- **Pendências antes de aplicar:** um script read-only comparou os arquivos de migration de todos os módulos registrados (28, mais plugins) com `mikro_orm_migrations`. A única pendente era `mercadopagoCardAttempt: Migration20260930030200`.
- **Aplicação isolada:**
  - `ModulesSdkUtils.buildMigrationScript({ moduleName: "mercadopagoCardAttempt", pathToMigrations })`, apontado só para a pasta do módulo e com a `databaseUrl`/`databaseDriverOptions` do projeto, rodado por `medusa exec`;
  - o script conferiu antes que a pasta tinha exatamente essa migration e que ela não estava registrada;
  - **`medusa db:migrate` não foi usado:** ele também sincronizaria links, rodaria scripts e índices de busca.
- **Resultado** [banco 2026-09-30]:
  - aplicada só `Migration20260930030200` (log `✔ Migrated`);
  - `mikro_orm_migrations` passou de 182 para 183 registros (`executed_at` 2026-09-30T03:06:46Z);
  - depois da aplicação, nenhuma migration pendente em nenhum módulo.
- **Schema conferido no PostgreSQL** (`information_schema`/`pg_catalog`):
  - 16 colunas, com tipos e nulabilidade iguais ao desenho;
  - PK `mercadopago_card_attempt_pkey`;
  - `CHECK` `mercadopago_card_attempt_state_check` com os 7 estados;
  - 6 índices, incluindo o único parcial por session viva (`state = ANY ('submitted','authorizing','unknown','expired') AND deleted_at IS NULL`) e o único parcial de `mercadopago_order_id` (`IS NOT NULL AND deleted_at IS NULL`);
  - 0 FKs; 0 linhas.

### Validação

- **T1–T4 na tabela definitiva** (`medusa exec`; linhas fictícias `payses_INV009_T*`, apagadas no fim):

  | Teste | Resultado |
  |---|---|
  | T1: step → `createMercadopagoCardAttempts` → falha → compensação → `SELECT` | 1 linha, sobreviveu |
  | T2: o mesmo pelo **container do provider** (`provider.container.mercadopagoCardAttempt`, pela dependência; mesmo singleton) | 1 linha, sobreviveu |
  | T3: controle com `transactionManager` explícito de uma transação que lança | 0 linhas, reverteu |
  | T4a: dois inserts concorrentes, mesma session | 1 ok, 1 recusado; 1 viva |
  | T4b: tentativa `replaced` → novo insert | ok |
  | T4c: três compare-and-set concorrentes | `[1, 0, 0]` |
  | T4d: o mesmo `mercadopago_order_id` em duas tentativas | recusado (`23505`) |
  | T4e: `state` fora da lista | recusado (`23514`, `CHECK`) |
  | Limpeza | 4 linhas de teste → 0; tabela com 0 linhas |

- **Runtime:** dois `medusa develop` independentes na porta 9001, cada um com `Server is ready`, `/health` 200 e nenhum erro do módulo nos logs, cada um encerrado ao final. Na primeira parada, um `pkill -f` acabou matando o próprio shell do teste. O servidor 9001 foi encerrado depois pelos PIDs exatos, sem tocar no `medusa develop` de outra sessão (porta 9000, saudável o tempo todo).
- **Estático:** `tsc --noEmit` limpo; suíte unitária completa do backend: 19 suítes, 353 testes (350 anteriores + 3 novos).

### Estado depois da Fase 2

- **O módulo existe e está registrado, mas nenhum código o usa:** o provider, as rotas, o webhook e o `PaymentSession.data` não mudaram, e o comportamento do checkout é o mesmo.
- A regra "nunca passar o `transactionManager` de outra operação ao módulo" vai virar invariante, com teste, quando houver o primeiro chamador.
- **Próxima fase (não autorizada):** transições de estado (compare-and-set) e criptografia do token no módulo, conforme o plano de implementação.

## Fase 3: investigação da máquina de estados e da criptografia (2026-09-30)

Somente investigação. Nenhum código do repositório foi alterado. Os testes de runtime foram temporários, feitos por `medusa exec` e `node` com scripts fora do repositório. Linhas fictícias (`payses_INV009_3A*`) foram gravadas e apagadas na tabela `mercadopago_card_attempt`, que terminou com 0 linhas; o registro de migrations continua em 183.

### 3A: inconsistências encontradas na investigação anterior

1. **Base de tempo das 24 h.**
   - O ADR-015 e a revisão de armazenamento medem a vida do token a partir do envio do cartão (`submitted_at` = `created_at`).
   - O desenho da entidade (transição 10) mede a janela de replay a partir de `authorization_started_at`.
   - Somadas, as duas permitiriam um token vivo por até ~48 h (até 24 h em `submitted` e mais 24 h depois do primeiro `POST`).
   - **Correção proposta:** um único prazo, **`deadline = created_at + 24 h`**, para tudo: replay, `expired`/`replaced` e destruição do token. Como o `POST` acontece depois de `created_at`, o replay continua dentro de 24 h do `POST` (limite de H2). O prazo é **conferido na leitura** (a decifração recusa depois do `deadline`), não só pelo job. **Requer confirmação.**
2. **Faltava `unknown → resolved`.** Pelo webhook, o `processPaymentWorkflow` chama `authorizePayment` **sem** passar pelo Place order, então a tentativa continua `unknown` (não `authorizing`) quando o provider lê a Order paga. A transição passa a existir, só com `mercadopago_order_id` gravado.

Nenhuma inconsistência com a tabela de ciclo do token deste pedido: `expired` destrói o token na própria transição.

### 3A: transições

Em toda transição, `updated_at = now()` é **explícito**: `nativeUpdate` não aciona o `onUpdate` do DML, verificado. Vivos: `submitted`, `authorizing`, `unknown`, `expired`.

| # | Origem → destino | Quem | Condição (compare-and-set, além de `id`) | Campos | Token | Viva depois? | Replay / nova tentativa |
|---|---|---|---|---|---|---|---|
| 1 | ∅ → `submitted` | rota de update | `INSERT … ON CONFLICT DO NOTHING RETURNING id` na mesma transação da regra 2; sem tentativa bloqueante | `id` (gerado antes, compõe AAD e `external_reference`), `encrypted_card_token` | cifrado | sim | — |
| 2 | `submitted` → `replaced` | rota de update (novo envio), `deletePayment`, job/leitura (`deadline`) | `state='submitted'` | `ended_at`, `token_destroyed_at`, token `NULL` | destruído | não | libera nova |
| 3 | `submitted` → `authorizing` | provider, antes do `POST` (opção B) | `state='submitted' AND now() < deadline` | `body_sha256`, `authorization_started_at`, `authorizing_at` | mantido | sim | — |
| 4 | `unknown` → `authorizing` | provider, no replay (opção B) | `state='unknown' AND now() < deadline` | `authorizing_at` | mantido | sim | **replay** |
| 5 | `authorizing` → `authorizing` | provider, na retomada (opção B) | `state='authorizing' AND authorizing_at < now() - 5 min AND now() < deadline` | `authorizing_at` | mantido | sim | **replay** (crash) |
| 6 | `authorizing` → `resolved` | provider (2xx ou `GET` paga) | `state='authorizing'` | `mercadopago_order_id`, `ended_at`, destruição | destruído | não | — |
| 7 | `authorizing` → `failed` | provider (definitivo ou `GET` `failed`/`canceled`) | `state='authorizing'` | `last_error_class`, `ended_at`, destruição | destruído | não | libera nova |
| 8 | `authorizing` → `unknown` | provider (ambíguo) | `state='authorizing'` | `last_error_class` (provider) | mantido | sim | replay depois |
| 9 | `unknown` → `failed` | webhook (Order da tentativa `failed`/`canceled`) | `state='unknown'` | `mercadopago_order_id`, `ended_at`, destruição | destruído | não | libera nova |
| 12 | `unknown` → `resolved` | provider no caminho do webhook | `state='unknown' AND mercadopago_order_id IS NOT NULL` | `ended_at`, destruição | destruído | não | — |
| 10 | `authorizing`/`unknown` → `expired` | job; também a leitura que encontra `deadline` vencido | `state IN ('authorizing','unknown') AND now() >= deadline` | `ended_at`, destruição | destruído | **sim** (bloqueia) | nenhum; manual |
| 11 | `expired` → `resolved` / `failed` | operador (runbook) | `state='expired'` | `mercadopago_order_id` (se houver), `last_error_class` | já destruído | não | libera nova |

Associação sem mudança de estado: o webhook grava `mercadopago_order_id` numa tentativa `authorizing`/`unknown` quando a coluna é `NULL` (`… AND mercadopago_order_id IS NULL`; o índice único impede a mesma Order em duas tentativas). Tentativa `expired` com Order paga: fica para o operador (webhook 503; decisão na fase do webhook).

Conjunto vivo conferido: toda entrada em `submitted`/`authorizing`/`unknown` vem de ∅ ou de outro vivo; as saídas para `resolved`/`failed`/`replaced` deixam o índice e liberam uma nova tentativa. `expired` continua vivo de propósito, bloqueando até a decisão do operador (regra 11). Nenhuma transição volta de um terminal para um vivo.

### 3A: concorrência (verificado no runtime do projeto)

- **Transição:** método próprio do serviço, `@InjectTransactionManager` (transação do próprio módulo), `em.nativeUpdate("MercadopagoCardAttempt", { id, state: <esperado>, …condições }, { … })`. Retorna **o número de linhas**: 1 = efetivada, 0 = perdeu a corrida ou pré-condição falsa (testado: 1, depois 0). Um erro de banco chega como exceção, distinta do 0.
- **Depois de 0 linhas:** uma releitura **só para compor o erro** (`not_found` × `conflict`, com o estado atual no log). Nunca para decidir uma escrita.
- **Sem reload:** `nativeUpdate` não carrega nem mescla entidade. O retorno ao chamador vem de uma leitura depois do commit, e cada chamada ao serviço usa um EntityManager novo.
- **`updated_at`:** `nativeUpdate` **não** atualiza (testado). Toda transição grava `updated_at` explicitamente.
- **Substituição (regras 2 + 1)** numa transação do **módulo**, nunca na do workflow:
  1. regra 2 (`submitted → replaced`);
  2. verifica que não há tentativa bloqueante;
  3. `INSERT … ON CONFLICT DO NOTHING RETURNING id`: 0 linhas = outra submissão venceu, sem exceção (testado: com a vaga ocupada `[0,0,0]`, com a vaga livre `[0,0,1]`);
  4. uma nova tentativa da operação; depois disso, erro `card_attempt_conflict`.

  Com três submissões concorrentes, a invariante se manteve (1 viva, 2 `replaced`). Com tentativa bloqueante, a submissão é recusada.
- **Efeito colateral verificado:** o `create` gerado (e o `em.insert` dentro de `baseRepository_.transaction`) converte a violação de unicidade num `MedusaError` `invalid_data` **cuja mensagem repete os valores da chave única**. Nenhuma coluna secreta pode ter índice único; nenhuma tem.
- **A implementação ainda precisa testar:** que o `INSERT … ON CONFLICT` feito por `em.execute` participa da mesma transação que o `nativeUpdate`. Nos testes, o `INSERT` era isolado.

### 3A: taxonomia mínima de erros

Só o que os primeiros consumidores (rota de update, hook, provider, webhook, job) precisam distinguir:

| Código | Quando | Resposta |
|---|---|---|
| `card_attempt_pending` | nova submissão ou troca com tentativa `authorizing`/`unknown` | `NOT_ALLOWED` (400, mantém `message`/`code`; `CONFLICT` perde a mensagem, INV-009) |
| `card_attempt_in_progress` | Place order com `authorizing` recente | `NOT_ALLOWED` |
| `card_attempt_manual_review` | tentativa `expired` ou `deadline` vencido | `NOT_ALLOWED` |
| `card_attempt_conflict` | compare-and-set com 0 linhas, ou insert perdido depois de uma nova tentativa | `NOT_ALLOWED` (o cliente repete) |
| `card_attempt_not_found` | ID inexistente | `NOT_FOUND` |
| `card_token_unavailable` | chave ausente, `kid` desconhecido, envelope inválido, autenticação falhou, token destruído ou vencido | erro interno; o motivo vai só num enum seguro no log (`key_missing`, `kid_unknown`, `envelope_invalid`, `auth_failed`, `destroyed`, `expired`) |

- `invalid_transition`, `already_terminal`, `already_replaced` e `already_expired` não viram códigos: todos são `card_attempt_conflict`, com o estado atual no log.
- **Regra:** `card_token_unavailable` numa tentativa `unknown` **nunca** leva a `failed` (a Order pode existir). Leva a `expired`/manual.

### 3A: ciclo do token por estado

| Estado | Token existe? | Pode ser usado? | Destruição |
|---|---:|---|---|
| `submitted` | sim | só para montar o body no hook e no primeiro `POST`, antes do `deadline` | em `replaced` ou no `deadline` |
| `authorizing` | sim | sim (`POST`), antes do `deadline` | em `resolved`/`failed`/`expired` |
| `unknown` | sim | **só replay**, antes do `deadline` | em `resolved`/`failed`/`expired` |
| `resolved`, `failed`, `replaced` | não | não | já destruído na transição |
| `expired` | não | não | destruído **na própria transição** (desenho de 24 h) |

A decifração confere `state ∈ {submitted, authorizing, unknown}`, `encrypted_card_token IS NOT NULL` e `now() < deadline`. Senão, `card_token_unavailable`, mesmo que o job ainda não tenha rodado.

**Gate A: concluído**, sem bloqueio arquitetural. As correções 1 (prazo único) e 2 (`unknown → resolved`) precisam de confirmação.

### 3B: criptografia (verificado no Node v24.21.0 do projeto, `node:crypto`)

| Fato de runtime | Resultado | Consequência |
|---|---|---|
| round-trip AES-256-GCM, IV 12 B, tag 16 B | ok; ciphertext = tamanho do texto | — |
| adulterar ciphertext, tag, IV, AAD (session ou `kid`), chave errada | todos falham com `Unsupported state or unable to authenticate data` | falha fechada; nenhuma mensagem contém o token (verificado) |
| **tag truncada (4 B) sem `authTagLength`** | **aceita** (só `DEP0182`) | **obrigatório** `createDecipheriv(..., { authTagLength: 16 })` e validar 16 B |
| tag truncada com `authTagLength: 16` | recusada (`ERR_CRYPTO_INVALID_AUTH_TAG`) | — |
| IV de 11 B | aceito pela API | validar 12 B no envelope |
| chave de 16 B | recusada (`ERR_CRYPTO_INVALID_KEYLEN`) | validar 32 B na carga da configuração |
| `Buffer.from(x, "base64url")` com caracteres inválidos | decodifica em silêncio | regex `^[A-Za-z0-9_-]+$` + reencode canônico igual |
| texto vazio | round-trip válido | recusar token vazio ao cifrar e ciphertext vazio ao decifrar |
| `Buffer.fill(0)` | zera Buffers; strings são imutáveis | ver memória |

**Algoritmo:** AES-256-GCM (`aes-256-gcm`), IV aleatório de 12 bytes por cifragem (`randomBytes`), tag de 16 bytes, `authTagLength: 16` na cifragem e na decifração. Nenhuma implementação própria de AES e nenhum import de internals do Medusa.

**Envelope:** `v1:<kid>:<iv>:<tag>:<ct>`, separador `:`, componentes em base64url sem padding.
- **Validação estrita, antes de qualquer operação criptográfica:**
  - exatamente 5 partes;
  - `v1` literal;
  - `kid` com `^[a-z0-9][a-z0-9_-]{0,31}$`, sem `:`, e presente no anel;
  - `iv` com 16 caracteres → 12 bytes;
  - `tag` com 22 caracteres → 16 bytes;
  - `ct` com ≥ 1 byte;
  - cada parte com regex base64url e reencode idêntico.
- **Qualquer desvio** (versão desconhecida, `kid` inexistente, IV ou tag inválidos, ciphertext inválido, envelope truncado ou com partes a mais) → `card_token_unavailable` (`envelope_invalid`/`kid_unknown`), sem exceção com dados.

**Anel de chaves:**
- **Variáveis de ambiente:**
  - `MERCADOPAGO_CARD_TOKEN_KEYS = "<kid>:<base64url de 32 bytes>,<kid>:<…>"`;
  - `MERCADOPAGO_CARD_TOKEN_CURRENT_KID = "<kid>"`;
  - repassadas como opções do módulo em `medusa-config.ts`; só os nomes no `.env.template`.
- **Validação na carga:** `kid` válido e único, chave com exatamente 32 bytes, `CURRENT_KID` presente no anel.
- **Configuração presente e malformada:** o boot falha (fechado e visível).
- **Configuração ausente:** o módulo carrega, mas cifrar/decifrar lança `card_token_unavailable` (`key_missing`), e o envio do cartão é recusado (pagamento com cartão indisponível, nunca em texto claro).
- **Cifrar:** sempre com a chave atual.
- **Decifrar:** só com o `kid` do envelope, sem tentar outras chaves.

**Rotação:**
- K1 atual → incluir K2 → `CURRENT_KID=K2`;
- os tokens `v1:K1:…` continuam decifráveis enquanto K1 estiver no anel, sem recriptografia na leitura;
- **K1 só pode sair do anel ≥ 24 h + 1 h de margem depois de deixar de ser atual:** todo token cifrado com K1 tem `created_at` ≤ o momento da troca e passa do `deadline` em até 24 h;
- decifrar com um `kid` removido → `card_token_unavailable` (`kid_unknown`); pela regra acima, isso só acontece depois do `deadline`, quando o token já é inutilizável.

**AAD:** `utf8(JSON.stringify(["mercadopago_card_token", "v1", kid, attempt_id, payment_session_id]))`. É determinística e não ambígua (JSON delimita e escapa cada campo).
- Inclui versão e `kid`: trocar o `kid` falha na autenticação (testado).
- O `attempt_id` é o `id` da linha, **gerado antes** do insert (`generateEntityId(undefined, "mpca")`), porque participa da AAD.
- Testado: trocar a session ou o `kid` na AAD → falha.

**Hash do token:** não há. Nenhuma busca ou deduplicação por token; o replay precisa do token, não de um hash. O `body_sha256` só confere o body.

**Observabilidade:** nunca em logs, erros, métricas, exceções, telemetria, testes ou saída de depuração:
- o token em claro;
- o envelope completo;
- a chave.

Os erros levam só `code` + motivo em enum. O token e o envelope nunca passam por input/output de step (o `workflow_execution` persiste o contexto: INV-009). Nenhuma coluna secreta em índice único (a mensagem de violação repete os valores).

**Memória:** o token chega como string JavaScript (corpo JSON da rota) e vai ao SDK como string no `JSON.stringify` do body. Strings são imutáveis e copiadas pelo runtime, e **não há apagamento determinístico**. Só Buffers intermediários podem ser zerados (`fill(0)`), com ganho marginal. Medida adotada: não guardar o token em cache nem em estado de longa duração, e decifrá-lo só no escopo do `POST`. Limitação registrada.

**Semântica de falha:** chave ausente, `kid` inválido, envelope inválido, autenticação falhou, configuração malformada ou chave atual ausente → **falha fechada** (`card_token_unavailable` ou boot interrompido, no caso da configuração malformada). Nunca há fallback para texto claro nem retorno de token parcialmente decifrado (`final()` lança antes de qualquer retorno).

**Matriz mínima de testes** (da implementação futura):
- **round-trip;**
- **adulteração** de ciphertext, tag, IV e AAD (`attempt_id`, `payment_session_id`, `kid`), e troca de `kid` no envelope;
- **chave errada** (K1 cifra, K2 decifra);
- **rotação:** K1 cifra → K2 atual com K1 retido → decifra ok;
- **K1 removido** → falha (`kid_unknown`);
- **envelope malformado:** versão, número de partes, `kid` com `:`, IV com 11 bytes, tag de 4 e de 15 bytes, base64url não canônico, `ct` vazio, truncado;
- **configuração:** chave com 31/33 bytes, `kid` duplicado, `CURRENT_KID` ausente no anel, variável ausente;
- **token vazio** recusado;
- **`deadline`:** decifração recusada depois de `created_at + 24 h` mesmo sem o job, e recusada em estado terminal ou com o token `NULL`;
- **nenhum vazamento:** `message`, `stack` e `JSON.stringify(error)` sem o token, o envelope nem a chave, e nenhuma chamada de log contendo esses valores (logger espionado).

**Gate B: concluído.**

### Decisão

**DESIGN READY**, condicionado à confirmação de duas correções da 3A:
- `deadline = created_at + 24 h` como prazo único;
- a transição `unknown → resolved` no caminho do webhook.

Nenhum bloqueio arquitetural.

**Próximo passo (não executado):**
1. transições do módulo (`nativeUpdate` condicional + substituição com `ON CONFLICT DO NOTHING`), com os testes de concorrência;
2. utilitário de criptografia (`node:crypto`, envelope estrito, anel de chaves) com a matriz acima;
3. só depois, os consumidores: rota de update, hook, provider e webhook.

## Fase 4: máquina de estados e criptografia implementadas (2026-09-30)

**Autorização:** opção A [decisão humana 2026-09-30]. Exatamente as transições aprovadas; **sem** `authorizing → replaced` e **sem** `unknown → replaced`. As duas correções da Fase 3 foram aprovadas:
- prazo único `created_at + 24 h`;
- transição `unknown → resolved` (regra 12).

**Sem integração:** `PaymentSession.data`, a rota de update, o provider, o webhook, o checkout e o storefront não mudaram. Nenhum schema nem migration novos.

### Arquivos

Em `apps/backend/src/modules/mercadopago-card-attempt/`:

| Arquivo | Conteúdo |
|---|---|
| `attempt-states.ts` | estados; conjuntos vivo, bloqueante e com token; `CARD_ATTEMPT_TTL_HOURS = 24`, `getCardAttemptDeadline` e os predicados SQL do prazo derivados da mesma constante; janela de `authorizing` travada (5 min). O predicado do índice único não mudou (o schema é o mesmo) |
| `transitions.ts` | a tabela de transições (regras 2 a 12) e o gerador do `UPDATE … WHERE id = ? AND deleted_at IS NULL AND state IN (…) AND … RETURNING id`, sempre com `updated_at = now()`; as transições que saem de um estado com token fazem `encrypted_card_token = NULL` e `token_destroyed_at = COALESCE(token_destroyed_at, now())`; associação da Order sem mudança de estado; destruição idempotente de ciphertext residual |
| `service.ts` | métodos com transação própria do módulo (nunca aceitam o contexto de outra operação) |
| `card-token-crypto.ts` | AES-256-GCM (`node:crypto`), IV aleatório de 12 B, `authTagLength: 16` na cifragem e na decifração, envelope `v1:kid:iv:tag:ct` em base64url com validação estrita antes de decifrar, AAD `JSON.stringify(["mercadopago_card_token","v1",kid,attempt_id,payment_session_id])`, anel de chaves; erros só com motivo (`key_missing`, `kid_unknown`, `envelope_invalid`, `auth_failed`, `token_invalid`), sem `cause` |
| `errors.ts` | só os 6 códigos públicos, com `NOT_ALLOWED`/`NOT_FOUND`/`UNEXPECTED_STATE` e mensagem fixa |
| `loaders/validate-card-token-keys.ts` | configuração malformada interrompe o boot; ausente só gera um aviso |
| `index.ts` | registra o loader |

Métodos do `service.ts`:
- `submitAttempt` (regras 2 + 1);
- `beginAuthorization` (3);
- `resumeAuthorization` (4, 5);
- `markUnknown` (8);
- `resolveAuthorization` (6);
- `failAuthorization` (7);
- `recordOrder` (associação);
- `resolveUnknown` (12);
- `failUnknown` (9);
- `expireIfPastDeadline` (10, e 2 pelo prazo);
- `replaceSubmitted` (2);
- `resolveExpiredManually`/`failExpiredManually` (11);
- `destroyCardToken`;
- `readCardToken`;
- `retrieveAttemptView` (visão sem ciphertext).

Fora do módulo:
- `apps/backend/medusa-config.ts`: opções `card_token_keys`/`card_token_current_kid`, lidas de `MERCADOPAGO_CARD_TOKEN_KEYS`/`MERCADOPAGO_CARD_TOKEN_CURRENT_KID`;
- `apps/backend/.env.template`: só os nomes, sem valor.

### Comportamento

- **Transições:** sempre por `em.execute` com um `UPDATE` condicional e `RETURNING id`, dentro de `baseRepository_.transaction`.
  - 0 linhas = pré-condição falsa ou corrida perdida; uma releitura só escolhe o código (`card_attempt_in_progress` para `authorizing` dentro do prazo, `card_attempt_manual_review` para `expired`, `card_attempt_not_found`, senão `card_attempt_conflict`).
  - Um erro de banco é exceção.
- **Envio do cartão:** numa única transação do módulo:
  1. substitui a `submitted` da session;
  2. recusa se houver tentativa bloqueante (`pending`, ou `manual_review` se `expired`);
  3. gera o `id` (usado na AAD e no `external_reference`) e cifra;
  4. `INSERT … ON CONFLICT DO NOTHING RETURNING id`.

  Com 0 linhas, a transação é revertida e repetida uma vez (vence o último envio); depois, `card_attempt_conflict`.
- **Prazo:** conferido pelo relógio do PostgreSQL (o mesmo de `created_at`) em `begin`, no replay e na leitura do token. Uma leitura depois do prazo aplica a regra 10 (ou 2) antes de recusar.
- **Leitura do token:**
  - só em `submitted`/`authorizing`/`unknown`, com ciphertext e dentro do prazo;
  - numa tentativa `unknown`, qualquer falha (chave, envelope, autenticação, token destruído) dá `card_attempt_manual_review`, **nunca `failed`**;
  - nas demais, `card_token_unavailable`;
  - o log de aviso leva só o ID da tentativa e o motivo.
- **Memória:** o token é string JavaScript (imutável), sem apagamento determinístico. Ele só existe no escopo da cifragem e da leitura, sem cache, sem persistência em claro e sem log.

### Testes

**Unitários:** 4 suítes, 99 testes.

- **`card-token-crypto.unit.spec.ts`:**
  - round-trip (formato, IV novo a cada cifragem);
  - adulteração de ciphertext, tag, IV, `kid` (outra chave do anel), AAD `attempt_id` e AAD `payment_session_id`;
  - chave errada; rotação (K1 retida decifra, novas cifragens usam K2); chave removida (`kid_unknown`, sem tentar outras); sem chaves (`key_missing`);
  - 11 envelopes inválidos: versão, `kid` vazio/inválido, caractere inválido, padding, IV de 11 B, tag de 4 B e de 15 B, ciphertext vazio, parte extra, parte ausente; mais `kid` desconhecido e envelope que não é string;
  - 10 configurações malformadas, e erros de configuração sem material de chave;
  - nenhum segredo (token, envelope, ciphertext, chaves) em `message`, `stack`, `JSON.stringify` ou `cause`.
- **`transitions.unit.spec.ts`:**
  - a tabela é **exatamente** a aprovada, sem `authorizing/unknown → replaced` e sem saída de estado final;
  - cada statement é condicional, grava `updated_at` e retorna ids;
  - a destruição do token ocorre exatamente ao sair de um estado com token, de forma idempotente;
  - prazo em `begin`/replay/`expire`; janela de `authorizing` travada;
  - regra 12 com a Order registrada; ordem das bindings; associação sem mudança de estado; destruição residual.
- **`attempt-states.unit.spec.ts`:** conjuntos, predicado do índice, prazo `created_at + 24 h`.
- **`service.unit.spec.ts`**, com repositório falso que registra cada SQL:
  - `submitAttempt` (ordem dos statements, só ciphertext no insert, `external_reference` ≤ 64, nova tentativa depois de corrida perdida, conflito, recusa por estado bloqueante sem insert, falha fechada sem chaves, `cart_id` inválido);
  - códigos depois de 0 linhas; regra 12;
  - prazo em `begin`/replay/`expireIfPastDeadline`;
  - `readCardToken` (round-trip, `unknown` → `manual_review` e nunca `failed`, outros casos);
  - conflito de unicidade em `recordOrder`; destruição idempotente;
  - nenhum token ou envelope em erros e logs.

**Integração com o módulo real** (`medusa exec`, tabela `mercadopago_card_attempt`):
- chave aleatória só no ambiente daquele processo, token fictício, linhas `payses_INV009_F4_*` apagadas no fim (0 linhas);
- todos os itens abaixo passaram:

| Verificação | Resultado |
|---|---|
| **Item 17:** envio → linha só com envelope `v1:it1:…` (sem texto claro) → `readCardToken` = token → `begin` → `resolveAuthorization` | ciphertext `NULL`, `token_destroyed_at` e `ended_at` gravados, `updated_at` avançou; leitura posterior → `card_token_unavailable` |
| Regras 4 e 12 | `unknown → authorizing` (replay), `recordOrder`, `unknown → resolved`, token destruído |
| Regras 9, 7, 2 (novo envio e descarte), 5 (recente → `in_progress`; travada há 10 min → retoma), 11 (`resolved` e `failed`) | ok |
| Prazo (`created_at` recuado 25 h) | replay → `manual_review` e `expired` com token destruído; novo envio → `manual_review`; leitura de `authorizing` vencida → `manual_review` e `expired`; `begin` de `submitted` vencida → `card_token_unavailable` e `replaced` |
| Transições inválidas | códigos estáveis (`in_progress`, `conflict`, `not_found`, `pending`) |
| Concorrência | 3 `begin` → 1 vence; `resolve` × `markUnknown` → 1 vence; 3 envios → 1 tentativa viva |
| `em.execute` dentro da transação do módulo | falha depois da substituição → substituição revertida (a `submitted` anterior continua `submitted`) |
| Destruição residual | `[1, 0]` |
| Texto claro na tabela | 0 ocorrências |

**Boot:**
- chave com tamanho errado ou `CURRENT_KID` fora do anel → o loader falha e o boot para, com mensagem sem material de chave;
- configuração ausente → boot normal, com aviso.

**Estático:** `tsc --noEmit` limpo; suíte unitária do backend com 22 suítes e 449 testes. O `medusa develop` de outra sessão (porta 9000) recarregou com o aviso de chaves ausentes e segue saudável.

### Estado depois da Fase 4

Módulo pronto e isolado: nenhum consumidor usa a máquina de estados nem a criptografia. O checkout funciona como antes.

A regra "nunca passar o `transactionManager` de outra operação" é garantida por construção: os métodos públicos não recebem contexto. Vira invariante documentado quando houver o primeiro consumidor.

**Próximo (não autorizado):** integração com a rota de update, o provider e o webhook.

## Ownership das regras 3, 4 e 5: opção B (2026-09-30)

**Decisão** [decisão humana 2026-09-30]: as regras abaixo são executadas **pelo provider** (`authorizePayment` do cartão), não pelo hook `validate` do `completeCartWorkflow`:
- 3: `submitted → authorizing`, imediatamente antes do `POST`;
- 4: `unknown → authorizing`, no replay;
- 5: `authorizing → authorizing`, na retomada de uma tentativa travada.

**Não existe hook nem compensação `authorizing → unknown`.** As demais regras não mudam: 6, 7 e 8 pelo provider; 12 pelo provider no caminho do webhook; 9 pelo webhook; 2 pela rota de update e pelo `deletePayment`; 10 e 11 como antes.

**Motivos:**
- A tentativa vive no módulo próprio, que o provider alcança pela dependência e que grava em transação própria (T1/T2 da Fase 2). Assim, `authorizing` fica persistido antes do `POST` e sobrevive a qualquer falha do workflow. Era para isso que o hook existia quando a tentativa ficava em `PaymentSession.data`.
- Uma falha do workflow **antes** da autorização (estoque, por exemplo) deixa a tentativa `submitted`, não `unknown`. Isso elimina o custo de UX registrado antes.
- Um crash **durante** o `POST` deixa `authorizing`, retomado pela regra 5 depois de 5 min.
- Um Place order concorrente com `authorizing` recente é recusado no provider com `card_attempt_in_progress` (a transição condicional da regra 3 ou 5 não encontra a linha).
- O body e o `body_sha256` são montados num só lugar (o provider), e o token decifrado nunca passa por input nem output de step de workflow.

**Sem mudança de estados, transições, schema, chave de idempotência (ADR-014) ou criptografia.**

## Fase 5: integração (2026-09-30, concluída)

**Provider** (`modules/mercadopago/service.ts`, opção B):
- o token vem só da tentativa (`card_attempt_id` → `readCardToken`);
- regras 3/4/5 antes do `POST`; resultado registrado pelas regras 6/7/8; Order conhecida → `GET` (regras 6/12 e 7/9); `deletePayment` aplica a regra 2 ou recusa;
- body e `body_sha256` só no provider; chave do ADR-014 inalterada; `external_reference` da tentativa.

Testes: fake do módulo em `modules/mercadopago/__fixtures__/`; testes de cartão existentes migrados; 27 testes novos.

**Rota de update** (`api/store/mercadopago/payment-sessions/[id]/route.ts`):
- **Congelamento:** antes de qualquer escrita, procura tentativa bloqueante (`authorizing`/`unknown`/`expired`, só `id`/`state`, sem ciphertext) e recusa qualquer update com `card_attempt_pending` ou `card_attempt_manual_review`.
- **Envio de cartão:** um `card_token` de cartão vai para `submitAttempt` (regras 2 + 1, com o `cart_id` já verificado pela posse). `data` recebe só o `card_attempt_id`. O cliente não escreve `card_attempt_id` (fora da allowlist), e um `card_token` antigo é removido de `data`.
- **Troca para Pix:** libera a tentativa `submitted` (`replaceSubmitted`, regra 2) e remove o `card_attempt_id`. Uma tentativa já final é ignorada.
- `payment_type_id` e os demais campos validados seguem como antes.

Testes: `PS` com fake do módulo; 11 testes novos; dois testes existentes passaram a esperar `card_attempt_id` em vez de `card_token`.

**Webhook** (`api/hooks/payment/[provider]/route.ts`):
- o cart vem do `external_reference` (valor inteiro ou parte antes do `-` de `<cart_id>-<ULID>`);
- a correlação por `mercadopago_order_id` continua primeiro e, quando acha uma session, o módulo de tentativas nem é consultado;
- **fallback** só sem session: tentativa com o `external_reference` exato, de uma session `pp_mercadopago` do mesmo cart que ainda aponta para ela, `authorizing`/`unknown`, sem outra Order, com o mesmo valor;
- associada → `recordOrder`. Recusada/cancelada numa `unknown` → regra 9 (dono: webhook). Paga → o evento é emitido para a session da tentativa, e a regra 12 roda no provider (dono documentado) pelo `processPaymentWorkflow`;
- sem associação: paga → 503 + erro; não paga → 200. Ambiguidade ou erro do módulo → 503.

Testes: `W` com 26 testes novos; um teste existente ajustado (o `select` das sessions passou a incluir `amount`). Invariante 19 e `webhook.md` atualizados.

**Integração da Fase 5 concluída.** E2E com H7 real: [abaixo](#h7-no-webhook-real-2026-09-30-aprovado).

### Validação final (2026-09-30)

- `jest` (unitários do backend): **22 suítes, 515 testes passando**.
- `tsc --noEmit`: limpo.
- `eslint` da rota do webhook: 0 erros, 0 avisos.
- `git diff --check`: ok.

**H7 (webhook real), exigido pelo ADR-015: não executado nesta verificação, executado depois ([H7 no webhook real](#h7-no-webhook-real-2026-09-30-aprovado)).** Pré-requisitos verificados e, naquele momento, não atendidos:
- nenhum processo de túnel no ambiente, e nenhuma notificação real chegou ao backend (as linhas `hooks/payment` do log do `medusa develop` são só do watcher);
- o backend roda sem `MERCADOPAGO_CARD_TOKEN_KEYS`/`MERCADOPAGO_CARD_TOKEN_CURRENT_KID` (aviso do loader), então o fluxo atual recusa criar tentativas de cartão.

As duas coisas dependem de ação humana: túnel público com a URL configurada manualmente no painel do Mercado Pago (CLAUDE.md), e chaves de criptografia no ambiente do backend. Nenhuma Order nem dado de sandbox foi criado nesta etapa.

Naquele momento, o H7 continuava parcialmente confirmado: só o `GET` ([E2E H1/H7](#e2e-h1-e-h7-sandbox-2026-09-29)).

## H7 no webhook real (2026-09-30): APROVADO

Marcações desta seção:
- **[sandbox 2026-09-30]**: Orders e notificações reais do sandbox (`live_mode=false`);
- **[log 2026-09-30]**: stdout/stderr do `medusa develop` capturados em arquivo durante o teste;
- **[banco 2026-09-30]**: consultas read-only (transação `READ ONLY`);
- **[MCP 2026-09-30]**: `notifications_history` e `search_documentation` do MCP do Mercado Pago.

Não foi alterado código, schema nem configuração do Mercado Pago. O host do túnel não é registrado (CLAUDE.md).

### Método (cenário 6 do plano E2E)

- **Pré-requisitos:** backend com `MERCADOPAGO_CARD_TOKEN_KEYS`/`_CURRENT_KID` carregadas, sem o aviso do loader. Túnel ngrok para `localhost:9000` com o host já configurado no painel, conferido por hash antes e depois de cada reinício. [decisão humana 2026-09-30]: chaves e túnel configurados pelo responsável.
- **Script:** `medusa exec` fora do repositório, como na [INV-008](INV-008-card-idempotency-key-per-session.md):
  - cart montado pelos workflows do core (R$ 510);
  - cartão Visa de teste `APRO` tokenizado por `POST /v1/card_tokens` (token não registrado);
  - handler real da rota `payment-sessions/[id]` chamado com o payload do Brick;
  - `completeCartWorkflow` como Place order.
- **Perda da resposta:** um wrapper do `fetch` global deixa o `POST /v1/orders` chegar ao Mercado Pago e descarta a resposta nas 4 tentativas do SDK (3 retries). O provider não foi modificado.
- **Túnel:** derrubado antes do Place order e restaurado só depois de confirmar `unknown`, com a tentativa sem Order, a session sem `mercadopago_order_id` e o Place order compensado. A notificação original falha, e o Mercado Pago reenvia depois (a cada 15 min, pela documentação oficial [MCP 2026-09-30]).

### Evidência: caso s6b

| Item | Resultado |
|---|---|
| MP Order | `ORDTST01M3S8XBAY1ZHSKHDZFWR9MDD2` [sandbox 2026-09-30] |
| `external_reference` | `cart_01M3S8WZT48TXCFB5QT5JGBF6A-01M3S8X3K34FB6981NKBAPJD22` (`<cart_id>-<ULID>` da tentativa) |
| `POST /v1/orders` | 4 envios (13:43:45–13:43:55Z), todos `201` com a **mesma** Order, mesma chave e mesmo hash de body; as 4 respostas foram descartadas [sandbox 2026-09-30] |
| Depois do Place order | tentativa `mpca_01M3S8X3K34FB6981NKBAPJD22` em `unknown` (`last_error_class = MPConnectionError`), `mercadopago_order_id` nulo; session `payses_01M3S8X2V0HC9GD5FNW33YMMZY` `pending`, sem `mercadopago_order_id`; Place order com erro em `authorize-payment-session-step` e compensado (pedido provisório desfeito, cart aberto) [banco 2026-09-30] |
| Webhook | notificação real `order.processed` recebida às 14:36:03Z, depois do `unknown`; `x-signature` presente; **HTTP 200** [log 2026-09-30] |
| Correlação | log direto: `Mercado Pago webhook: paid order ORDTST01M3S8XBAY1ZHSKHDZFWR9MDD2 associated with card attempt mpca_01M3S8X3K34FB6981NKBAPJD22 of session payses_01M3S8X2V0HC9GD5FNW33YMMZY`, a mensagem do fallback pela tentativa. Nenhum erro de gravação da tentativa no log [log 2026-09-30] |
| Tentativa | `resolved`, `mercadopago_order_id` registrado, token destruído (`token_destroyed_at` = `ended_at`), `last_error_class = MPConnectionError` mantido, `authorizing_at` igual a `authorization_started_at` [banco 2026-09-30] |
| Session | `authorized`, `data.mercadopago_order_id` = a Order, `card_attempt_id` = a tentativa, sem `card_token` [banco 2026-09-30] |
| Pagamento | 1 Payment `pay_01M3SBX4688DGDTM1D7C76SSAE` de 510, 1 captura de 510, nenhum reembolso; collection `completed` (510 autorizados e capturados) [banco 2026-09-30] |
| Pedido Medusa | 1 pedido, **#116** (`order_01M3SBX5R3KEBH14SNEMW3XNKQ`): total 510, pago 510, nada pendente. Nenhum outro vínculo de pedido com o cart [banco 2026-09-30] |
| Mercado Pago | `GET /v1/orders/{id}`: `processed/accredited`, `external_reference` idêntico, 1 payment de 510, nenhum reembolso. Busca exata por `external_reference`: `total: 1` [sandbox 2026-09-30] |

**Regra 12 comprovada.** A tentativa saiu de `unknown` para `resolved`. Pela tabela de transições (`transitions.ts`), a única transição de `unknown` para `resolved` é `resolve_from_unknown` (regra 12). A regra 4 (retomada) teria atualizado `authorizing_at`, e isso não aconteceu. A sequência observada foi:

`external_reference` → tentativa (fallback) → `recordOrder` → evento → `processPaymentWorkflow` → `GET` da Order → `unknown → resolved` → captura → pedido.

**Linha do tempo:**
- 13:44Z: a primeira entrega falhou com o túnel fora (502 [MCP 2026-09-30]);
- 14:02Z: uma reentrega falhou com 502, sem chegar ao túnel. O processo ngrok daquele momento ficou em reconexão e foi substituído;
- 14:36Z: a reentrega chegou com o túnel estável.

### Evidência complementar

- **Caso s6c** [log, banco 2026-09-30]: executado pelo mesmo método, com o ngrok controlado pelo teste. Dados:
  - MP Order `ORDTST01M3SB0ZXANAJ3CHGBPGK1YVDB` (4 `POST` com 201, mesma Order);
  - tentativa `mpca_01M3SB0CQYGP1HR59APWQAR9PZ` em `unknown`, sem Order na tentativa nem na session, antes de o túnel voltar.

  A reentrega chegou depois de encerrado o monitoramento. O log registra `paid order … associated with card attempt mpca_01M3SB0CQYGP1HR59APWQAR9PZ …`. No banco:
  - tentativa `resolved`, com a Order e o token destruído;
  - session `authorized`;
  - cart concluído às 14:44:10Z;
  - 1 pedido Medusa.
- **Checkout `APRO` sem perda de resposta** (12:41Z) [banco 2026-09-30]:
  - MP Order `ORDTST01M3S5BN242PBBRRS513JGDQNW`, pedido #112;
  - tentativa resolvida pelo provider (regra 6), session `authorized`, 1 Payment, 1 captura.

  A notificação real chegou com o `external_reference` no formato `<cart_id>-<ULID>` e HTTP 200. O caminho usado foi a correlação antiga por `mercadopago_order_id`: pelo código, o fallback teria recusado uma tentativa já `resolved`, com 503 para Order paga [não validado: o log dessa notificação não foi capturado].

### Dados criados e pendência

Carts e Orders sandbox de 2026-09-30:
- s6b (#116) e s6c: concluídos;
- `APRO` (#112): concluído;
- primeiro caso abandonado do cenário 6: cart `cart_01M3S6S47P1A3HQRFCPH2WA6KR`, tentativa `mpca_01M3S6S85G125GT437C94NZMEC`, MP Order paga `ORDTST01M3S6SFY1G4MB6TW47GA6XRPE`.

**Artefato residual (não resolvido), última leitura em 2026-09-30, 14:52Z** [banco 2026-09-30] [sandbox 2026-09-30]:
- tentativa `unknown` (`last_error_class = MPConnectionError`), com `mercadopago_order_id` e `token_destroyed_at` nulos: o token cifrado continua guardado para o replay;
- session `pending`, sem `mercadopago_order_id`; collection `not_paid`; cart aberto;
- nenhum pedido Medusa, nenhum Payment e nenhuma captura;
- no Mercado Pago, a Order está `processed/accredited`, com R$ 510,00 pagos, 1 payment e nenhum reembolso; a busca exata pelo `external_reference` retorna 1 Order;
- nenhuma notificação dessa Order chegou ao log do backend. As reentregas observadas voltaram 502, no período do ngrok em reconexão [MCP 2026-09-30].

Não bloqueia a conclusão da investigação. Pelo desenho, a tentativa é resolvida:
- por uma reentrega do webhook, pelo mesmo caminho do s6b;
- ou por um Place order no cart (replay com a mesma chave e o mesmo body).

O prazo é `created_at + 24 h` (2026-10-01, 13:06Z). Correção de 2026-09-30: a tentativa **não** vira `expired` sozinha nesse momento. A expiração só acontece num Place order depois do prazo (o `authorizePayment` que lê o token), e não existe job; até lá ela continua `unknown`, com o ciphertext, e o webhook ainda a resolve. Um Place order depois do prazo a torna `expired` e deixa o caso para revisão manual (regra 11). Detalhes: [README do Mercado Pago](../mercadopago/README.md#prazo-da-tentativa-de-cartão-implementação-atual).

### O que não foi executado

Nesta etapa ficaram fora os cenários 1, 2, 3, 7, 8 e 9 e as regressões de Pix e reembolso. Todos foram executados depois: [E2E restantes](#e2e-restantes-sandbox-2026-09-30). O cenário 6 foi executado sem o job, que não existe no código atual.

## E2E restantes (sandbox, 2026-09-30)

Código em `6f5acdd` (HEAD `cd84575`, só documentação depois). Marcações desta seção: as mesmas da [seção do H7](#h7-no-webhook-real-2026-09-30-aprovado). Nenhum código, teste, schema ou configuração do Mercado Pago foi alterado.

### Método

- Backend limpo (`pnpm dev`), sem wrapper de `fetch` no processo e sem o aviso do loader de chaves [log 2026-09-30]. O processo anterior, com um `fetch-spy` carregado por `NODE_OPTIONS`, foi encerrado.
- Scripts `medusa exec` fora do repositório, pelo mesmo mecanismo do [H7](#método-cenário-6-do-plano-e2e): cart pelos workflows do core (R$ 510), Visa de teste tokenizado por `POST /v1/card_tokens` (titular `APRO` ou `OTHE`), envio do Brick pela rota HTTP real `POST /store/mercadopago/payment-sessions/:id` (publishable key), `completeCartWorkflow` como Place order.
- Injeção no `POST /v1/orders`, nas 4 tentativas do SDK:
  - **antes do envio:** o wrapper lança um erro de rede sem chamar o `fetch` real;
  - **resposta perdida:** o `POST` chega ao Mercado Pago, o wrapper registra a resposta e a descarta.
- Registro por `POST`: hash da chave, hash do body, HTTP, IDs de Order e payment. Nenhum token, dado de cartão ou header `Authorization` foi registrado.
- **Túnel desligado** nos cenários 1, 2, 3, 7, 8 e 9 e na regressão Pix, para que a resolução só pudesse vir do Place order (replay), nunca do webhook. Nenhuma notificação entrou no backend nesse intervalo [log 2026-09-30]. O túnel voltou (mesmo host, conferido por hash) antes da regressão de reembolso.
- Validação só por leitura: consultas ao banco (em transação `READ ONLY` na verificação complementar), `GET /v1/orders/{id}` e busca exata por `external_reference`.

### Resultados

| Cenário | Resultado | Evidência essencial |
|---|---|---|
| 1 — Order não criada | ✅ aprovado | 4 `POST` interrompidos antes da rede → tentativa `unknown` (`MPConnectionError`), sem Order, token mantido; session `pending`; Place order compensado; busca = 0. 2º Place order: **1** `POST`, mesma chave e mesmo hash de body, `201 processed/accredited`; `authorizing_at` avançou (regra 4) → `resolved` (regra 6), token destruído; 1 Payment, 1 captura, collection `completed`, pedido **#119**; busca = 1 |
| 8 — troca bloqueada em `unknown` | ✅ aprovado | Com a tentativa do cenário 1 em `unknown`: novo cartão → **HTTP 400 `card_attempt_pending`**; troca para Pix → **HTTP 400 `card_attempt_pending`**; `session.data` idêntico antes e depois; nenhuma tentativa nova; tentativa ainda `unknown`, `updated_at` inalterado |
| 3 — Order `failed` + resposta perdida | ✅ aprovado | `OTHE`: 4 `POST` com **402**, mesmo payment, respostas descartadas → `unknown`, sem Order, token mantido; busca = 1 Order `failed/failed`. 2º Place order: **1** `POST`, mesma chave e mesmo body → **mesmo 402, mesmo payment** → tentativa `failed` (`MPPaymentError`, regra 7 depois da regra 4), token destruído; nenhum Payment, nenhum pedido, cart aberto |
| 9 — terminal → novo cartão | ✅ aprovado | Mesmo cart do 3: novo Brick (`APRO`) → HTTP 200, **nova** tentativa e novo `external_reference`; a antiga continua `failed`. Place order: 1 `POST` com **outra** chave e outro body → `201 processed/accredited` → `resolved`; session `authorized` com a tentativa nova, sem `card_token`; 1 Payment, 1 captura, pedido **#122**. Busca: 1 Order para cada `external_reference` (a `failed` e a paga) |
| 2 — Order paga + resposta perdida + replay | ✅ aprovado | 4 `POST` com `201`, a **mesma** Order, respostas descartadas → `unknown`, sem Order na tentativa; busca = 1 Order `processed/accredited`. 2º Place order: 1 `POST`, mesma chave e body → `201` com a **mesma** Order → `resolved` (regras 4 → 6); `body_sha256` inalterado; 1 Payment, 1 captura, pedido **#124**; 5 `POST` no total, todos com a mesma chave |
| 7 — retry idêntico | ✅ aprovado | Como o 2, com um Place order extra também com resposta perdida: 8 `POST` com a mesma chave, o mesmo hash de body e a mesma Order; `authorizing_at` avançou no retry (regra 4) e a tentativa voltou a `unknown` com o token. Place order final: 1 `POST` (9 no total, todos iguais) → mesma Order → `resolved`; 1 Payment, 1 captura, pedido **#127**; busca = 1 |
| Regressão Pix | ✅ aprovado¹ | Rotas reais de update (Pix) e prepare: 200, QR presente; chave do Pix = `sha256("<session>:pix:510.00:0")` (fórmula anterior); Order `processed/accredited` (~3 s, `APRO`), `external_reference` = `cart_id`. Place order: **0** `POST /v1/orders`, **0** chamadas a `getCardOrderIdempotencyKey` (contador ativo: 1 `authorizePayment`), nenhuma tentativa de cartão criada; session `authorized`; 1 Payment, 1 captura, pedido **#128**; busca = 1 |
| Regressão reembolso | ✅ aprovado | `refundPaymentWorkflow` (como na [INV-004](INV-004-refund-payment-amount-and-idempotency.md#e2e-sandbox-2026-09-29)). Cartão #119, parcial R$ 100: 1 `POST …/refund` com `transactions`/`"100.00"`, chave = `refund.id`, 201, reembolso `processed`, Order `processed/partially_refunded`, `refunded_amount` 100. Pix #128, total R$ 510: sem body, chave = `refund.id`, 201, `processed`, Order `refunded/refunded`, `refunded_amount` 510 |

¹ O veredito automático do script marcou 2 checks como falhos por defeito do próprio script: a busca por `external_reference` feita logo depois do prepare voltou vazia, e o script comparou a session com um ID `undefined`. Uma verificação complementar só de leitura confirmou session `authorized` com `mercadopago_order_id` = a Order Pix, o Payment com a mesma Order, a Order paga e a busca = 1. O cenário não foi repetido. A busca vazia logo depois da criação não teve o corpo registrado; a causa (indexação ou relógio) não foi determinada [não validado]. No cenário 1, a primeira execução também parou por defeito do script (o total da busca veio como texto `"0"`). Ele continuou no mesmo cart, depois de reler banco e Mercado Pago sem mudança.

### IDs [sandbox 2026-09-30] [banco 2026-09-30]

| Cenário | Cart | Tentativa(s) | MP Order | Pedido |
|---|---|---|---|---|
| 1 + 8 | `cart_01M3SDVAG8V1QQXPEHD5AM0B1S` | `mpca_01M3SDVEE5M2BDGM9RGZ78B37T` | `ORDTST01M3SDX73XDKM81PVCCFVEN4JY` | #119 |
| 3 + 9 | `cart_01M3SE9RN2SD0GM221BK78CCP9` | `mpca_01M3SE9WJ1PMGQQM8VRAT18C96` (`failed`), `mpca_01M3SEADZYV6N2ZWH5S12ETNQD` | `ORDTST01M3SEA45Y636KKNNP5EV2MZJ5` (`failed`), `ORDTST01M3SEANC1YBCJVMG3ZYY7H923` | #122 |
| 2 | `cart_01M3SEB027QS6A9VJKYBT28YPZ` | `mpca_01M3SEB3GYC2VP4VX38A7PSBWM` | `ORDTST01M3SEBAYCCRSE785K9FA82RXS` | #124 |
| 7 | `cart_01M3SEBZJQHFK77KQHX3Y2Q5K2` | `mpca_01M3SEC39FQ4GCDWW6G8KTAY5G` | `ORDTST01M3SECAS51ADZ9P89T8G8325Y` | #127 |
| Pix | `cart_01M3SEDCM3YV4WTD2R53A9A1QZ` | — | `ORDTST01M3SEDPJB9WDPY4FJ8N07PQ20` | #128 |

Reembolsos: `ref_01M3SEN2XVFWHES3GWVT8H9YEX` (#119, R$ 100) e `ref_01M3SEN5Y8RQT2G8P9XBJ892PK` (#128, R$ 510).

### Observações

- **O corpo do `402` contém uma referência `ORDTST…`** igual ao ID da Order `failed` (extraída do texto da resposta; o campo não foi identificado) [sandbox 2026-09-30]. A INV-008 registra que o `402` "não traz o ID da Order"; ela não foi editada. Isso não muda o fluxo: o provider não lê o corpo do erro, e a tentativa `failed` fica sem `mercadopago_order_id`.
- Depois que o túnel voltou, chegaram notificações `type=order` das Orders do #119 e do #128 (com `external_reference` no formato da tentativa e `cart_id`, respectivamente), as duas com HTTP 200 [log 2026-09-30]. Entregas depois do reembolso; `action` não registrado.

### O que continua sem execução

- Cenário 6 com o job: o job não existe no código.
- Regressão E2E do cancelamento (ADR-012/013) depois de `6f5acdd`.
- `cancelPayment` (cartão), que reutiliza a chave base [não validado].
- H2, H3 e H4 continuam [não validado].
- O [artefato residual](#dados-criados-e-pendência) não foi relido nesta etapa.
