# ADR-013: Cancelar o Pix pendente antes do `cancelOrderWorkflow` (workflow wrapper na rota do Admin)

> Status: aceito · Data: 2026-09-29 · Commits: `12c5ff6`

Substitui o [ADR-012](ADR-012-cancel-pending-pix-on-order-cancel.md) no ponto em que o Pix é cancelado. O mecanismo de cancelamento no Mercado Pago e o hook `orderCanceled` continuam os do ADR-012. Investigação e evidências: [INV-006](../investigations/INV-006-payment-collection-rollback.md). Regras: invariantes 45 e 46 em [../mercadopago/invariants.md](../mercadopago/invariants.md). Escolha da opção C [decisão humana 2026-09-29].

## Contexto

- **Problema.** Com o ADR-012, cancelar um pedido com Pix pendente chamava o provider só no hook `orderCanceled`, o último step do `cancelOrderWorkflow` (Medusa 2.20.1). Antes do hook, o core já executou `updatePaymentCollectionStep` (collection `canceled`) e `cancelOrdersStep`.
- **Causa no core.** Quando o hook recusa (Pix pago, falha de leitura ou recusa do Mercado Pago, ambiguidade), o workflow é compensado, mas a compensation de `updatePaymentCollectionStep` falha:
  - o snapshot só guarda `{ id, status }`;
  - `amount`/`currency_code` `undefined` são recusados pelo MikroORM;
  - o workflow termina `FAILED`: pedido `pending`, collection `canceled` e `payment_status: canceled`.
- **Reprodução.** #95 (Pix pago) e #97 (Pix não pago, falha no `GET` da Order MP). No #97 a Order MP e a confirmação continuaram oferecendo o Pix ([INV-006](../investigations/INV-006-payment-collection-rollback.md#e2e-da-reprodução-pix-não-pago-sandbox-2026-09-29)).
- **Por que o hook sozinho não basta.** Ele roda tarde demais e não tem como restaurar a collection com mecanismos nativos:
  - o status anterior não chega ao hook;
  - o recálculo (`maybeUpdatePaymentCollection_`) é privado;
  - a compensation do core continuaria falhando.
- **Pontos de extensão.**
  - O `cancelOrderWorkflow` não expõe hook antes de `update-payment-collection`.
  - O único chamador em execução é `POST /admin/orders/:id/cancel` (`@medusajs/medusa`), e o Admin dashboard só usa essa rota.
  - O core exporta `cancelValidateOrder`, e `cancelOrderWorkflow.runAsStep` permite compor o workflow nativo.

## Alternativas consideradas

- **A. Pré-validação só de leitura** (middleware lê a Order MP e recusa se paga).
  - Não elimina a corrida entre a leitura e o hook, que continua cancelando tarde.
  - Uma falha de leitura dentro do hook ainda gera o estado do #97.
  - Poria regra de negócio fora de workflow. Descartada.
