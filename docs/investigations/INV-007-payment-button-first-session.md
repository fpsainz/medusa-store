# INV-007: `PaymentButton` escolhe o botão por `payment_sessions[0]`

> Status: concluída · Aberta em: 2026-09-29 · Commit: `629acfd`

## Achado

`PaymentButton` (`apps/storefront/src/modules/checkout/components/payment-button/index.tsx`) lê `cart.payment_collection?.payment_sessions?.[0]` e escolhe o botão (Stripe, Mercado Pago, manual ou "Select a payment method") só pelo `provider_id` dessa session. A Store API não ordena `payment_sessions`. A pergunta é se `[0]` é a session certa.

## Fatos

Verificados no código do projeto em `629acfd` e no `@medusajs/core-flows`, `@medusajs/medusa`, `@medusajs/payment` e `@medusajs/js-sdk` 2.20.1 instalados.

**Storefront**

- `PaymentButton` usa de `[0]` apenas `provider_id` (`isStripeLike` / `isMercadoPago` / `isManual`). Não olha `status` nem `data`. O bloqueio do Pix vem de fora, pela prop `mercadoPagoBlocked` calculada na Review.
- Os outros consumidores do mesmo array selecionam por predicado, não por posição:
  - `Payment` e `PaymentWrapper`: `find(status === "pending")`;
  - `MercadoPagoPaymentContainer`: `find(provider_id === paymentProviderId && status === "pending")`;
  - `Review`: `find(isMercadoPago(provider_id) && data.payment_method_id === "pix")`;
  - `app/api/payment-return/route.ts` (Stripe): `find` pelo `client_secret`.
- Sessions só são criadas por `initiatePaymentSession` (`lib/data/cart.ts`) → `sdk.store.payment.initiatePaymentSession` → `POST /store/payment-collections/:id/payment-sessions`. As rotas `/store/mercadopago/payment-sessions/:id` e `/pix` só atualizam uma session existente.
- No Mercado Pago, o botão "Continue" do passo Payment fica desabilitado até o `onSubmit` do Brick (`paymentComplete`), e o Brick só é renderizado quando já existe uma session `pending` do provider.

**Core (Medusa 2.20.1)**

- `POST /store/payment-collections/:id/payment-sessions` roda `createPaymentSessionsWorkflow` e não aplica lock.
- `createPaymentSessionsWorkflow` lê `payment_sessions.*` da collection e, em paralelo com a criação da nova session, roda `deletePaymentSessionsWorkflow` sobre **todas** as sessions lidas. O comentário do core diz: "we don't support split payments at the moment".
- `deletePaymentSessionsWorkflow` → `validateDeletedPaymentSessionsStep`: se alguma session não foi apagada, lança `UNEXPECTED_STATE` e o workflow inteiro é compensado. A session nova também é desfeita.
- `PaymentModuleService.deletePaymentSession` chama o `deleteSession` do provider e depois `paymentSessionService_.delete`, que remove a linha (não é soft delete).
- `refreshPaymentCollectionForCartWorkflow` (mudança de total ou de moeda do cart) apaga todas as sessions da collection e não cria outra.
- Os outros criadores de session no core (`refund-payment-recreate-payment-session`, `mark-payment-collection-as-paid`) são fluxos de pedido/Admin, não de cart aberto.
- `completeCartWorkflow` autoriza `paymentSessions[0]`, onde `paymentSessions` é o resultado de `validateCartPaymentsStep` (sessions com status processável, sem ordenação). **O próprio core também assume uma única session.**
- `GET /store/carts/:id` (`query-config.js`) pede `*payment_collection.payment_sessions` sem `order`.

**Banco** [banco 2026-09-29, consulta read-only]

- 106 payment collections com session, **todas com exatamente 1 session**; nenhuma collection com 2 ou mais.
- 0 linhas de `payment_session` com `deleted_at` preenchido, o que confirma a remoção física.
- Status atuais: `authorized` 39, `pending_authorization` 33, `pending` 31, `canceled` 3. As `canceled` estão em collections com uma única session.

## Respostas

