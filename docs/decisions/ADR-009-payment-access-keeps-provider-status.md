# ADR-009: A leitura por capability mantém o status do provider e sinaliza a janela à parte

> Status: aceito · Data: 2026-09-27 · Commits: o commit que adiciona este arquivo (`git log --diff-filter=A -- docs/decisions/ADR-009-payment-access-keeps-provider-status.md`) · Substitui a regra de status da decisão 6 do [ADR-007](ADR-007-payment-access-capability-for-pix.md)

## Contexto

- O [ADR-008](ADR-008-pix-payment-window-hides-artifacts.md) separou a validade do Pix no Mercado Pago (`expiration_time`), a deadline local (`mercadopago_pix_expires_at`, política de exposição) e o status do provider. Na Review, a deadline passou a esconder QR/ticket sem alterar o status (`payment_window_closed`).
- A decisão 6 do [ADR-007](ADR-007-payment-access-capability-for-pix.md) fazia `GET /store/mercadopago/payment-access/pix` (`toPixAccessDto`) devolver `status: "expired"` depois da deadline, mesmo com o Mercado Pago ainda em `action_required` (display `pending`). Isso foi observado no E2E de 2026-09-27 ([status](../status.md#capability-de-pagamento-adr-007)): a deadline local virava status.
- Pedido de alinhamento [decisão humana 2026-09-27].

## Decisão

1. `status` na leitura por capability é sempre o status derivado do provider (`toPixPaymentDto`): nunca reescrito por causa da deadline local.
2. `payment_window_closed: boolean` está sempre presente: `true` quando a deadline armazenada passou ou não existe.
3. Com `payment_window_closed: true`, nenhum artefato pagável é devolvido (`qr_code`, `qr_code_base64`, `ticket_url`, `charge_ref`, `expires_at`), qualquer que seja o status. Artefatos só com `status: "pending"` e janela aberta.
4. A expiração da capability (deadline + 15 min), o limite de 3 por session, `PT1H` e o fluxo de `carts/:id/pix` não mudam.
5. A confirmação do pedido decide a exibição por `status` + `payment_window_closed`: `pending` + aberta → Pix disponível; `pending`/`processing` + fechada → "prazo encerrado", sem QR/ticket; `canceled` → Pix cancelado; `approved` (inclui `processed`) → pagamento aprovado.

## Alternativas consideradas

- **Manter `expired` artificial:** misturava política local com estado do provider, contra o ADR-008. Descartada.
- **Omitir o flag quando a janela está aberta** (como na Review): o contrato da capability é consumido pelo Next Server e se beneficia de um booleano sempre presente. A Review mantém o formato do ADR-008.

## Consequências

- Review e confirmação usam a mesma separação: status real + janela da aplicação.
- **Não implementado:** oferecer um novo Pix na confirmação quando a janela fecha sem pagamento. Depois da conclusão do cart não existe caminho para gerar outra cobrança (o prepare recusa cart concluído, e a confirmação não tem capability de cart). Exige decisão própria.
