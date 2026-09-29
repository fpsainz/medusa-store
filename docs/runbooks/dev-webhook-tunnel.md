# Runbook: webhook Mercado Pago em desenvolvimento

> Status: vigente, **incompleto** · Última verificação: 2026-09-25 · Commit: `0326748`

## Fatos

- Path permanente: `/hooks/payment/mercadopago`, no backend (porta `9000` em dev).
- O Mercado Pago precisa alcançar uma URL pública, então em desenvolvimento é usado um túnel para o backend local.
- O host do túnel é temporário e muda. **Nunca** gravar esse host em código, `.env.template` ou documentação.
- A cada troca de host, a URL de notificação é configurada **manualmente** no painel do Mercado Pago (regra do [CLAUDE.md](../../CLAUDE.md)).
- O backend precisa de `MERCADOPAGO_WEBHOOK_SECRET`, a assinatura secreta da aplicação no painel. Sem ela, notificações do Mercado Pago com `data.id` e headers presentes recebem 500.
- O provider só processa notificações com `type === 'order'` (Orders API).

## Passos

1. Subir o backend (`pnpm run backend:dev`).
2. Abrir um túnel público para `localhost:9000`.
3. No painel do Mercado Pago, configurar a URL `https://<host-do-túnel>/hooks/payment/mercadopago` (tipo de evento: ver "A completar").
4. Conferir que o secret do painel é o mesmo de `MERCADOPAGO_WEBHOOK_SECRET` no `.env` do backend.
5. Fazer um pagamento sandbox e acompanhar os logs do backend (códigos de resposta em [../mercadopago/webhook.md](../mercadopago/webhook.md)).

## A completar

- **Ferramenta e comando do túnel:** não registrados no repositório.
- **Tipo de evento exato a marcar no painel:** [não validado].
- O plugin/MCP do Mercado Pago tem ferramentas `save_webhook` e `notifications_history` que podem substituir a configuração manual. [não validado] neste projeto.
  - Em 2026-09-29, o `notifications_history` voltou vazio mesmo logo depois de duas entregas desta aplicação confirmadas pelo inspetor do túnel ([E2E-B-2026-09-29](../investigations/E2E-B-2026-09-29.md#order-órfã-da-inv-003)). Para saber se uma notificação chegou, use o log do backend e o inspetor do túnel, não esse histórico.

## Diagnóstico rápido

| Resposta | Causa provável |
|---|---|
| 400 | Falta `?data.id=` ou os headers `x-signature`/`x-request-id` |
| 401 | Assinatura inválida (por exemplo, secret diferente do configurado no painel) |
| 500 | `MERCADOPAGO_WEBHOOK_SECRET` ou `MERCADOPAGO_ACCESS_TOKEN` ausente |
| 502 | Falha ao ler a Order no Mercado Pago (`GET /v1/orders/{id}`) |
| 503 | Order paga sem session correspondente (o MP vai tentar de novo) ou session ambígua |
