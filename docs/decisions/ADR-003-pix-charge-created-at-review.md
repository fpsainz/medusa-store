# ADR-003: Cobrança Pix criada na etapa Review

> Status: aceito · Data: 2026-09-25 · Commits: `81f5caf` (versão anterior), `c41d686` (esta decisão), `0326748` (endurecimento)

## Contexto

Na primeira versão do Pix (`81f5caf`), a Order Pix era criada em `authorizePayment`, isto é, durante o `completeCart` disparado pelo "Place order". O comprador só via o QR depois de fechar o pedido.

## Decisão

A partir de `c41d686`:

- A cobrança Pix é preparada **na etapa Review, antes do "Place order"**, pela rota `POST /store/mercadopago/payment-sessions/:id/pix`, que passa `mercadopago_pix_action` para `updatePayment` → `preparePixOrder`.
- A preparação é idempotente: reutiliza a Order enquanto está pagável e com o mesmo valor; `regenerate` substitui uma Order não paga.
- A preparação nunca autoriza a session. A autorização continua sendo feita só por `authorizePayment` (`completeCart`) ou pelo webhook.
- O "Place order" do Pix só é liberado com a cobrança pagável (`pending` com QR/copia-e-cola/ticket) ou já paga.
- `authorizePayment` mantém a criação da Order como fallback quando a session não tem `mercadopago_order_id`.

## Alternativas consideradas

- Criar a Order no `completeCart` (versão `81f5caf`), abandonada nesta decisão. O motivo não está registrado no commit. [não validado]

## Consequências

- Surgiram as rotas `carts/[id]/pix` (polling) e `orders/[id]/pix` e o `PixPaymentPanel` na Review.
- Uma Order Pix pode existir sem pedido Medusa. Por isso `updatePayment` (troca de método) e `deletePayment` cancelam Orders pendentes (invariante 8).
- O comentário de `MercadoPagoPaymentButton` (`payment-button/index.tsx`) ficou desatualizado após esta decisão e foi corrigido em 2026-09-25.
