# E2E-CANCEL-PAYMENT-2026-09-30: `cancelPayment` do cartão por chamada direta ao provider

> Status: registro histórico (concluído) · Executado em: 2026-09-30 · Commit do código: `6f5acdd`

Registro de execução, fora da numeração `INV`. Conteúdo movido de [../status.md](../status.md) em 2026-10-01, sem alteração de texto (só níveis de título e links relativos); a versão anterior está em `git show bdefe51:docs/status.md`.

Evidência obtida com o Medusa **2.20.1**. O baseline atual é o 2.21.2; esta execução **não foi repetida** nele (diferenças do core: [INV-010](INV-010-medusa-2-21-2-upgrade.md)).

Marcadores de origem: [../README.md](../README.md#convenções). Testes unitários de `cancelPayment`: `cancel-payment.unit.spec.ts`, publicados em `d3e3cd2` [commit `d3e3cd2`] (invariante 48).

## Execução

Fonte: script `medusa exec` fora do repositório, código em `6f5acdd` [sandbox 2026-09-30] [banco 2026-09-30]. É separado do cancelamento do pedido (INV-006): aqui foi chamado **só o método `cancelPayment` do provider**, pelo mesmo ponto que o core usa (`paymentProviderService_.cancelPayment("pp_mercadopago", { data, context })`, chamado por `paymentModule.cancelPayment` e pelo fallback de `authorizePaymentSession`).

- **Operação cancelável:** o checkout nunca cria uma Order de cartão cancelável. A Order do #124, criada pelo provider, tem `capture_mode: automatic_async` e já nasce `processed`. A documentação oficial só permite cancelar Orders ainda não processadas (reserva com `capture_mode: "manual"`, `action_required/waiting_capture`) [MCP 2026-09-30]. Por isso a Order foi criada direto na API: `ORDTST01M3SFB4YQ442PWF8PZHNKH0WR`, Visa `APRO`, R$ 50, `capture_mode: manual`, `external_reference` sem cart. Ela nasceu `action_required/waiting_capture`.
- **Entrada:** `data` no formato de `payment.data`, com `mercadopago_order_id` e `mercadopago_idempotency_key` (a key base). Num pagamento real, essa key é o ID da session: conferido no #127. `context.idempotency_key` recebeu um ID de payment, como faz `paymentModule.cancelPayment`.
- **Operação enviada:** `POST /v1/orders/{id}/cancel`, sem body → **200 `canceled/canceled`**.
- **Idempotency key:** exatamente `data.mercadopago_idempotency_key`, a key base, **sem derivação**. `context.idempotency_key` foi ignorada.
- **Repetição com a mesma entrada:** o mesmo `POST` com a mesma key → 200 `canceled/canceled`. Nenhum segundo cancelamento.
- **Mercado Pago:** Order `canceled/canceled`, payment `canceled/canceled_transaction`, nenhuma captura, nenhum reembolso.
- **Medusa:** nenhum `payment`, `payment_session` ou `mercadopago_card_attempt` referencia a Order. A chamada direta não persiste nada (quem grava `canceled_at` é `paymentModule.cancelPayment`, que não foi usado porque não há Payment de cartão não capturado).
- **Limite:** o caminho real do core até o `cancelPayment` do cartão não foi exercitado. O `cancelPaymentStep` do `cancelOrderWorkflow` só recebe Payments não capturados, e o cartão é sempre capturado na autorização. O fallback de `authorizePaymentSession` só roda depois de uma autorização bem-sucedida seguida de falha na gravação, e aí a Order já está `processed` (não cancelável) [core 2.20.1].
