# INV-002: `GET /store/orders/:id` devolve dados do comprador a quem tem o ID

> Status: aberta · Aberta em: 2026-09-27 · Commit: `1749309`

## Achado

A rota do core `GET /store/orders/:id` não exige autenticação nem confere se o pedido pertence ao chamador. Com a publishable key (pública) e o ID do pedido, ela devolve os dados pessoais do comprador. O ID do pedido fica na URL da página de confirmação.

## Fatos

Verificados no `@medusajs/medusa` 2.20.1 instalado e no código do projeto em `1749309`:

- `dist/api/store/orders/middlewares.js`: para `GET /store/orders/:id` há só `validateAndTransformQuery`, sem `authenticate`. `GET /store/orders` (lista) e as rotas de transferência exigem `authenticate("customer", ...)`.
- `dist/api/store/orders/[id]/route.js`: o handler roda `getOrderDetailWorkflow` com `order_id: req.params.id` e o filtro `is_draft_order: false`, sem filtro por cliente. O código traz o comentário `// TODO: Do we want to apply some sort of authentication here? My suggestion is that we do`.
- `dist/api/store/orders/query-config.js`: os campos padrão incluem `email`, `*shipping_address`, `*billing_address` e `*items`.
- O storefront usa essa rota na confirmação: `retrieveOrder(params.id)` em `app/[countryCode]/(main)/order/[id]/confirmed/page.tsx`. `placeOrder` redireciona para `/{countryCode}/order/{order.id}/confirmed`.
- O [ADR-006](../decisions/ADR-006-store-api-redacts-mercadopago-provider-data.md) já reduz o `data` do provider Mercado Pago nessa rota, mas não os demais campos.
- Os IDs de pedido têm o formato `order_<ULID>`, por exemplo o pedido #83 em [../status.md](../status.md).

## Inferências

- O ULID tem cerca de 80 bits aleatórios, então o ID não é adivinhável. O risco é o **vazamento**: histórico do navegador, links compartilhados, capturas de tela, atendimento, logs.
- Vale também para pedidos de clientes autenticados: o handler não diferencia.
- A capability do [ADR-007](../decisions/ADR-007-payment-access-capability-for-pix.md) não resolve este achado, porque é restrita ao Pix.

## Hipóteses (não validadas)

- H1: a API em execução devolve `email` e endereços para um pedido guest, só com a publishable key e o ID. Isso foi verificado no código, não em uma requisição real.
- H2: exigir autenticação na rota quebra a página de confirmação para guests.

## Perguntas em aberto

1. Quais campos a página de confirmação realmente precisa (itens, totais, endereço de entrega, e-mail)?
2. Existe mecanismo oficial do Medusa 2.20.1 para restringir essa rota sem sobrescrevê-la?
3. A confirmação guest deve usar uma capability própria (propósito diferente de `pix_payment_view`, com DTO próprio) ou uma rota do projeto?

## Plano de validação

1. Requisição real à API local com um pedido guest de sandbox, só com a publishable key, registrando **os nomes** dos campos devolvidos (sem dados pessoais).
2. Levantar os campos usados pelos componentes de `order-completed-template.tsx`.
3. Avaliar as alternativas contra o guest checkout.

## Critério de decisão

- H1 confirmada → decisão arquitetural própria (novo ADR) antes de qualquer código.
- H1 refutada → documentar e concluir sem ação.

## Resultado

Pendente. Esta investigação não altera o comportamento do core.