- **B. Hook atual** (ADR-012). Qualquer recusa passa pela compensation quebrada do core (#95, #97). Mantido só como rede de segurança.
- **Restaurar a collection no hook** (compensação do hook com `StepResponse.permanentFailure`). Exigiria copiar a regra privada de status do core, fora de qualquer transação, e o workflow continuaria `FAILED`. Descartada.
- **C. Workflow wrapper** que cancela o Pix antes do core. **Escolhida.**

## Decisão

1. **Workflow `cancel-order-with-pending-pix`** (`src/workflows/cancel-order-with-pending-pix.ts`), em sequência:
   1. `useQueryGraphStep` (`get-order-to-cancel`: `id`, `status`, `fulfillments.canceled_at`);
   2. `cancelValidateOrder` (nativo; mesma validação do core);
   3. `cancel-pending-pix-charge`;
   4. `cancelOrderWorkflow.runAsStep({ input })`.

   Ele não reimplementa o cancelamento de pedido. A leitura do passo 1 é necessária porque o core só lê o pedido dentro do próprio workflow, depois de o wrapper decidir.
2. **Step `cancel-pending-pix-charge`** (`src/workflows/steps/cancel-pending-pix-charge.ts`, `cancelPendingPixChargeForOrder`):
   - Seleção da session e ação: as mesmas do ADR-012 (itens 2 a 7). Só Pix `pp_mercadopago` + `pending_authorization` + `mercadopago_order_id`; mais de uma → `NOT_ALLOWED`; `updatePaymentSession` com a ação `cancel` → provider → `invalidatePixOrder`.
   - Nenhum `POST /cancel` fora do provider.
   - Sem Pix pendente → nada.
   - Qualquer erro é relançado com o motivo.
3. **Hook `orderCanceled`**: continua registrado e chama a mesma função. É a rede de segurança para chamadas diretas ao `cancelOrderWorkflow`. Na rota do Admin, a session já está `canceled` quando o hook roda, então ele não age.
4. **Rota do Admin**: `src/api/admin/orders/[id]/cancel/route.ts` sobrescreve a do core [core 2.20.1]:
   - `ApiLoader` registra `@medusajs/medusa/dist/api` antes do `src/` do projeto (`getResolvedPlugins` põe o projeto por último);
   - `RoutesLoader.registerRoute` indexa por `matcher` + método, e o último registro vence.

   Autenticação (`/admin`: bearer, session, api-key), `validateAndTransformQuery` (`req.queryConfig`) e `policies` do core ficam presos ao caminho, não ao arquivo da rota, e continuam valendo. Request e response são os do core: `{ order }` com os campos de `req.queryConfig`, e erros pelo error handler do Medusa. Precedente no projeto: o webhook (`api/hooks/payment/[provider]/route.ts`).
5. **Provider**: sem mudança de lógica; só comentários citam o novo chamador da ação `cancel`.

## Não-atomicidade com o Mercado Pago

O cancelamento no Mercado Pago é externo e irreversível, então o step `cancel-pending-pix-charge` não tem compensação:

| Situação | Resultado |
|---|---|
| Pedido não cancelável (core) | nada é tocado; o Pix não é lido |
| Leitura ou cancelamento do Pix falha, ambiguidade, status desconhecido | erro ao chamador; o core não roda (collection e pedido intactos) |
| Pix já pago (webhook ainda não processado) | `NOT_ALLOWED`; o core não roda; o Pix continua pago e o reembolso fica para depois do processamento do pagamento |
| Sem Pix pendente (cartão, sem pagamento, Pix autorizado ou já cancelado) | só o core (reembolso de Payment capturado pelo core) |
| Pix cancelado e depois o core falha | o Pix continua cancelado (não se tenta "descancelar"), e o pedido segue ativo sem cobrança pagável; um novo cancelamento não encontra Pix pendente e só roda o core. Se a falha do core for depois de `update-payment-collection`, o defeito de compensation do Medusa 2.20.1 continua valendo (fora do escopo) |

## Consequências

- **#97 corrigido pela ordem das operações.** Ao ler o Pix antes do core, a falha acontece antes de `update-payment-collection`; a collection nunca chega a `canceled`. E2E sandbox de 2026-09-29, pela rota real ([INV-006](../investigations/INV-006-payment-collection-rollback.md#e2e-da-correção-sandbox-2026-09-29)):
  - A (#98): Pix cancelado antes do core; tudo `canceled`.
  - B (#99, Pix pago): 400, core não executado, collection `awaiting`.
  - C (#100, `GET` 403): 500, collection `awaiting`, `payment_status: awaiting`; retry concluído.
  - D (#101, cartão capturado): só o reembolso nativo.
  - Nenhuma chamada duplicada ao Mercado Pago.
- Um cancelamento pode falhar por indisponibilidade do Mercado Pago; o pedido continua ativo e consistente, e o erro chega ao Admin.
- Uma chamada direta ao `cancelOrderWorkflow` (nenhuma hoje) continua protegida só pelo hook, com o comportamento e o risco do ADR-012.
- A rota sobrescrita precisa acompanhar mudanças da rota do core em upgrades do Medusa.
