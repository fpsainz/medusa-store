# ADR-006: Store API não expõe `data` do provider Mercado Pago

> Status: aceito · Data: 2026-09-27 · Commits: `c6beff1`

## Contexto

- No Medusa 2.20.1, os defaults de `/store/carts/*` (`defaultStoreCartFields` em `@medusajs/medusa/dist/api/store/carts/query-config.js`) incluem `*payment_collection.payment_sessions`. A session sai com **todas** as colunas, inclusive `data`. Isso vale para `GET /store/carts/:id`, para todas as rotas de mutação do cart e para a resposta de erro de `POST /store/carts/:id/complete`.
- `?fields=` permite pedir mais: `payment_collection.payments.data` no cart, e `payment_collections.payment_sessions.data`/`payments.data` em `GET /store/orders/:id`. O `disallowedStorePivotFields` usado por essas rotas não bloqueia esses caminhos.
- O filtro `disallowed` do core trabalha por segmento de campo. Ele não consegue tirar só `data` de uma relação expandida com `*`.
- Para o Mercado Pago, `data` guarda `card_token`, `payer` (e-mail e CPF), `issuer_id`, `installments`, idempotency keys, IDs e status internos da Order e do payment, e os dados Pix. O Payment guarda uma cópia dos mesmos campos.
- As rotas funcionam só com a publishable key, que é pública, e o ID do recurso: é o modelo de guest checkout. Isso vale inclusive para carts completos e pedidos guest.
- Comprovado com a API em execução em 2026-09-27: sem login, `GET /store/carts/:id` devolvia todas as chaves acima para um cart de cartão (já completo) e para um cart Pix. Com `?fields=`, `GET /store/orders/:id` devolvia `payments[].data`.
- O storefront só lê de `session.data` o campo `payment_method_id`, na Review (`review/index.tsx`), para detectar Pix. O Brick usa `id` e `amount` da session. Os dados Pix vêm dos DTOs de `/store/mercadopago/carts/:id/pix` e `/store/mercadopago/orders/:id/pix`.

## Decisão

1. Um middleware do projeto (`apps/backend/src/api/middlewares.ts`) atua em `/store/carts*`, `/store/payment-collections*` e `/store/orders*`. Ele envolve `res.json` com `redactMercadoPagoProviderData` (`apps/backend/src/api/utils/redact-mercadopago-data.ts`).
2. Em qualquer profundidade da resposta, o `data` de cada item de `payment_sessions[]` e `payments[]` do Mercado Pago é substituído por `{ payment_method_id }`, a única chave pública.
3. Um item é do Mercado Pago quando `provider_id === "pp_mercadopago"`. Sem `provider_id` na resposta (quando `?fields=` pede só `data`), o item é reconhecido pelas chaves `mercadopago_*` que o `initiatePayment` grava.
4. Outros providers não são tocados (o Stripe do starter precisa de `client_secret`).
5. Nada muda no armazenamento. `session.data` e `payment.data` continuam completos para o provider, o webhook e as rotas `/store/mercadopago/*`. Acesso e autenticação também não mudam.

## Alternativas consideradas

- **Tirar `*payment_collection.payment_sessions` dos defaults** (sobrescrevendo a query config): não impede `?fields=...data`, exige tocar em cada rota do core e não cobre `payments` nem `orders`. Descartada.
- **Sobrescrever as rotas do core** com arquivos no mesmo caminho: são mais de 12 rotas de cart, além de payment-collections e orders; cada atualização do Medusa exigiria revisão. Descartada.
- **Exigir login no cart:** quebra o guest checkout. Descartada [decisão humana 2026-09-27].
- **Mover os dados do provider para outro armazenamento:** duplica estado sem necessidade. O problema é a exposição, não o armazenamento. Descartada.
- **Review detectar Pix por `/store/mercadopago/carts/:id/pix`:** acrescenta uma requisição e muda o fluxo da Review. `payment_method_id` (`pix` ou a bandeira do cartão) não é sensível. Descartada.

## Consequências

- O storefront continua funcionando sem mudanças. O E2E de 2026-09-27 cobriu cartão como guest (Order #85) e Pix na Review com QR e Place order (Order #86) ([status](../status.md)).
- Uma rota nova da Store API que devolva sessions ou payments fora desses três prefixos **não** é coberta. É preciso incluí-la no `middlewares.ts`.
- Os DTOs Pix continuam sendo a única fonte de QR, ticket e status para o storefront. `mercadopago_order_id` segue público **no DTO do cart**, porque o painel Pix o usa.
- Rotas do Admin continuam vendo `data` completo (autenticadas).
- Invariante 24 em [invariants.md](../mercadopago/invariants.md).
