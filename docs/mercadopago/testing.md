# Testes do Mercado Pago

> Status: vigente · Última verificação: 2026-09-25 · Commit: `0326748`

## Testes unitários (backend)

```bash
cd apps/backend && pnpm run test:unit
```

Resultado em 2026-09-29, com o workflow de cancelamento que cancela o Pix antes do core ([ADR-013](../decisions/ADR-013-cancel-order-wrapper-cancels-pix-first.md)), commit `12c5ff6`: **18 suítes, 336 testes, todos passando.** Antes, com só o hook ([ADR-012](../decisions/ADR-012-cancel-pending-pix-on-order-cancel.md)): 15 suítes, 310 testes. Em `0821822`: 13 suítes, 285 testes.

| Spec (em `apps/backend/src/`) | Cobre |
|---|---|
| `modules/mercadopago/__tests__/service.unit.spec.ts` | `authorizePayment` (cartão e Pix), idempotency key da Order de cartão derivada do body (ADR-014), discriminador Pix, ciclo da cobrança Pix na Review (prepare/reuse/regenerate/invalidate), `deletePayment`, autorização depois da Review, respostas inesperadas da API, `normalizePixStatus`, `toPixPaymentDto` |
| `api/hooks/payment/[provider]/__tests__/route.unit.spec.ts` | Todo o webhook: comportamento do core, validações, HMAC, códigos de resposta, correlação, `getWebhookActionAndData` |
| `api/store/mercadopago/payment-sessions/[id]/__tests__/route.unit.spec.ts` | Allowlist, posse da session, provider, não autorização |
| `api/store/mercadopago/payment-sessions/[id]/pix/__tests__/route.unit.spec.ts` | Prepare/regenerate, session já autorizada, posse, cart completo, rejeição de sessions de cartão |
| `api/store/mercadopago/carts/[id]/pix/__tests__/route.unit.spec.ts` | Leitura ao vivo, estados terminais, fallback com o Mercado Pago fora do ar, DTO sem IDs/status nativos, janela de pagamento (antes/depois da deadline, status real mantido), 410 para cart concluído, 404, isolamento por cart |
| `api/store/mercadopago/payment-access/pix/__tests__/route.unit.spec.ts` | Leitura por capability: DTO por allowlist, order resolvida no servidor, estados (pendente, aprovado, cancelado ao vivo, deadline vencida, Mercado Pago fora do ar), 404 genérico para cada falha, token na query ignorado |
| `modules/mercadopago/__tests__/pix-access-view.unit.spec.ts` | `toPixAccessDto` por estado e deadline |
| `modules/mercadopago/__tests__/pix-cancel.unit.spec.ts` | Ação `cancel` do `updatePayment` (cancelamento do pedido): pendente cancelado com a key `sha256(<pix key>:cancel)`, pago recusado, não pagável sem cancelar, desconhecido recusado, erros da API propagados, cartão recusado (invariante 45) |
| `workflows/steps/__tests__/cancel-pending-pix-charge.unit.spec.ts` | Step compartilhado: só o Pix pendente é cancelado, uma vez, pela ação `cancel`; nada para sem session, cartão (inclusive capturado), Pix autorizado ou já cancelado; pago (corrida do #95), status desconhecido, falha no `GET` e recusa 409 relançados com o motivo; ambiguidade recusada |
| `workflows/__tests__/cancel-order-with-pending-pix.unit.spec.ts` | Workflow wrapper com o engine real, `useQueryGraphStep` e `cancelValidateOrder` reais e o core substituído por um step que registra a execução e chama o hook: sem Pix → só o core; Pix pendente → cancelado antes do core, e o hook não chama de novo; pago/falha de leitura/status desconhecido/ambiguidade → erro sem executar o core; pedido não cancelável → nem Pix nem core; cartão capturado → só o core; retry idempotente. Uma mutação (core antes do Pix) derruba 5 dos 11 testes |
| `api/admin/orders/[id]/cancel/__tests__/route.unit.spec.ts` | Rota sobrescrita: não desliga a autenticação padrão; chama o wrapper com `order_id`/`canceled_by`; responde `{ order }` com `req.queryConfig.fields`; erro do workflow propaga sem ler nem responder |
| `workflows/hooks/__tests__/order-canceled.unit.spec.ts` | Hook `orderCanceled` (rede de segurança): registro, seleção da session Pix pendente, nenhuma ação fora dela, ambiguidade recusada, erros relançados. O rollback real do workflow está nos E2E da INV-005 e da INV-006 |
| `modules/mercadopago/__tests__/refund.unit.spec.ts` | `refundPayment`: valor como `BigNumberInput`, idempotency key por reembolso, total sem body × parcial com `transactions`, recusas antes da chamada, erro da API propagado (invariantes 42–44). Mock do SDK; nenhum reembolso real |
| `modules/payment-access/__tests__/*.unit.spec.ts` | Token opaco, hash, validação, limite por session, corrida de emissões, revogação, limpeza com retenção de 7 dias (lotes, repetição) |
| `jobs/__tests__/cleanup-payment-access-grants.unit.spec.ts` | Job de limpeza: chama o workflow e registra só a quantidade |
| `workflows/payment-access/__tests__/pix-access-binding.unit.spec.ts` | Condições de emissão da capability Pix |

### Sem cobertura

- `cancelPayment`, `retrievePayment`, `getPaymentStatus`, `capturePayment`, `initiatePayment` (nenhuma menção no spec do provider).
- `refundPayment` não tem teste automatizado contra a Orders API real. O E2E manual de 2026-09-29 (cartão e Pix, total e parcial) está na [INV-004](../investigations/INV-004-refund-payment-amount-and-idempotency.md#e2e-sandbox-2026-09-29).
- Um teste que falhe se `id` for adicionado ao provider em `medusa-config.ts`.
- Testes de integração HTTP (não existem) e CI (não existe).
- No storefront só existe o teste da fronteira servidor → cliente do Pix (`apps/storefront/src/lib/util/__tests__/pix-client.test.mjs`, `pnpm test` em `apps/storefront`, `node --test` sem dependência nova; exige Node ≥ 22.12). Componentes, Server Actions e cookies não têm teste automatizado.

## Checagem de tipos

```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/storefront && npx tsc --noEmit
```

Os dois sem erros em 2026-09-27 (commit `3a56150`).

## E2E (manual, navegador)

O procedimento detalhado está na skill [.agents/skills/integration-testing/SKILL.md](../../.agents/skills/integration-testing/SKILL.md). Resumo das regras:

- Começar de sessão limpa, pela página de produto. Nunca preparar cart/session/pedido via API.
- Parar na primeira falha e registrar etapa, endpoint, status HTTP, erro, estado do cart, da session e do payment.
- Usar apenas dados sandbox oficiais do Mercado Pago. Nunca registrar cartão, CVV, tokens ou credenciais.
- O webhook real exige URL pública: [../runbooks/dev-webhook-tunnel.md](../runbooks/dev-webhook-tunnel.md).

Estado das validações E2E (cenários, pedidos e pendências): [../status.md](../status.md#evidência-e2e). Não duplicar aqui.

### Pix no sandbox

Verificado no código em `3a56150` e na documentação oficial do Mercado Pago (Checkout Transparente, Orders API, "Realizar compra de teste com Pix"), consultada via MCP em 2026-09-27.

- No sandbox, a documentação oficial só descreve uma forma de aprovar um Pix da Orders API: **criar** a Order com `payer.first_name = "APRO"`. Ela nasce `action_required/waiting_transfer` e depois é aprovada automaticamente. A documentação diz que o teste de Pix não é feito "simulando uma compra".
- ✅ **Confirmado pela [INV-003](../investigations/INV-003-pix-sandbox-approval.md)** (sandbox, 2026-09-29). Uma Order criada com o corpo exato do `createPixOrder` mais `payer.first_name = "APRO"` passou de `action_required/waiting_transfer` a `processed/accredited` sozinha, em no máximo cerca de 4 s (3,8 s pelos timestamps do Mercado Pago). O `external_reference` foi preservado. `processing_mode: automatic`, `expiration_time: PT1H`, `description` e a idempotency key não impedem a aprovação. É um gatilho do mecanismo de teste do sandbox, não um requisito de produção.
- ⚠ O webhook da aprovação da Order da INV-003 **não foi comprovado**: backend e túnel estavam desligados. Com o túnel ligado por ~45 min no total, nos E2E B' e B, nenhuma notificação dela chegou: **não comprovado** ([E2E-B-2026-09-29](../investigations/E2E-B-2026-09-29.md#order-órfã-da-inv-003)).
- Até o ADR-010, o checkout não enviava `first_name`, e **o Pix criado pelo checkout ficava em `waiting_transfer` no sandbox**. Isso foi observado em 2026-09-27 com payer `@testuser.com` e `@example.com`; o domínio do e-mail não muda o resultado.
- **Com o [ADR-010](../decisions/ADR-010-pix-payer-name-from-billing-address.md)** (implementado, testes unitários), a rota de update grava em `session.data.payer` o `first_name`/`last_name` do **endereço de cobrança** do cart, só para Pix (invariante 40). O `createPixOrder` os envia sem mudança. **Para testar a aprovação no sandbox, use `APRO` como nome no endereço de cobrança** antes de escolher o Pix. O nome só é relido quando os dados do Brick são enviados de novo; mudar o endereço depois não altera a session nem uma Order já criada.
- **E2E B' executado em 2026-09-29, resultado CONFIRMADO** ([E2E-B-PRIME-2026-09-29](../investigations/E2E-B-PRIME-2026-09-29.md)):
  - o nome de cobrança `APRO` chegou a `session.data.payer`, e a Order do checkout foi aprovada sozinha;
  - `order.action_required` e `order.processed` foram confirmados, com HMAC válido, correlação com a session exata e HTTP 200;
  - o webhook concluiu o cart;
  - a Review e a confirmação mostraram "Payment approved".
- **Critério de pagamento concluído neste caminho:**
  - session **`authorized`**, com `authorized_at`, que é o estado esperado, não `captured`;
  - exatamente 1 Payment com `captured_at`, e 1 Capture;
  - collection `completed`, com o valor capturado igual ao amount.

  Por quê: [webhook.md](webhook.md#processamento-no-provider). Não verificar a captura pelo status da session.
- **O tempo de aprovação com `APRO` varia:** ~3,8 s na INV-003, ~93 s no E2E B' e ~3,5 s no E2E B. O sandbox apresentou tempos de aprovação variáveis; a causa não foi determinada.
- **Cenário B: NÃO REPRODUZIDO** em 2026-09-29 ([E2E-B-2026-09-29](../investigations/E2E-B-2026-09-29.md)). A aprovação saiu ~3,5 s depois da criação, e o webhook concluiu o cart (#92) antes de qualquer Place order.
  - B exige concluir o cart entre o prepare e a aprovação, o que só é viável pelo navegador quando o sandbox demora, como os ~93 s do B'. Esse tempo não é controlável.
  - **B continua não validado depois do hardening.**
- O `notifications_history` do MCP voltou vazio mesmo logo depois de entregas confirmadas pelo túnel. Não usar esse histórico como evidência de envio ou de não envio.
- O "Simular" do painel de Webhooks só envia uma notificação com o `Data ID` informado; não muda o status da Order. Como o webhook lê o status em `GET /v1/orders/{id}`, simular uma Order não paga não autoriza nada.
- Uma Order criada direto na API com `APRO` não pertence a nenhuma session. Ela serve para o teste negativo de correlação (503, sem atingir a session do cart), não para os cenários B, B' e C.
- **Vencimento observado** (2026-09-27, Pix com `expiration_time: "PT1H"`): 2 min depois do prazo a Order ainda estava `pending` (display); entre ~2 e ~7 min depois passou a **`canceled`**. `expired` não foi observado como status da Order. Detalhes em [../status.md](../status.md#capability-de-pagamento-adr-007).
- Como o Pix da #76 e da #77 foi aprovado continua sem explicação [não validado]. As duas foram criadas antes do commit `c41d686`, então o código que rodava naquele momento não está no Git. Nenhum código commitado envia `first_name`.

## Checklist após mudanças no provider ou no webhook

1. `pnpm run test:unit` (backend).
2. `tsc --noEmit` no backend e no storefront; `pnpm run lint`.
3. Se a identidade do provider for tocada: `SELECT` read-only confirmando `provider_id` de `payment_session`, `payment` e `region_payment_provider`.
4. E2E de checkout novo (cartão e/ou Pix, conforme a mudança).
5. Webhook real em `/hooks/payment/mercadopago` sem `AwilixResolutionError`.
6. Se tocar em retrieve/status/refund: exercitar em pelo menos um Payment existente.
7. Admin: Mercado Pago disponível na região Brasil.
