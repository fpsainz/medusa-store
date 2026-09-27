# ADR-008: Fim da janela de pagamento do Pix esconde QR/ticket sem mudar o status do provider

> Status: aceito · Data: 2026-09-27 · Commits: `5ccd353` · A divergência da rota de capability (Consequências) foi resolvida pelo [ADR-009](ADR-009-payment-access-keeps-provider-status.md)

Marcadores de origem: [../README.md](../README.md#convenções). **[MCP 2026-09-27]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data.

## Contexto

Três informações diferentes descrevem o prazo de um Pix:

| Informação | O que é | Onde |
|---|---|---|
| `transactions.payments[].expiration_time: "PT1H"` | Data de vencimento que a loja define para o pagamento no Mercado Pago (duração ISO 8601; padrão 24 h; de 30 min a 30 dias) [MCP 2026-09-27] | `createPixOrder` ([ADR-007](ADR-007-payment-access-capability-for-pix.md)) |
| `mercadopago_pix_expires_at` | Deadline **local** e conservadora: a menor entre início da requisição + 1 h, `created_date` + 1 h e uma data absoluta válida da resposta. Nunca depois do vencimento real. | `computePixDeadline` |
| Status da Order Mercado Pago | Estado informado pelo provider (`action_required`, `canceled`, `expired`…) | leitura ao vivo / webhook |

Fatos:

- O Mercado Pago **recomenda cancelar os pagamentos não realizados dentro da data de vencimento**, "para evitar problemas de cobrança e conciliação". Só 30 dias depois do vencimento ele considera o pagamento expirado, com status "cancelado ou expirado" [MCP 2026-09-27].
- `expired` = "não foi concluída dentro do tempo limite"; `canceled` = "cancelada e não será concluída" [MCP 2026-09-27].
- A documentação não garante que o QR deixe de ser pagável exatamente no vencimento, e não há campo confirmado que diga "ainda pagável" (a data absoluta na resposta continua não confirmada; ver ADR-007).
- No sandbox (2026-09-27), 2 min depois da deadline a Order ainda estava `action_required` (display `pending`); alguns minutos depois passou a `canceled` ([status](../status.md#capability-de-pagamento-adr-007)).
- Até esta decisão, `GET /store/mercadopago/carts/:id/pix` e o prepare devolviam QR/ticket enquanto o Mercado Pago dissesse `pending`, inclusive depois da deadline; `GET /store/mercadopago/payment-access/pix` já parava de devolvê-los na deadline.

## Decisão

1. **A validade do Pix é a do Mercado Pago; a exposição do QR/ticket é política da aplicação.** A partir de `mercadopago_pix_expires_at`, `toPixPaymentDto` (Review: `carts/:id/pix` e prepare) não devolve mais `qr_code`, `qr_code_base64` nem `ticket_url`, qualquer que seja o status momentâneo do Mercado Pago.
2. **O status continua o do provider.** Não é convertido em `expired` nem `canceled`. O fim da janela é informado à parte, em `payment_window_closed: true`.
3. Com a janela fechada, a Review bloqueia "Place order" (não há dados pagáveis) e oferece "Generate new Pix", que cancela a cobrança anterior (como o Mercado Pago recomenda) e cria outra.
4. Cobranças sem `mercadopago_pix_expires_at` (anteriores ao prazo explícito) mantêm o comportamento anterior.

## Alternativas consideradas

- **A — seguir só o status do Mercado Pago:** continuaria oferecendo uma cobrança depois do vencimento configurado pela loja, contra a recomendação do Mercado Pago, e abriria corrida entre pagar o QR antigo e regenerar (dois pagamentos). Descartada.
- **C — regra baseada num campo do Mercado Pago:** nenhum campo confirmado indica que o Pix ainda é pagável, e o status atrasa em relação ao vencimento. Descartada por falta de base.
- **B com status artificial (`expired`):** misturaria a política local com o estado do provider. Descartada; usa-se o flag.

## Consequências

- Review e confirmação param de expor artefatos no mesmo instante (a deadline local).
- **Divergência que permanece:** `GET /store/mercadopago/payment-access/pix` (`toPixAccessDto`, [ADR-007](ADR-007-payment-access-capability-for-pix.md) decisão 6) ainda reporta `status: "expired"` depois da deadline quando o Mercado Pago diz `pending`. Não foi alterado aqui; alinhar exige decidir se a confirmação também deve mostrar o status real + o flag (substituindo essa parte do ADR-007).
- A deadline local nunca é tratada como status oficial do Mercado Pago.
