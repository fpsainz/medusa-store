# Arquitetura

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

## Visão geral

```text
Navegador ──> apps/storefront (Next.js 15, :8000)
                 │  @medusajs/js-sdk  +  @mercadopago/sdk-react (Payment Brick)
                 ▼
             apps/backend (Medusa 2.20.1, :9000)
                 │  módulo de pagamento @medusajs/medusa/payment
                 │    └─ provider customizado: src/modules/mercadopago  (pp_mercadopago)
                 ├──> PostgreSQL (Supabase)
                 └──> Mercado Pago Orders API (/v1/orders) via SDK `mercadopago` 3.6.1
Mercado Pago ──webhook──> POST /hooks/payment/mercadopago (backend)
```

- Monorepo pnpm 10.11.1 + Turborepo. Mercado: Brasil, moeda BRL (fixa na criação das Orders Mercado Pago).
- Único provider de pagamento customizado: Mercado Pago.

## Backend (`apps/backend`)

| Local | Papel |
|---|---|
| `medusa-config.ts` | Registra o provider Mercado Pago **sem `id`** (ver [ADR-001](decisions/ADR-001-provider-identity-pp-mercadopago.md)) e o módulo `paymentAccess`; ajusta `DATABASE_URL` para o Supabase (ver [development.md](development.md)). |
| `src/modules/mercadopago/service.ts` | Provider (`AbstractPaymentProvider`). Contém **toda** a lógica de cartão e Pix, mapeamento de status e helpers exportados usados pelas rotas (`toPixPaymentDto`, `mergePixOrderData`, `hasPixOrderData`, `PIX_TERMINAL_STATUSES`). |
| `src/api/hooks/payment/[provider]/route.ts` | Sobrescreve a rota de webhook do core. Para `provider !== "mercadopago"` replica o comportamento do core; para Mercado Pago valida HMAC e correlaciona a session. Ver [mercadopago/webhook.md](mercadopago/webhook.md). |
| `src/api/store/mercadopago/payment-sessions/[id]/route.ts` | `POST`: grava na session os dados do Brick (allowlist). Não autoriza. |
| `src/api/store/mercadopago/payment-sessions/[id]/pix/route.ts` | `POST`: prepara (cria/reutiliza/regenera) a cobrança Pix na etapa Review. |
| `src/api/store/mercadopago/carts/[id]/pix/route.ts` | `GET`: estado atual da cobrança Pix do cart (polling da Review). Só leitura. |
| `src/api/store/mercadopago/payment-access/pix/route.ts` | `GET`: dados Pix autorizados por capability (header), sem IDs do cliente. Só leitura. |
| `src/workflows/payment-access/` | Emissão e revogação da capability Pix. |
| `src/modules/payment-access` | Módulo `paymentAccess` ([ADR-007](decisions/ADR-007-payment-access-capability-for-pix.md)): tabela `payment_access_grant` com capabilities temporárias de pagamento (só o hash do token), geração, validação, limite por session e revogação (`grants.ts`, `service.ts`); parâmetros da política Pix em `policies.ts`. Migration em `migrations/`, **ainda não aplicada** (ver [status.md](status.md)). |
| `src/api/store/custom`, `src/api/admin/custom` | Rotas de exemplo do starter (`GET` → 200). |
| `src/workflows`, `src/subscribers`, `src/jobs`, `src/links` | Vazios (só README do starter). |

**Onde a lógica vive hoje:** no provider e nas rotas, não em workflows. Isso diverge da convenção do [AGENTS.md](../AGENTS.md) e **não foi uma decisão deliberada** [decisão humana 2026-09-25] — está registrado como dívida técnica em [status.md](status.md).

## Storefront (`apps/storefront`)

Baseado no starter Next.js do Medusa. Partes específicas do Mercado Pago:

| Local | Papel |
|---|---|
| `src/lib/constants.tsx` | `paymentInfoMap` e `isMercadoPago()` (compara com `"pp_mercadopago"`). Mantém entradas do starter (Stripe, PayPal). |
| `src/lib/data/cart.ts` | `updateMercadoPagoPaymentSession`, `preparePixPayment`, `retrieveCartPixPayment`, `placeOrder` (`sdk.store.cart.complete`). |
| `src/lib/util/pix-client.ts` | Fronteira servidor → cliente do Pix: allowlist do que um Client Component recebe (`toClientPixCharge`) e leitura da capability nos headers do prepare (`readIssuedPaymentAccess`). Puro, testado com `node --test`. |
| `src/lib/data/cookies.ts` | Cookies HttpOnly, inclusive o da capability Pix (`__Host-payment_access` em produção, `_payment_access` em HTTP). |
| `src/lib/data/orders.ts` | `retrieveOrderPixPayment` (Server Action): Pix do pedido lido com a capability, comparado com o `order_id` da página. |
| `src/lib/data/payment-access.ts` | `server-only`: `readPixPaymentAccess` lê o Pix com a capability do cookie, por `fetch` nativo com o token em header. |
| `src/modules/checkout/components/mercadopago-payment-container` | Renderiza o Payment Brick (cartão crédito/débito + Pix, `locale: pt-BR`, até 12 parcelas); `onSubmit` só grava dados na session. |
| `src/modules/checkout/components/review` | Mostra o `PixPaymentPanel` quando a session tem `payment_method_id === "pix"` e bloqueia o botão até a cobrança estar pagável. |
| `src/modules/checkout/components/payment-button` | `MercadoPagoPaymentButton`: único ponto que chama `placeOrder` para cartão e Pix. |
| `src/modules/order/components/payment-details/pix-payment-panel.tsx` | Painel Pix da Review (QR, copia-e-cola, ticket, polling de status). |
| `src/modules/order/components/payment-details/pix-charge-details.tsx` | Apresentação compartilhada do Pix (QR, copia e cola, ticket, prazo) e constantes de polling/status, usada pela Review e pela confirmação. |
| `src/modules/order/components/payment-details/order-pix-payment.tsx` | Pix da página de confirmação: status e artefatos pagáveis lidos com a capability, polling por Server Action (`retrieveOrderPixPayment`). |

## Fronteiras

- O storefront nunca fala com a Orders API; só o backend usa o access token.
- O storefront lê do Pix apenas DTOs restritos (sem `session.data` completo, payer ou idempotency keys).
- Fluxos detalhados: [mercadopago/README.md](mercadopago/README.md).
