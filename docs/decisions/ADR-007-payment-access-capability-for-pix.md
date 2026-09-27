# ADR-007: Capability temporária (`payment_access`) para acompanhar o Pix depois do checkout

> Status: proposto · Data: 2026-09-27 · Commits: nenhum ainda (decisão registrada sobre `1749309`)

Marcadores de origem: [../README.md](../README.md#convenções). Além deles, **[MCP 2026-09-27]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data.

## Contexto

### Como o Pix é acompanhado hoje

- A cobrança Pix (Order Mercado Pago) é criada na Review, antes do pedido Medusa existir ([ADR-003](ADR-003-pix-charge-created-at-review.md)).
- Antes do pedido, o painel Pix lê `GET /store/mercadopago/carts/:id/pix`. A credencial é o `cart_id`, que o Next Server lê do cookie HttpOnly `_medusa_cart_id`.
- Depois do pedido, a página de confirmação lê `GET /store/mercadopago/orders/:id/pix`. A credencial é o `order_id`, que está na URL `/{countryCode}/order/{id}/confirmed` e não expira. Desde `1749309` a resposta é só `{ status, ticket_url }`.

### Fatos verificados

- `GET /store/mercadopago/carts/:id/pix` não confere `completed_at`: depois da conclusão, quem tem o `cart_id` continua lendo QR, ticket, `mercadopago_order_id` e status nativos.
- O `cart_id` também sai do sistema: `createPixOrder` o envia ao Mercado Pago em `external_reference` e em `description` (`Medusa cart <id>`).
- A publishable key e a URL do backend são `NEXT_PUBLIC_*` (`apps/storefront/src/lib/config.ts`). Portanto a Store API não distingue o Next Server de outro chamador: "só o Next Server chama esta rota" não pode ser garantido.
- `POST /store/mercadopago/payment-sessions/:id/pix` (prepare) já confere: session `pp_mercadopago` do payment collection do cart informado, cart sem `completed_at` e `payment_method_id === "pix"`.
- `apps/storefront/next.config.js` usa `logging.fetches.fullUrl: true`: uma credencial em URL de fetch server-side iria para o log.
- O painel Pix e a Review são Client Components (`"use client"`). O que um Server Action devolve chega ao browser.
- `apps/storefront/src/lib/data/cookies.ts` já grava cookies HttpOnly a partir de Server Actions (`setCartId`, `setAuthToken`).
- No `@medusajs/link-modules` 2.20.1, o link `order-payment-collection` declara o alias `order` em `PaymentCollection`. A consulta reversa collection → order ainda não foi executada neste projeto **[não validado]**.
- `apps/backend/medusa-config.ts` registra só o módulo de pagamento. O event bus é o padrão do Medusa, sem pub/sub entre instâncias.
- O webhook só gera ação para `captured` e `authorized` (`getWebhookActionAndData`). Expiração e cancelamento do Pix não chegam à session Medusa.
- Cartão nunca gera pedido com pagamento pendente: `getStatusFromGateway` não produz `pending_authorization`, e o `authorize-payment-session` do `@medusajs/core-flows` 2.20.1 só aceita `AUTHORIZED` (ou deixa passar `PENDING_AUTHORIZATION`).

### Mercado Pago [MCP 2026-09-27]

- A resposta de criação traz `ticket_url`, `qr_code` e `qr_code_base64`, com `action_required`/`waiting_transfer` até o pagamento. `ticket_url` abre o Pix com QR e copia e cola, ou seja, é tão pagável quanto o QR.
- `transactions.payments[].expiration_time` é uma duração ISO 8601. Para Pix, o padrão é 24 h e o permitido vai de 30 min a 30 dias. `createPixOrder` não envia esse campo hoje.
- Status de Order: `created`, `processing`, `action_required`, `processed`, `canceled`, `expired`, `failed`, `refunded`, `charged_back`. `processed` ainda pode virar `refunded`, `partially_refunded` ou `charged_back`.
- Notificações: resposta 200/201 em até 22 s; sem ela, novas tentativas a cada 15 min, sem fim. A documentação recomenda responder antes de processar "para evitar notificações duplicadas".
- O Status Screen Brick é inicializado com um `paymentId` da **Payments API** e roda no browser.

### Não confirmado

- Se a Orders API devolve uma data absoluta de expiração do Pix. Os tipos do SDK `mercadopago` 3.6.1 declaram `date_of_expiration` e `expiration_time` opcionais no payment, mas o exemplo oficial não mostra nenhum dos dois. A consulta read-only ao banco foi bloqueada pelo hook do plugin Mercado Pago em 2026-09-27.
- Quando a Order passa de fato a `expired`, e se `order.expired` é enviado para Pix online. A documentação diz que um pagamento não pago é considerado expirado 30 dias após o vencimento e recomenda cancelar no vencimento.
- Se alguma página do Mercado Pago mostra `description`/`external_reference` (e portanto o `cart_id`) a quem abre o `ticket_url`.
- Se a ordem de entrega das notificações é garantida. Não está documentada.

## Decisão

1. **Credencial.** Uma capability opaca de propósito `pix_payment_view`: 256 bits aleatórios (`crypto.randomBytes(32)`), com prefixo reconhecível. Só o SHA-256 do token é persistido. Não é JWT, é só leitura e não autoriza nenhuma ação.
2. **Módulo.** Um módulo genérico `payment_access` guarda a capability com hash, propósito, provider, método, payment session, payment collection, cart de emissão, expiração, revogação e timestamps. Só a política Pix é implementada agora.
3. **Emissão.** Acontece **dentro** do fluxo de prepare do Pix, autorizada pela posse do `cart_id` enquanto o cart está aberto, com as mesmas verificações da rota atual e a cobrança já existente. Não existe rota pública de emissão separada. Há um limite de capabilities ativas por session.
4. **Transporte.** O token existe só entre o Medusa e o Next Server. O browser recebe apenas um cookie HttpOnly. O Next Server envia o token ao Medusa por header, nunca por URL. Server Actions devolvem o DTO sem o token.
5. **Leitura.** `GET /store/mercadopago/payment-access/pix` não recebe `order_id` nem `payment_session_id` do cliente: resolve session, collection e order a partir da capability e revalida o estado atual (session existe, é `pp_mercadopago`, é Pix, pertence à collection). Qualquer falha dá a mesma resposta genérica. O token nunca é aceito em query string.
6. **Estado e DTO.** O estado é o primeiro destes a acontecer: session `authorized` no Medusa, leitura ao vivo da Order Mercado Pago ou deadline local. QR, ticket e expiração saem só com o Pix pendente **e** antes da deadline; depois disso, só o status. A resposta é uma allowlist explícita.
7. **Deadline.** `createPixOrder` passa a enviar `expiration_time`. A deadline é calculada de forma conservadora no backend (início da requisição + duração). Se a resposta trouxer uma data absoluta, vale a menor das duas.
8. **Revogação.** Na troca de Pix para outro método na mesma session, além da revalidação a cada leitura.
9. **Atualização de status.** Polling por Server Action. Sem SSE nem WebSocket.
10. **Escopo.** Cartão e débito não usam a capability. Boleto poderá reutilizar o núcleo com política própria (a deadline não pode ser "agora + duração", porque o vencimento é ajustado para dia útil [MCP 2026-09-27]). Um link de resgate de uso único para boleto não faz parte desta decisão.
11. **`carts/:id/pix`.** Deixa de responder depois de `completed_at`, e seu DTO perde os campos internos (`mercadopago_order_id` e status nativos).
12. **Migração.** `GET /store/mercadopago/orders/:id/pix` e `retrievePixPayment` permanecem até o novo fluxo passar no E2E sandbox e então são removidos.

### Ainda a decidir (bloqueia a etapa correspondente)

- Duração do Pix (`expiration_time`): decisão de negócio.
- Grace period depois da deadline ou do estado final.
- Limite de capabilities ativas por session.
- TTL máximo absoluto da capability.
- Retenção de capabilities expiradas antes da limpeza.

## Alternativas consideradas

- **Manter `orders/:id/pix` com a resposta mínima (`1749309`).** O `order_id` fica na URL, não expira e não pode ser revogado. Continua como etapa intermediária, não como solução final.
- **Rota pública de emissão separada** "chamada só pelo Next Server". Descartada: a Store API não distingue chamadores.
- **Segredo compartilhado Next ↔ Medusa** (secret API key ou HMAC). Descartado: exige um novo segredo, uma key de Admin teria escopo amplo demais, e o `cart_id` já expõe os mesmos dados antes da conclusão.
- **JWT auto-contido.** Descartado: não se revoga sem uma lista server-side, expõe claims e exige gerenciar chaves.
- **Token de uso único.** Incompatível com polling.
- **SSE/WebSocket.** Não há pub/sub entre instâncias, e o polling já existe e atende a latência necessária.
- **Status Screen Brick.** Exige um ID da Payments API e roda no browser contra o Mercado Pago.
- **Capability também para cartão.** Não há pendência pós-pedido nem artefato pagável.

## Consequências

- Nova tabela (migration do módulo `payment_access`), que exige autorização explícita antes de ser aplicada.
- A confirmação do pedido deixa de depender do `order_id` para os dados Pix. Outro browser, sem o cookie, não vê o Pix.
- Com um cookie por navegador, só a última capability emitida vale: um pedido Pix anterior no mesmo browser deixa de mostrar o Pix.
- **Não resolve** a exposição de `GET /store/orders/:id` do core; ela é tratada em [INV-002](../investigations/INV-002-store-order-retrieve-without-auth.md).
- Os DTOs de `/store/mercadopago/*` não são cobertos pelo middleware do [ADR-006](ADR-006-store-api-redacts-mercadopago-provider-data.md) e continuam precisando de allowlist própria.
