# INV-003: aprovação de Pix da Orders API no sandbox

> Status: concluída · Aberta em: 2026-09-29 · Concluída em: 2026-09-29 · Commit: `a4aae37`

Marcadores de origem: [../README.md](../README.md#convenções). **[MCP 2026-09-29]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data. **[sandbox 2026-09-29]** indica resultado observado na Orders API sandbox nesta investigação.

## Achado

Os cenários B e B' ([status](../status.md#matriz-de-evidências)) exigem um Pix criado pelo checkout e pago no sandbox. Os Pix criados pelo checkout ficam em `action_required/waiting_transfer` até vencer ([testing.md](../mercadopago/testing.md#pix-no-sandbox)). Faltava separar um limite do sandbox de um defeito do nosso fluxo.

## Fatos (antes do experimento)

- A documentação do teste de Pix da Orders API manda criar a Order com `payer.first_name = "APRO"`: ela nasce `action_required` e "em seguida" é aprovada automaticamente. O teste é feito "por meio de uma requisição, e não simulando uma compra" [MCP 2026-09-29].
- No Brasil, o Payment Brick só pré-preenche `payer.email` no Pix [MCP 2026-09-29].
- O checkout não envia `first_name`. O storefront manda só `email` + `identification` (`mercadopago-payment-container/index.tsx`), a rota de update reduz `payer` a esses campos (`sanitizePayer`, invariante 2), e `createPixOrder` envia o `payer` da session sem alteração.

## Hipótese

Uma Order Pix criada na Orders API com o **mesmo corpo** que `createPixOrder` produz, mais `payer.first_name = "APRO"`, é aprovada automaticamente pelo sandbox.

## Método

- **Script isolado** fora do repositório, com o mesmo SDK do backend (`mercadopago` 3.6.1, `Order.create`/`Order.get`) e o mesmo access token de teste do backend. O token não foi impresso nem registrado.
- **Uma única criação.** Depois, consultas por `GET /v1/orders/{id}` em +10, 20, 30, 45 e 60 s e então a cada 60 s até 15 min, parando no primeiro status terminal.
- **Nada no Medusa:** sem Cart, Payment Session, Payment nem Order no Medusa e sem escrita no banco. Nenhum arquivo do projeto, configuração ou `.env` foi alterado.
- **Webhook sem endpoint:** backend e túnel estavam desligados. Não foram ligados, porque isso exigiria reconfigurar o host no painel do Mercado Pago.

### Payload

Mesmo corpo de `createPixOrder` (`service.ts`, commit `a4aae37`). Os valores que o checkout tira do cart foram trocados por valores fictícios, e só `payer.first_name` foi acrescentado:

```json
{
  "type": "online",
  "external_reference": "INV-003-1790683119522",
  "total_amount": "50.00",
  "currency": "BRL",
  "processing_mode": "automatic",
  "description": "Medusa cart INV-003-1790683119522",
  "payer": { "email": "<e-mail fictício @testuser.com>", "first_name": "APRO" },
  "transactions": { "payments": [{
    "amount": "50.00",
    "payment_method": { "id": "pix", "type": "bank_transfer" },
    "expiration_time": "PT1H"
  }]}
}
```

- **Header:** `X-Idempotency-Key` com SHA-256 hex, no formato de `getPixIdempotencyKey` (geração 0).
- **`payer`:** o checkout Pix grava hoje só o `email`, porque o Brick não devolve `identification` no Pix. O experimento manteve esse formato.

## Resultado [sandbox 2026-09-29]

| | Valor |
|---|---|
| Criação | HTTP 201 |
| Order ID | `ORDTST01M3PGG6E3JDZAMFAHE2ZNN0GV` |
| Payment ID | `PAY01M3PGG6EHH0P0VBNKB11D4J6E` (`reference_id` `000g746r9z`) |
| `external_reference` | `INV-003-1790683119522` na criação e na consulta, idêntico ao enviado |
| `processing_mode` / `capture_mode` | `automatic` / `automatic_async` |
| Estado na criação | Order `action_required/waiting_transfer`; payment `action_required/waiting_transfer`; QR, QR base64 e `ticket_url` (sandbox) presentes; `date_of_expiration` = `created_date` + 1 h |
| Estado na 1ª consulta (+10 s) | Order `processed/accredited`; payment `processed/accredited`; `paid_amount` `50.00`; QR e ticket ausentes da resposta |
| Tempo até a aprovação | No máximo cerca de 3,8 s: `created_date` 11:58:46.225Z → `last_updated_date` 11:58:50.058Z (relógio do Mercado Pago). Pelo relógio local, antes da 1ª consulta, uns 10,5 s depois do início da requisição. |
| Estados intermediários | Nenhum observado; a 1ª consulta já veio com o estado final |

O relógio local estava pelo menos cerca de 4,7 s atrás do Mercado Pago: a resposta da criação chegou localmente às 11:58:41.531Z, e o `created_date` informado é 11:58:46.225Z. Por isso os tempos acima usam só timestamps do Mercado Pago.

## Webhook

**Não comprovado.** Backend e túnel estavam desligados, e o `notifications_history` do MCP voltou vazio. O vazio não serve como evidência de ausência de envio: webhooks reais desse ambiente foram recebidos em 2026-09-27. Continuam sem resposta: se a aprovação gera `order.processed`, com qual payload, e como o nosso endpoint responde.

## Conclusão

**Hipótese confirmada.** Com o corpo real do `createPixOrder`, `payer.first_name = "APRO"` é suficiente para o sandbox aprovar o Pix automaticamente. `processing_mode: automatic`, `expiration_time: PT1H`, `description` e a idempotency key não impedem a aprovação.

O Pix do checkout não é aprovado no sandbox porque o fluxo não envia o gatilho de teste. Isso não tem relação com a correlação, o webhook nem a criação da Order.

O resultado vale **só para o mecanismo de teste do sandbox**. Ele não mostra que o Mercado Pago exige nome do pagador para aprovar Pix em produção. Nas páginas consultadas, `first_name`/`last_name` aparecem como opcionais [MCP 2026-09-29].

O estado final `processed/accredited` é o que o código trata como pago: `getStatusFromGateway` → `captured`, `isPaidOrder` → true e `normalizePixStatus` → `approved`. Isso foi conferido no código, não num webhook real.

## Limitações

- Uma única amostra; o tempo de aprovação pode variar.
- Order sem cart e sem session: os cenários B e B' não foram exercitados.
- Webhook não observado.
- A Order ficou `processed` no sandbox. Se uma notificação dela chegar a um backend ligado, a resposta esperada é 503 ("paid order … has no payment session holding it", invariante 20), e o Mercado Pago tende a reenviar. Esse comportamento já foi validado no teste negativo de 2026-09-27.

## Implicações para os cenários B e B'

- **B'** (webhook aprova com o usuário na Review → Place order) passa a ser o cenário natural: com aprovação em segundos, a cobrança criada no prepare fica paga antes de o usuário agir.
- **B** (Place order com Pix pendente → webhook depois) fica difícil de reproduzir com `APRO`: exigiria concluir o cart nos segundos entre o prepare e a aprovação.
- Nos dois casos, o checkout só envia o gatilho se o nome do pagador chegar à Order: [ADR-010](../decisions/ADR-010-pix-payer-name-from-billing-address.md) (aceito).

## Destino

ADR-010 (aceito) e atualização de [testing.md](../mercadopago/testing.md#pix-no-sandbox) e [status.md](../status.md). Nenhuma mudança de código nesta investigação.
