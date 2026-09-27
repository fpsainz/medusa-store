# Webhook Mercado Pago

> Status: vigente · Última verificação: 2026-09-27 · Commit: `3a56150`

Arquivo: `apps/backend/src/api/hooks/payment/[provider]/route.ts`. Ele **sobrescreve** a rota de webhook de pagamento do core do Medusa, no mesmo caminho.

URL: `POST /hooks/payment/mercadopago`. Em desenvolvimento, ver [../runbooks/dev-webhook-tunnel.md](../runbooks/dev-webhook-tunnel.md).

## Sequência

1. `provider !== "mercadopago"` → emite `payment.webhook_received` como o core faz e responde 200 (erro no emit → 400).
2. `data.id` (query string, valor único) ausente ou ambíguo → **400**.
3. Header `x-signature` ou `x-request-id` ausente ou múltiplo → **400**.
4. `MERCADOPAGO_WEBHOOK_SECRET` ausente → **500**.
5. `WebhookSignatureValidator.validate` do SDK, com `dataId` em minúsculas → inválida: **401**; outro erro: **500**.
6. `MERCADOPAGO_ACCESS_TOKEN` ausente → **500**.
7. `GET /v1/orders/{data.id}` (valor original) → falha: **502**.
8. Order sem `external_reference` → **200**, sem processar.
9. Busca sessions do `payment_collection` do cart com `provider_id = pp_mercadopago` e `data.mercadopago_order_id === data.id`:
   - erro na consulta → **503**
   - mais de uma → **503** + `logger.error`
   - nenhuma e a Order está paga (`processed`/`approved`/`authorized` na Order ou no payment) → **503** + `logger.warn`, para o Mercado Pago tentar de novo
   - nenhuma e não paga → **200** + `logger.info`
10. Emite `payment.webhook_received` com `provider: "mercadopago"` e payload enriquecido: `dataId`, `sessionId`, `orderStatus`, `orderStatusDetail`, `paymentStatus`, `paymentStatusDetail`, `amount` (`paid_amount` ou `amount` do payment, só se for decimal válido ≥ 0). Opções do emit: `delay = webhook_delay || 5000`, `attempts = webhook_retries || 3`, lidas das opções do módulo de pagamento (não configuradas em `medusa-config.ts`, então valem os padrões). Erro no emit → **400**. Sucesso → **200**.

## Processamento no provider

O Medusa entrega o payload a `getWebhookActionAndData` (`service.ts`), que **não faz chamada de rede**:

- Precisa de `sessionId` e de `payload.data.type === 'order'` (o `type` vem do body original); senão, `not_supported`.
- Mapeia o status com `getStatusFromGateway` (a mesma tabela do cartão, também para o Pix). Só `captured` e `authorized` geram ação; o resto vira `not_supported`.
- Exige `amount` como string não vazia.

A partir da ação, o core do Medusa 2.20.1 segue o fluxo nativo `processPaymentWorkflow` → `completeCartAfterPaymentStep` → `completeCartWorkflow`, que completa o cart mesmo sem o navegador.

## Validação

- ✅ Correlação validada por teste unitário (ver [Testes](#testes)).
- ✅ Correlação validada por webhook real depois do hardening, em 2026-09-27, com o código `3a56150`. Foram cobertos: Pix pago completando o cart só pelo webhook, notificação tardia de cart já completo sem efeito, Order paga sem session respondendo 503 sem atingir outra session, e `order.action_required` sem autorizar. Evidência em [../status.md](../status.md#webhook-real-depois-do-hardening-2026-09-27-código-3a56150).
- Um Pix criado pelo checkout não é aprovável no sandbox; ver [testing.md](testing.md#pix-no-sandbox).

## Por que o HMAC usa `data.id` em minúsculas

Ver [ADR-004](../decisions/ADR-004-webhook-hmac-lowercase-data-id.md).

## Testes

`apps/backend/src/api/hooks/payment/[provider]/__tests__/route.unit.spec.ts` cobre todos os códigos de resposta acima, a correlação (Order atual, Order antiga paga, Order desconhecida, session sem Order, notificação duplicada) e o mapeamento de `getWebhookActionAndData`.
