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

### Estados depois de uma Order paga

Fonte: código do Medusa 2.20.1 instalado (`@medusajs/medusa` subscriber `payment-webhook`, `@medusajs/core-flows` `processPaymentWorkflow`/`authorizePaymentSessionStep`/`capturePaymentWorkflow`, `@medusajs/payment` `PaymentModuleService`), lido em 2026-09-29. Caminho de uma session Pix que ainda não tem Payment:

```text
order.processed
→ getStatusFromGateway = captured → ação `captured` (PaymentActions.SUCCESSFUL)
→ processPaymentWorkflow, ramo de auto-captura (sem Payment para a session)
→ authorizePaymentSession → provider authorizePayment (Pix: relê a Order) → captured
→ Payment Session gravada como authorized (o módulo converte captured em authorized)
→ Payment criado e capturado sem chamar o provider (captured_at)
→ 1 Capture
→ collection completed
→ cart concluído e pedido criado (completeCartAfterPaymentStep, só se o cart ainda não tem pedido)
```

- **Session `authorized` não significa ausência de captura.** O Medusa guarda a captura no Payment (`captured_at`) e nos Captures, não no status da session. O `authorizePaymentSessionStep` considera falha qualquer session que não esteja `authorized`.
- Para verificar se o pagamento foi concluído, confira: session `authorized` com `authorized_at`, exatamente 1 Payment com `captured_at`, 1 Capture, e collection `completed` com o valor capturado igual ao amount.
- O `capturePayment` do provider, que lança erro de propósito ([ADR-002](../decisions/ADR-002-orders-api-automatic-capture.md)), não é chamado nesse caminho.
- Observado assim no cenário C (#83) e no E2E B' ([E2E-B-PRIME-2026-09-29](../investigations/E2E-B-PRIME-2026-09-29.md)).

## Validação

**Resumo:** ✅ correlação validada por testes unitários · ✅ webhook real pós-hardening validado: #83 (2026-09-27) para a correlação, #92 (2026-09-29) para o fluxo assíncrono de ponta a ponta · ✅ duplicidade · ✅ correlação negativa [decisão humana 2026-09-29: consolidação das evidências existentes, sem novo E2E].

- ✅ Correlação validada por teste unitário (ver [Testes](#testes)).
- ✅ Correlação validada por webhook real depois do hardening, em 2026-09-27, com o código `3a56150`. Foram cobertos: Pix pago completando o cart só pelo webhook, notificação tardia de cart já completo sem efeito, Order paga sem session respondendo 503 sem atingir outra session, e `order.action_required` sem autorizar. Evidência em [../status.md](../status.md#webhook-real-depois-do-hardening-2026-09-27-código-3a56150).
- ✅ Aprovação de um Pix criado pelo checkout validada por webhook real em 2026-09-29: com o nome de cobrança `APRO` (ADR-010), o sandbox aprova a Order. `order.action_required` e `order.processed` chegaram com correlação exata e 200 ([E2E-B-PRIME-2026-09-29](../investigations/E2E-B-PRIME-2026-09-29.md); como testar em [testing.md](testing.md#pix-no-sandbox)).
- ✅ Fluxo assíncrono de ponta a ponta validado por webhook real em 2026-09-29, pedido #92: Pix criado pelo checkout e aprovado no sandbox; o webhook concluiu o cart antes de qualquer Place order (`processPaymentWorkflow` → `completeCartAfterPaymentStep` → `completeCartWorkflow`), com 1 Payment capturado, 1 Capture, collection `completed` e 1 Order Medusa, sem `POST /complete` ([E2E-B-2026-09-29](../investigations/E2E-B-2026-09-29.md)).
- ⚠ `notifications_history` do MCP do Mercado Pago: voltou vazio em 2026-09-29 mesmo depois de webhooks reais entregues, mas mais tarde, no mesmo dia, com o MCP conectado à conta de teste [decisão humana 2026-09-29], ele mostrou notificações reais das Orders de teste (#97–#101: horário, tentativas e código HTTP da resposta) [MCP 2026-09-29] ([INV-006](../investigations/INV-006-payment-collection-rollback.md)). Limites: trunca o ID da Order e não mostra o `action` nem o corpo, então não prova sozinho qual evento chegou a qual Order; a evidência de processamento continua sendo o registro dos testes reais do projeto.

## Por que o HMAC usa `data.id` em minúsculas

Ver [ADR-004](../decisions/ADR-004-webhook-hmac-lowercase-data-id.md).

## Testes

`apps/backend/src/api/hooks/payment/[provider]/__tests__/route.unit.spec.ts` cobre todos os códigos de resposta acima, a correlação (Order atual, Order antiga paga, Order desconhecida, session sem Order, notificação duplicada) e o mapeamento de `getWebhookActionAndData`.
