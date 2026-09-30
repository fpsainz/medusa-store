# ADR-014: Idempotency key da Order de cartão derivada do body

> Status: aceito [decisão humana 2026-09-29] · Data: 2026-09-29 · Commits: `fb6753e`

Investigação e evidências: [INV-008](../investigations/INV-008-card-idempotency-key-per-session.md). Regra garantida pelo código: invariante 47 em [../mercadopago/invariants.md](../mercadopago/invariants.md). **[MCP 2026-09-29]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data.

## Contexto

- A chave base de uma session Mercado Pago é o ID da Payment Session. O Payment Module passa `context.idempotency_key = session.id` ao `initiatePayment`, que grava o valor em `session.data.mercadopago_idempotency_key`. Ela só muda quando a session é recriada.
- Até esta decisão, `authorizePayment` (cartão) enviava **a chave base** como `X-Idempotency-Key` do `POST /v1/orders`, com um body que inclui o `card_token` do envio atual do Brick.
- Contrato da Orders API [MCP 2026-09-29]:
  - uma requisição repetida com a mesma chave "retorne o resultado original sem processar a operação novamente";
  - com a mesma chave e um body diferente, `409 idempotency_key_already_used` ("nas últimas 24 horas");
  - "Gere uma nova chave para cada operação distinta".
- Evidência [sandbox 2026-09-29], na mesma session e com a chave base:
  1. `OTHE` → `402 failed / rejected_by_issuer`;
  2. o SDK lança exceção, o Medusa não grava nada e a session continua `pending`;
  3. novo cartão `APRO` → mesma chave, outro body → `409 idempotency_key_already_used`.

  Resultado: a nova tentativa legítima ficava bloqueada na session.

## Decisão

A chave da Order de cartão passa a ser derivada, nunca substituída:

```text
sha256("<mercadopago_idempotency_key>:card:<sha256(canonicalJson(body))>")
```

- `body` é o objeto exato enviado ao `POST /v1/orders`: `type`, `external_reference`, `total_amount`, `currency`, `processing_mode`, `description`, `payer` e `transactions.payments[].{amount, payment_method.{id, token, type, installments}}`.
- `canonicalJson` ordena as chaves de objeto em todos os níveis, mantém a ordem dos arrays, omite propriedades `undefined` e serializa `undefined` dentro de array como `null`, como o `JSON.stringify`. O SDK envia `JSON.stringify(body)` do mesmo objeto (`mercadopago` 3.6.1, `clients/order/create`). Para os valores JSON que o body contém, as duas serializações diferem só na ordem das chaves. A chave não depende da ordem de montagem nem da ordem de leitura do `jsonb`.
- A derivação é centralizada em `getCardOrderIdempotencyKey`, em `service.ts`, e só o `authorizePayment` do cartão a usa.
- `mercadopago_idempotency_key` continua gravada em `data` como chave base. `initiatePayment`, `updatePayment`, a rota de update, o schema da session, o Pix, o reembolso e o webhook não mudam.
  - O campo `mercadopago_orders_api.headers['X-Idempotency-Key']` que o `initiatePayment` grava é apenas descritivo: nenhum código o lê. Ele continua mostrando a chave base.

### Semântica

| Evento | Chave | Por quê |
|---|---|---|
| Retry do SDK (429/5xx) ou novo Place order com os mesmos dados | a mesma | O body é função pura de `session.data` persistida, então é o mesmo body e o Mercado Pago devolve o resultado original. |
| Nova tentativa na mesma session (novo envio do Brick: token novo, e também parcelas, payer, tipo ou valor) | nova | É outro body, portanto outra operação para a Orders API. |
| Nova Payment Session | nova | A chave base é outra. |
| Webhook | — | Não cria Order. |

## Alternativas consideradas

- **A — chave derivada só do `card_token`** (`sha256(base:card:sha256(token))`).
  - O Brick gera um token novo a cada `onSubmit` e envia token, parcelas, tipo e payer juntos. Na prática, cada tentativa pelo Brick muda o token.
  - Rejeitada porque o contrato do Mercado Pago é definido pelo **body**, não pelo token. Com o mesmo token e outro body (parcelas, payer, tipo ou valor alterados por uma chamada à rota de update sem token novo), a mesma chave voltaria a produzir `409`.
  - A estratégia escolhida é "mesma chave ⇔ mesmo body" por construção (salvo colisão de SHA-256), e por isso não provoca `409 idempotency_key_already_used` com as próprias requisições.
