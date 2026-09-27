# Testes do Mercado Pago

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

## Testes unitários (backend)

```bash
cd apps/backend && pnpm run test:unit
```

Resultado em 2026-09-25: **6 suítes, 121 testes, todos passando.**

| Spec (em `apps/backend/src/`) | Cobre |
|---|---|
| `modules/mercadopago/__tests__/service.unit.spec.ts` | `authorizePayment` (cartão e Pix), discriminador Pix, ciclo da cobrança Pix na Review (prepare/reuse/regenerate/invalidate), `deletePayment`, autorização depois da Review, respostas inesperadas da API, `normalizePixStatus`, `toPixPaymentDto` |
| `api/hooks/payment/[provider]/__tests__/route.unit.spec.ts` | Todo o webhook: comportamento do core, validações, HMAC, códigos de resposta, correlação, `getWebhookActionAndData` |
| `api/store/mercadopago/payment-sessions/[id]/__tests__/route.unit.spec.ts` | Allowlist, posse da session, provider, não autorização |
| `api/store/mercadopago/payment-sessions/[id]/pix/__tests__/route.unit.spec.ts` | Prepare/regenerate, session já autorizada, posse, cart completo, rejeição de sessions de cartão |
| `api/store/mercadopago/carts/[id]/pix/__tests__/route.unit.spec.ts` | Leitura ao vivo, estados terminais, fallback com o Mercado Pago fora do ar, 404, isolamento por cart |
| `api/store/mercadopago/orders/[id]/pix/__tests__/route.unit.spec.ts` | DTO restrito, fallback de expiração, isolamento por provider, 404 |

### Sem cobertura

- `refundPayment`, `cancelPayment`, `retrievePayment`, `getPaymentStatus`, `capturePayment`, `initiatePayment` (nenhuma menção no spec do provider).
- Um teste que falhe se `id` for adicionado ao provider em `medusa-config.ts`.
- Testes de integração HTTP (não existem), testes no storefront (não existem) e CI (não existe).

## Checagem de tipos

```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/storefront && npx tsc --noEmit
```

Os dois sem erros em 2026-09-25.

## E2E (manual, navegador)

O procedimento detalhado está na skill [.agents/skills/integration-testing/SKILL.md](../../.agents/skills/integration-testing/SKILL.md). Resumo das regras:

- Começar de sessão limpa, pela página de produto. Nunca preparar cart/session/pedido via API.
- Parar na primeira falha e registrar etapa, endpoint, status HTTP, erro, estado do cart, da session e do payment.
- Usar apenas dados sandbox oficiais do Mercado Pago. Nunca registrar cartão, CVV, tokens ou credenciais.
- O webhook real exige URL pública: [../runbooks/dev-webhook-tunnel.md](../runbooks/dev-webhook-tunnel.md).

Estado das validações E2E (cenários, pedidos e pendências): [../status.md](../status.md#evidência-e2e). Não duplicar aqui.

## Checklist após mudanças no provider ou no webhook

1. `pnpm run test:unit` (backend).
2. `tsc --noEmit` no backend e no storefront; `pnpm run lint`.
3. Se a identidade do provider for tocada: `SELECT` read-only confirmando `provider_id` de `payment_session`, `payment` e `region_payment_provider`.
4. E2E de checkout novo (cartão e/ou Pix, conforme a mudança).
5. Webhook real em `/hooks/payment/mercadopago` sem `AwilixResolutionError`.
6. Se tocar em retrieve/status/refund: exercitar em pelo menos um Payment existente.
7. Admin: Mercado Pago disponível na região Brasil.
