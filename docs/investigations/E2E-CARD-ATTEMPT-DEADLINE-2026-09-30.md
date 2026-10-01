# E2E-CARD-ATTEMPT-DEADLINE-2026-09-30: tentativa de cartão depois do prazo (ADR-016)

> Status: registro histórico (concluído, 4 de 4 aprovados) · Executado em: 2026-09-30/2026-10-01 · Commit do código: working tree sobre `e822f52`, publicado depois em `a92d307` [commit `a92d307`]

Registro de execução, fora da numeração `INV`, da decisão [ADR-016](../decisions/ADR-016-card-attempt-deadline-is-retention-not-lifecycle.md). Conteúdo movido de [../status.md](../status.md) em 2026-10-01, sem alteração de texto (só níveis de título e links relativos); a versão anterior está em `git show bdefe51:docs/status.md`.

Evidência obtida com o Medusa **2.20.1**. O baseline atual é o 2.21.2; esta execução **não foi repetida** nele (diferenças do core: [INV-010](INV-010-medusa-2-21-2-upgrade.md)).

Marcadores de origem: [../README.md](../README.md#convenções).

## Execução

- **E2E [sandbox 2026-09-30/2026-10-01]**, com túnel desligado e backdate autorizado só de `created_at` das tentativas de teste (Q de 30 min esperado em tempo real):
  - **1, Order paga: aprovado.** Resposta do `POST` descartada → `unknown`; depois do prazo, busca exata + `GET`, **0 `POST`**, tentativa `resolved` com a mesma Order, token destruído, pedido #132 com 1 Payment e 1 Capture;
  - **1b, webhook tardio: aprovado.** A reentrega da mesma Order (túnel religado, mesmo host) não criou Payment nem pedido novo;
  - **2a, Order `failed`: aprovado.** Busca + `GET` (Order `failed/failed`), 0 `POST`, regra 9, token destruído; a Payment Session fica `error`;
  - **2b, novo pagamento: aprovado.** `initiatePaymentSession` pela Store API (js-sdk do storefront) → session antiga `error` removida pelo core (`deletePayment` sem erro) → nova session `pending` → novo Brick → nova tentativa → 1 `POST` com chave e body novos → pedido #136 com 1 Payment e 1 Capture. A falha da primeira execução do 2b ("Payment sessions are required to complete cart") era do harness, que reutilizou a session `error`; resolvida com a nova Payment Session (ADR-016, seção 4.3).
- **Dados de teste** [banco 2026-10-01]: carts dos E2E concluídos (#132, #136) ou abandonados; a tentativa `mpca_01M3T3VGSSAHGT3N0AWF58QXMJ` (primeira execução, túnel ligado) continua `unknown` com a Order associada pelo webhook; a `mpca_01M3T66855B5663NQM9XZEQCBA` continua `submitted` numa session `error`.