- **Manter a chave da session.** Rejeitada pela evidência 402 → 409.
- **Chave aleatória por chamada.** Rejeitada: perde a idempotência dos retries.

Diferenças não materiais não geram chave nova. O body é montado pelo provider com formatação fixa (`toFixed(2)`, `Number(installments)`), e a canonicalização remove a dependência da ordem de chaves. Qualquer diferença que sobra é uma diferença de body também para o Mercado Pago.

## Timeout e operação ambígua

Cenário: o `POST /v1/orders` foi enviado, a resposta se perdeu (timeout ou erro de rede depois das tentativas do SDK) e não se sabe se a Order foi criada ou paga.

- **Comum às duas versões:** o provider lança exceção, o Medusa não grava nada e a session continua `pending`, sem `mercadopago_order_id`. Um novo Place order com os mesmos dados reenvia o mesmo body com a mesma chave, e o Mercado Pago devolve o resultado original. Não há cobrança dupla.
- **Novo cartão depois do timeout:**
  - **Antes:** mesma chave com outro body → `409`. Isso evitava uma segunda cobrança **por acidente**, ao preço de bloquear toda nova tentativa legítima.
  - **Agora:** chave nova → nova Order. **Se a primeira operação foi aceita pelo Mercado Pago e só a resposta se perdeu, pode haver uma segunda cobrança.** A primeira Order paga não pertence a nenhuma session: o webhook dela responde 503 (invariante 20), e o Mercado Pago reenvia. O caso exige conciliação e reembolso manuais.
- **Com o mesmo token e outro body:** um token de cartão já consumido pela primeira operação não deveria ser aceito de novo [não validado].
- **A chave garante a idempotência da mesma operação, não a reconciliação de uma operação ambígua.** Esta mudança não introduz nenhum mecanismo automático de reconciliação.
- **Não existe reconciliação no código:** `authorizePayment` (cartão) não consulta Orders por `external_reference` antes de criar outra, e nada é gravado quando o `create` lança exceção. Não foi implementada agora porque nenhum timeout real foi observado. O caminho para uma decisão futura é consultar Orders do cart antes de uma nova criação quando a tentativa anterior terminou sem resposta.

## Consequências

- **Cartão:** a nova tentativa na mesma session deixa de receber `409`. Retries continuam idempotentes.
  - [sandbox 2026-09-29]: `OTHE` → 402; o mesmo request de novo → mesma chave, 402 com o **mesmo** payment ID (resultado original); Visa `APRO` com token novo → chave nova → 201 `processed/accredited`, Payment capturado e pedido Medusa criado.
- **Pix:** não muda. A chave continua `sha256(base:pix:<valor>:<geração>)` (invariante 11). Não colide com a do cartão, porque o sufixo é outro.
- **Reembolso:** não muda. A chave continua `refund.id` (invariante 43).
- **Sessions existentes:** compatíveis. A base continua em `data`.
  - Uma session que recebeu 402 antes da mudança passa a aceitar uma nova tentativa.
  - Uma session já autorizada não chama mais o provider (`authorizePaymentSession` é idempotente).
  - Exceção: um request enviado com a chave base **antes** da mudança e sem resposta não será deduplicado por um retry feito **depois**, porque a chave agora é outra. É o mesmo risco da seção de timeout.
- **SHA-256 × HMAC:** a chave derivada não é persistida nem registrada e só é enviada ao Mercado Pago, que já recebe o body inteiro. A pré-imagem inclui o `card_token`, de uso único e alta entropia, então a chave não permite verificar palpites sobre o CPF ou outros campos. As outras chaves do projeto (Pix e cancelamento do Pix) também usam SHA-256. Um HMAC com segredo do servidor seria uma melhoria opcional, não um requisito desta decisão.
- **Fora do escopo:** `cancelPayment` (cartão) continua usando a chave base, sem teste [não validado]; ver INV-008, H3.