1. **Onde:** `payment-button/index.tsx`, na linha `const paymentSession = cart.payment_collection?.payment_sessions?.[0]`.
2. **O que ele usa:** só `provider_id`.
3. **Ordem garantida:** não. Nem a Store API nem o workflow ordenam o array.
4. **`order`/`sort`/`created_at` no endpoint:** não há. `retrieveCart` também não pede ordenação.
5. **Mais de uma session na collection de um cart aberto:** não, em operação sequencial. Cada criação apaga as anteriores e, se não conseguir, desfaz a si mesma. A única brecha teórica é a concorrência (ver Hipóteses).
6. **Fluxos que poderiam gerar mais de uma:** só duas chamadas concorrentes de `initiatePaymentSession` na mesma collection, por exemplo duas abas ou cliques rápidos entre providers diferentes. Troca de método, troca Pix ↔ cartão e alteração do cart são sequenciais e deixam no máximo uma session.
7. **Session cancelada, expirada ou antiga no array:** antigas não, porque são apagadas. `canceled` só foi observada em pedidos cancelados, e nesse caso ela é a única session da collection. Um Pix vencido é regenerado na mesma session (`regenerate`), sem criar outra. Qualquer que seja o status dessa session depois do vencimento, ela continua sendo a única da collection, e o `provider_id`, único campo lido pelo `PaymentButton`, não muda.
8. **Recriação de Pix:** `regenerate` e `prepare` atualizam a mesma session (`updatePaymentSession`). O caso de remoção de item (#86 em [../status.md](../status.md)) apaga a session (`deletePayment`) e cria outra, novamente sozinha.
9. **Cartão e Pix coexistindo:** não. Os dois usam o mesmo provider e a mesma session; a diferença está em `data.payment_method_id`.
10. **Session "ativa" identificável:** sim. Com no máximo uma session, ela é a ativa. Os predicados já usados no storefront (`status === "pending"`, provider, `payment_method_id`) a identificam sem depender de posição.
11. **Seleção correta em outro ponto:** sim. `Payment`, `PaymentWrapper`, `MercadoPagoPaymentContainer` e `Review` usam `find`. `PaymentButton` é o único que usa posição.

## Hipóteses (não validadas)

- **H1 — corrida em `createPaymentSessionsWorkflow`** [não validado]. Duas requisições concorrentes em uma collection sem session leem `payment_sessions = []`, não apagam nada e criam uma session cada. Com session prévia, a segunda deleção tende a falhar em `retrieve` e desfazer a própria criação, mas uma janela estreita pode deixar duas. Esse comportamento não foi reproduzido.
  - Mesmo se ocorrer, **não é um defeito do `PaymentButton`**. O `completeCartWorkflow` autorizaria `paymentSessions[0]` em ordem não definida, e nenhuma escolha feita no storefront controla isso.
  - Na região Brasil, que só aponta para `pp_mercadopago` [banco 2026-09-25], as duas sessions teriam o mesmo provider, e o `PaymentButton` mostraria o mesmo botão com qualquer uma delas.

## Reprodução

- **A (uma session):** coberta pelo banco. As 106 collections estão nesse estado, inclusive as dos E2E #75–#101 em [../status.md](../status.md).
- **B, C e D (duas sessions; antiga + nova; cancelada + ativa):** não são alcançáveis em operação sequencial, pelo contrato do core descrito acima e pelo banco (nenhuma collection com mais de uma session). **Não executados por HTTP.** Buscar no banco a publishable key e a região, para montar os carts de teste, foi negado pela política de permissões da sessão em 2026-09-29.
- **H1 (corrida):** não executada pelo mesmo motivo. Roteiro proposto, que exige autorização:
  1. criar um cart sandbox na região Brasil e a payment collection;
  2. disparar N `POST /store/payment-collections/:id/payment-sessions` concorrentes com `pp_mercadopago`;
  3. contar as sessions da collection.

  `initiatePayment` e `deletePayment` de uma session sem Order Mercado Pago não chamam a API do Mercado Pago.

## Critério de decisão

- Se a ordem não é garantida e existe outro mecanismo que garante uma única session: **B**, sem correção obrigatória.
- Se H1 for reproduzida: o problema é do core (`createPaymentSessionsWorkflow` sem lock; `completeCartWorkflow` com `[0]`), e é tratado em investigação própria.

## Resultado

**Conclusão B.** A ordem de `payment_sessions` não é garantida, mas o `createPaymentSessionsWorkflow` do Medusa 2.20.1 garante no máximo uma session por payment collection em operação sequencial: apaga fisicamente as anteriores e se desfaz se não conseguir. Assim, `[0]` é a única session. O banco confirma o invariante em 106 de 106 collections. **Não há bug no `PaymentButton`.**

Destino: **sem ação de código obrigatória**.

- Melhoria opcional de consistência, que não corrige defeito: em `PaymentButton`, trocar `[0]` pelo mesmo predicado dos irmãos (`find(status === "pending")`), com teste do componente. Ela não protegeria contra H1, porque, com duas sessions `pending`, o core continuaria autorizando a sua própria `[0]`.
- H1 fica registrada como hipótese do core. Se for reproduzida, abrir uma investigação nova.
