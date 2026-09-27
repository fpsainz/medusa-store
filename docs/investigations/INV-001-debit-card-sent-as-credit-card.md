# INV-001: Débito enviado à Orders API como `credit_card`

> Status: causa confirmada · correção implementada (seção 11, [ADR-005](../decisions/ADR-005-card-payment-type-from-brick.md); commitada em `3a56150`) · crédito validado · débito não validável no sandbox · Aberta em: 2026-09-25 · Commit: `0326748`

## Achado

O Payment Brick oferece cartão de débito, mas o provider sempre cria a Order com `payment_method.type: 'credit_card'`.

## Fatos (verificados no código)

- `mercadopago-payment-container/index.tsx` configura o Brick com `paymentMethods.debitCard: "all"` (além de `creditCard` e `bankTransfer`).
- No `onSubmit`, o storefront envia `card_token`, `payment_method_id`, `issuer_id`, `installments`, `transaction_amount`, `amount`, `currency_code`, `cart_id` e `payer`. **Não envia** nenhum campo que diga se o cartão é de crédito ou de débito.
- A allowlist de `POST /store/mercadopago/payment-sessions/:id` (`buildAllowedSessionData`) também não aceita esse tipo de campo.
- `authorizePayment` (`service.ts`, caminho de cartão) monta `payment_method: { id: paymentMethodId, token: cardToken, type: 'credit_card', installments }`, com `type` fixo.
- Nenhum teste unitário cobre pagamento com cartão de débito.

Consequência: mesmo que o valor correto do `type` fosse conhecido, o backend hoje não recebe a informação necessária para escolhê-lo.

## Hipóteses (não validadas)

- H1: a Orders API rejeita ou trata de forma errada um pagamento de débito enviado com `type: 'credit_card'`.
- H2: a Orders API deduz o tipo pelo `payment_method_id`/token e ignora a divergência, e o fluxo de débito funciona apesar do valor fixo.
- H3: nenhum pagamento de débito passou pelo fluxo até agora, e por isso o problema nunca apareceu.

## Perguntas em aberto

1. Quais valores de `payment_method.type` a Orders API aceita para cartões, e qual corresponde a débito? Responder com a documentação oficial do Mercado Pago, não com memória.
2. Qual campo do `formData` (ou do `selectedPaymentMethod`) do Payment Brick (`@mercadopago/sdk-react` 1.0.7) indica crédito ou débito? Verificar na documentação e nos tipos instalados.
3. Existem sessions no banco com `payment_method_id` de débito? Responder com uma consulta read-only e registrar o resultado neste documento, sem contagens nos documentos de arquitetura.

## Plano de validação

1. Responder às perguntas 1 e 2 com fontes oficiais (documentação do Mercado Pago ou MCP `search_documentation`) e com os tipos em `node_modules`.
2. Responder à pergunta 3 com uma consulta read-only.
3. Fazer um E2E sandbox com um cartão de débito de teste oficial, seguindo [../mercadopago/testing.md](../mercadopago/testing.md): observar a resposta da Orders API, o status da session e o do payment. Parar na primeira falha.
4. Registrar as evidências na seção "Resultado".

## Critério de decisão

- H2 confirmada, sem efeito observável → registrar como "sem ação", ou apenas documentar o comportamento.
- H1 confirmada → decisão de correção, com um ADR se mudar o contrato storefront → backend (novo campo na allowlist). Depois, teste unitário e ajuste de código.
- Sem como validar em sandbox → manter aberta e não alterar o código.

## Resultado

> Atualizado em 2026-09-27 · Commit do código revisado: `0326748`

**Conclusão: o comportamento atual está incorreto para débito e precisa distinguir crédito de débito.** A documentação oficial e o E2E de 2026-09-27 confirmam isso (seções 5 e 6). A seção 7 explica a recusa do cartão de débito pelo Brick. As decisões da seção 10 foram tomadas, e a correção está na seção 11.

### 1. Fluxo real atual (verificado no código)

```text
Payment Brick (<Payment>, @mercadopago/sdk-react 1.0.7)
  onSubmit(param, additionalData?)
  → o container lê só param.formData; ignora param.paymentType,
    param.selectedPaymentMethod e o 2º argumento (additionalData)
  → payload cartão: card_token, payment_method_id, issuer_id, installments,
    transaction_amount, amount, currency_code, cart_id, payer
→ POST /store/mercadopago/payment-sessions/:id
  → buildAllowedSessionData (allowlist) → updatePaymentSession → updatePayment
→ PaymentSession.data (sem nenhum campo de tipo de cartão)
→ Place order → completeCart → authorizePayment (caminho de cartão)
→ Order.create (SDK mercadopago 3.6.1) → POST /v1/orders
```

### 2. Campo que distingue crédito e débito

O `formData` do cartão (`ICardPaymentFormData`) **não** tem campo de tipo: só `token`, `issuer_id`, `payment_method_id`, `transaction_amount`, `installments`, `payer`, `payment_method_option_id?`, `processing_mode?`.

O Brick informa o tipo **fora** do `formData`, e há três candidatos:

| Onde | Tipos instalados (`sdk-react` 1.0.7, `esm/bricks/payment/type.d.ts`) | Doc técnica do SDK JS (`docs/bricks/payment-guest.md`) |
|---|---|---|
| 1º argumento, `paymentType` | `'creditCard' \| 'debitCard' \| …` | não documentado |
| 1º argumento, `selectedPaymentMethod` | `'creditCard' \| 'debitCard' \| …` | `'credit_card' \| 'debit_card' \| …` |
| 2º argumento, `additionalData.paymentTypeId` | `string` opcional ("Payment Type Id associated with the payment method") | `string` |

- **As fontes divergem no formato** (`debitCard` × `debit_card`). **Runtime observado no E2E (crédito):** os três campos vieram como a string `"credit_card"` (snake_case). Os tipos TypeScript do `sdk-react` 1.0.7 estão errados quanto ao formato. O valor para débito não pôde ser observado (seção 5).
- O exemplo oficial Orders API + Card Brick (item 4 abaixo) usa `type: additionalData.paymentTypeId`.
- Nenhum dos três chega ao backend hoje: o container não os lê, e a allowlist não aceitaria esses campos.
- Derivar o tipo pelo `payment_method_id`: para esta conta, os ids de débito são diferentes dos de crédito (`debelo` × `elo`; seção 5). A Orders API valida `id` contra `type`.

### 3. Payload real enviado ao Mercado Pago

`Order.create` do SDK 3.6.1 faz `POST /v1/orders` com `JSON.stringify(body)`, sem transformar o conteúdo (`dist/clients/order/create/index.js`). Logo, o JSON final é o que `authorizePayment` monta:

```text
transactions.payments[0].payment_method = {
  id:           <payment_method_id vindo do Brick>,
  token:        <card_token>,
  type:         "credit_card"      ← fixo, para crédito e débito
  installments: <installments>
}
```

Nos tipos do SDK, o `PaymentMethodRequest.type` é `string` opcional, documentado como "e.g. `credit_card`, `debit_card`, `ticket`". O SDK não restringe nem corrige o valor.

### 4. Evidência da documentação oficial

Mercado Pago Developers, "Cartões", Checkout Transparente via Orders API (`/developers/pt/docs/checkout-api-orders/payment-integration/cards`), consultado via MCP `search_documentation` em 2026-09-27. Tabela de parâmetros:

> `transaction.payments.payment_method.type` — *Body. String* — "Tipo de meio de pagamento. Para pagamentos com cartão de crédito, deve ser `credit_card`, e para pagamentos com cartão de débito, deve ser `debit_card`." — **Obrigatório**

O exemplo do Card Payment Brick na mesma página faz `type: additionalData.paymentTypeId`, e o exemplo alternativo comenta `type: "credit_card", // deve ser "credit_card" ou "debit_card"`.

As páginas de envio do Payment Brick (`/checkout-bricks/payment-brick/payment-submission/cards`) usam a **Payments API** (`/v1/payments`), que não tem `payment_method.type`. Não se aplicam a este projeto, que usa a Orders API ([ADR-002](../decisions/ADR-002-orders-api-automatic-capture.md)).

### Por que o código usa `credit_card`

Não há registro no código nem no Git. O valor está fixo desde a introdução do provider [commit `92d16ec`]. Não há evidência de que tenha sido uma decisão.


### 5. Evidência E2E (sandbox, 2026-09-27)

**Como foi executado:** o checkout real (`/br/store` → produto → cart → endereço → entrega → Brick → Review → Place order) rodou no Chromium com um script de teste fora do repositório. Os argumentos do `onSubmit` foram capturados por um wrapper injetado no navegador, que embrulha o `onSubmit` do Brick, registra os argumentos e depois os repassa sem alteração. O corpo do `POST /v1/orders` foi capturado por um preload de `fetch` carregado só no processo de teste (`NODE_OPTIONS=--require`). **Nenhum arquivo do repositório foi alterado.** A Payment Session foi lida com uma consulta read-only, e a Order do Mercado Pago, com `GET /v1/orders/{id}`.

Cartões de teste: os oficiais do MLB (página "Cartões de teste" do Mercado Pago, consultada em 2026-09-27), Visa crédito e Elo débito. Números não registrados.

**Brick nesta conta (sandbox MLB):** com `creditCard: "all"`, `debitCard: "all"` e `bankTransfer: "all"`, o Brick oferece apenas **"Cartão de crédito"**, **"Cartão de Débito Virtual CAIXA"** e **Pix**.

#### Crédito (Visa): fluxo completo, Order Medusa #79

```text
Brick onSubmit: 2 argumentos
  param keys: paymentType, selectedPaymentMethod, formData
  paymentType                  = "credit_card"   (string)
  selectedPaymentMethod        = "credit_card"   (string)
  additionalData.paymentTypeId = "credit_card"   (string; additionalData keys: bin, lastFourDigits, cardholderName, paymentTypeId)
  formData keys: token, issuer_id, payment_method_id ("visa"), transaction_amount, installments, payer (sem campo de tipo)
→ POST /store/mercadopago/payment-sessions/:id → 200 (chamada pelo servidor Next, não pelo navegador)
→ Payment Session: nenhuma chave com "type" em data; payment_method_id = "visa"
→ POST /v1/orders: payment_method = { id: "visa", type: "credit_card", installments: 1 } → HTTP 201
→ Mercado Pago: order processed / accredited; payment processed / accredited; payment_method.type = "credit_card"
→ Medusa: session authorized; Payment capturado; Order #79 criada
```

#### Débito (Elo débito oficial): não chega ao `onSubmit`

- O Mercado Pago classifica o BIN do cartão oficial "Elo Débito" como `payment_method_id: "elo"`, `payment_type_id: "prepaid_card"` (resposta de `payment_methods/search`), e não como débito.
- No formulário "Cartão de Débito Virtual CAIXA" e no de crédito, o Brick recusa o cartão com `payment_method_not_in_allowed_types`. O pré-pago não está habilitado na customização atual.
- Consequência: o `onSubmit` não é chamado, e nada chega ao backend ou à Orders API. **O valor de runtime do Brick para débito não pôde ser observado** com os cartões de teste oficiais.

#### Meios de cartão aceitos pela conta (`GET /v1/payment_methods`, leitura)

| `payment_type_id` | ids |
|---|---|
| `credit_card` | `amex`, `elo`, `master`, `mp_card`, `visa` |
| `debit_card` | `debelo` (Elo Débito) |
| `prepaid_card` | `elo`, `master`, `visa` |

#### Experimento direto na Orders API (sandbox, fora da aplicação)

Os cartões de teste foram tokenizados via `POST /v1/card_tokens` e depois usados em `POST /v1/orders`, com `processing_mode: automatic`:

| Token | `payment_method.id` | `type` enviado | Resultado |
|---|---|---|---|
| Visa crédito | `visa` | `credit_card` | 201, processed / accredited |
| Visa crédito | `visa` | `debit_card` | **400** `property_value`: "payment_method.id value must be 'debelo'" |
| Elo débito oficial (pré-pago) | `elo` | `credit_card` | 201, processed / accredited, cobrado como `credit_card` |
| Elo débito oficial (pré-pago) | `elo` | `debit_card` | **400**: "value must be 'debelo'" |
| Elo débito oficial (pré-pago) | `elo` | `prepaid_card` | **400** `unsupported_properties`: `installments` não é permitido |
| Elo débito oficial (pré-pago) | `debelo` | `credit_card` | **400** `property_value`: "id must be one of 'amex', 'elo', 'diners', 'hipercard', 'master', 'visa'" |
| Elo débito oficial (pré-pago) | `debelo` | `debit_card` | **400** `payment_method_not_allowed_for_collector` |

### 6. Conclusão

| Caso | Resultado |
|---|---|
| **A**: o Brick fornece um campo confiável | **Sim, para crédito.** `paymentType`, `selectedPaymentMethod` e `additionalData.paymentTypeId` trazem `"credit_card"`. Para débito, não foi observado. |
| **B**: divergência entre tipos/SDK/documentação e runtime | **Sim.** Os tipos do `sdk-react` 1.0.7 dizem `'creditCard'`; o runtime e a doc do SDK JS dizem `"credit_card"`. |
| **C**: o Mercado Pago tolera o `credit_card` incorreto | **Só quando o `id` é de crédito.** O cartão classificado como pré-pago foi cobrado como crédito com `id: elo`. A API não confere o `type` contra o BIN, e sim contra o `id`. |
| **D**: o Mercado Pago rejeita o débito | **Sim, na validação do esquema.** Um débito tem `id: debelo`, e `debelo` + `credit_card` (o que o provider envia hoje) é rejeitado com **400**. `authorizePayment` lançaria erro e o `completeCart` falharia. |

Conclusões adicionais:

- **O `payment_method_id` já identifica o tipo nesta conta:** `debelo` só existe como `debit_card`, e a API exige coerência entre `id` e `type`. Mapear `id` → `type` no backend é uma alternativa ao campo do Brick, mas depende da lista de meios da conta.
- **Débito não está habilitado para esta conta vendedora na Orders API:** mesmo o par correto (`debelo` + `debit_card`) recebe `payment_method_not_allowed_for_collector`. O token usado era de um BIN pré-pago, então a causa exata **[não validado]** (conta × token). Mesmo assim, o Brick oferece "Cartão de Débito Virtual CAIXA".
- **O cartão oficial "Elo Débito" do sandbox é tratado como pré-pago** por esta conta, e não serve para testar débito.

### 7. Por que o Payment Brick recusou o cartão de débito (2ª rodada, 2026-09-27)

Pergunta: por que o Brick responde `payment_method_not_in_allowed_types` para o cartão oficial "Elo Débito"? Nenhum código ou configuração foi alterado.

#### Configuração efetiva do Brick (código e runtime)

- Código: `mercadopago-payment-container/index.tsx`, `customization.paymentMethods = { creditCard: "all", debitCard: "all", bankTransfer: "all", maxInstallments: 12 }`. Não há `prepaidCard` nem `types`.
- Runtime (capturado no `bricks().create`): `{"paymentMethods":{"creditCard":"all","debitCard":"all","bankTransfer":"all","maxInstallments":12}}`, com `initialization` = `amount` + `payer` e `locale` `pt-BR`. **É idêntico ao código.**
- O Brick traduz isso em `GET api.mercadopago.com/bricks/payment_brick/initialization?...&credit_card=all&debit_card=all&bank_transfer=all&max_installments=12`.

#### O que o Mercado Pago devolve ao Brick (endpoint de inicialização, leitura com a public key)

| Customização | `filtered_payment_types` | `filtered_payment_methods` |
|---|---|---|
| a do projeto (crédito + débito + transferência) | `bank_transfer`, `credit_card`, `debit_card` | `amex`, `debelo`, `elo`, `master`, `mp_card`, `pix`, `visa` |
| só `debit_card=all` | `debit_card` | **`debelo`** (Elo Débito, exibido como "Cartão de Débito Virtual CAIXA") |
| só `prepaid_card=all` | `prepaid_card` | `elo`, `master`, `visa` |

`all_payment_types` da conta inclui `debit_card` e `prepaid_card`.

#### Classificação do cartão de teste

O Brick consulta `payment_methods/search?bins=<bin>` e recebe `id: "elo"`, `payment_type_id: "prepaid_card"` para o cartão oficial "Elo Débito". O tipo `prepaid_card` não está entre os tipos filtrados, e o meio `elo`/`prepaid_card` não é o `debelo` permitido no formulário de débito. Daí `payment_method_not_in_allowed_types`, antes do `onSubmit`.

#### Documentação oficial (MCP `search_documentation`, 2026-09-27)

- Payment Brick, introdução (MLB): o Brick oferece "cartões de crédito, **cartão de débito virtual Caixa**, Pix, boleto, Conta Mercado Pago ou Parcelamento sem cartão". No MLB, o débito do Brick é o débito virtual Caixa, e não o débito de qualquer bandeira.
- Payment Brick, "Gerenciar meios de pagamento": no MLB, `creditCard`, `debitCard` e **`prepaidCard`** são chaves separadas. O exemplo oficial de renderização habilita `prepaidCard: "all"` junto com `debitCard: "all"`.
- Cartões de teste (MLB): **um único** cartão de débito de teste (Elo). Não há cartão de teste para débito virtual Caixa (`debelo`).
- A busca por `payment_method_not_in_allowed_types` na documentação não trouxe a definição do erro.

#### MCP Mercado Pago: o que foi possível verificar

| Capacidade | Resultado |
|---|---|
| `search_documentation` | usado (fontes acima) |
| `application_list` | 1 aplicação (`medusa-store`) na conta autenticada no MCP |
| `notifications_history` | nenhuma notificação para essa aplicação |
| Orders, Payments, meios de pagamento da conta | **o MCP não tem ferramenta de leitura para isso** |
| Conta do sandbox | as credenciais do projeto são de um **usuário de teste vendedor** (`/users/me`: `site_id MLB`, tag `test_user`), que não é a conta autenticada no MCP. Por isso o MCP não enxerga as Orders do sandbox. |

Por essa limitação, as leituras de conta foram feitas direto na API do Mercado Pago com as credenciais do projeto (lidas dentro de scripts, sem exibição): `GET /v1/payment_methods`, `GET /users/me`, o endpoint de inicialização do Brick e `GET /v1/orders/{id}`. Não foi usado `quality_evaluation`, que pode abrir formulário de homologação (escrita). Nenhuma configuração da conta foi alterada.

#### Hipóteses

| Hipótese | Resultado |
|---|---|
| A: `debit_card` não permitido no Brick | **Descartada.** `debit_card` está em `filtered_payment_types`, com `debelo`. |
| B: débito permitido, mas o cartão é classificado como `prepaid_card` | **Confirmada.** É a causa direta do erro no Brick. |
| C: a conta não habilita débito | **Não é a causa do erro no Brick**: o Brick lista `debelo`. Porém, na Orders API, `debelo` + `debit_card` retornou `payment_method_not_allowed_for_collector` (seção 5). Esse teste foi feito com token de BIN pré-pago, então a causa exata **[não validado]**. |
| D: cartão de teste inadequado | **Confirmada.** O único débito de teste oficial do MLB não é `debelo` para esta conta, e não existe cartão de teste de débito virtual Caixa. |
| E: outro problema de integração | Nenhum encontrado. A configuração do Brick está como a documentação descreve para crédito + débito. |

#### Crédito × débito

| Item | Crédito | Débito |
|---|---|---|
| Meio disponível na conta | `visa`, `master`, `elo`, `amex`, `mp_card` | `debelo` (Elo Débito) |
| Tipo permitido no Brick | `credit_card` ✅ | `debit_card` ✅ (só `debelo`) |
| Cartão de teste | Visa crédito oficial | Elo débito oficial (único do MLB) |
| Classificação do cartão | `visa` / `credit_card` | `elo` / **`prepaid_card`** |
| `paymentType` | `"credit_card"` | não emitido |
| `selectedPaymentMethod` | `"credit_card"` | não emitido |
| `additionalData.paymentTypeId` | `"credit_card"` | não emitido |
| `onSubmit` executou? | sim | **não** |
| Erro do Brick | nenhum | `payment_method_not_in_allowed_types` |
| Order criada? | sim (#79; MP processed/accredited) | não |
| Payment criado? | sim (capturado) | não |
| Resultado Mercado Pago | aprovado | nenhuma chamada |

#### Caminho viável para um débito chegar ao `onSubmit`

**Não há, no sandbox, com cartões de teste oficiais e a configuração atual.**

- Habilitar `prepaidCard` levaria o cartão ao `onSubmit`, mas como `prepaid_card`, não como débito. Isso é mudança de configuração, fora do escopo desta etapa.
- Testar `debelo` exigiria um cartão de débito virtual Caixa real, fora do sandbox, e a conta aparentemente não aceita débito na Orders API.

### 8. Escolha do campo que distingue o tipo (comparação, sem implementação)

| Critério | `selectedPaymentMethod` (1º argumento) | `additionalData.paymentTypeId` (2º argumento) |
|---|---|---|
| Documentação oficial | Doc do SDK JS: `'credit_card' \| 'debit_card' \| 'ticket' \| 'bank_transfer' \| …` | Exemplo oficial Orders API + Card Brick: `type: additionalData.paymentTypeId` |
| Tipos instalados (`sdk-react` 1.0.7) | `'creditCard' \| 'debitCard' \| …` (**diverge do runtime**) | `paymentTypeId?: string`; o 2º argumento é `IAdditionalCardFormData \| null` (opcional) |
| Runtime (crédito) | `"credit_card"` | `"credit_card"` |
| Semântica | a **opção escolhida** no Brick (formulário) | o **tipo associado ao meio de pagamento** (classificação do cartão), que é o que a Orders API cruza com `payment_method.id` |
| Estabilidade | tipo TS errado exigiria cast | argumento pode ser `null`, o que exige tratamento de ausência |
| Contrato storefront → backend | igual nos dois casos: campo novo `payment_type_id` na allowlist | igual |

Regra observada na Orders API (seção 5): `credit_card` exige `id` ∈ {`amex`, `elo`, `diners`, `hipercard`, `master`, `visa`}; `debit_card` exige `id` = `debelo`. O `type` precisa corresponder ao **meio de pagamento**, o que favorece `paymentTypeId` semanticamente.

**Recomendação (não implementada):** usar `additionalData.paymentTypeId`, conferindo com `selectedPaymentMethod` quando os dois existirem. O valor para débito continua **[não validado]**, porque não foi possível observá-lo (seção 7).

### 9. Menor correção proposta para a próxima etapa (não implementada)

```text
Brick onSubmit(param, additionalData)
  → storefront envia payment_type_id = additionalData.paymentTypeId
→ allowlist aceita payment_type_id ∈ {credit_card, debit_card}
→ PaymentSession.data.payment_type_id
→ authorizePayment (caminho de cartão): payment_method.type = data.payment_type_id
```

| Arquivo | Mudança |
|---|---|
| `apps/storefront/src/modules/checkout/components/mercadopago-payment-container/index.tsx` | ler o 2º argumento do `onSubmit` e enviar `payment_type_id` |
| `apps/backend/src/api/store/mercadopago/payment-sessions/[id]/route.ts` | allowlist: `payment_type_id` com valores restritos |
| `apps/backend/src/modules/mercadopago/service.ts` | `authorizePayment` (cartão) usa `data.payment_type_id` |

Testes:
- `PS` (allowlist aceita os dois valores e descarta os demais);
- `S` (`credit_card` → `credit_card`; `debit_card` → `debit_card`; ausente → conforme a decisão);
- checagem de tipos nos dois apps e testes unitários;
- E2E de crédito (regressão). O E2E de débito não é possível no sandbox (seção 7).

A correção vem com um ADR, porque muda o contrato storefront → backend. Pix não é alterado.

### 10. Decisões (tomadas em 2026-09-27; ver seção 11)

1. **Débito no checkout.**
   - O Brick oferece "Cartão de Débito Virtual CAIXA" (`debelo`).
   - A Orders API recusou `debelo` + `debit_card` para esta conta, com causa **[não validado]**.
   - O E2E de débito é inviável no sandbox.
   - Opções:
     - manter `debitCard` e confirmar na conta/produção se o débito é aceito;
     - remover `debitCard` até haver como validá-lo.
2. **Sessions sem `payment_type_id`.** Tratar como crédito, derivar do `payment_method_id` (`debelo` → débito) ou recusar. A decisão depende do item 1.
3. **Pré-pago.** Não está habilitado. Se for habilitado:
   - o provider enviaria `credit_card` com `id` `elo`/`visa`/`master`, e a Orders API **aceita** (seção 5: cartão classificado como pré-pago foi cobrado como crédito);
   - `prepaid_card` exige omitir `installments`;
   - é preciso decidir como tratar esse caso.

### 11. Correção implementada (2026-09-27, não commitada)

Decisões [decisão humana 2026-09-27]:
- **Débito:** `debitCard: "all"` mantido.
- **Pré-pago:** fora do contrato e desabilitado.
- **Sessions sem `payment_type_id`:** recusadas; sem inferência e sem fallback para crédito.
- **Campo:** `additionalData.paymentTypeId`.

| Arquivo | Mudança |
|---|---|
| `apps/storefront/.../mercadopago-payment-container/index.tsx` | `onSubmit(rawArgs, additionalData)`; o payload de cartão envia `payment_type_id: additionalData?.paymentTypeId`. Payload do Pix inalterado. |
| `apps/backend/src/api/store/mercadopago/payment-sessions/[id]/route.ts` | Allowlist aceita `payment_type_id` só com `credit_card` ou `debit_card`. Qualquer outro valor enviado é recusado com `INVALID_DATA`. Uma submissão de cartão nova sem o campo remove o tipo antigo da session. |
| `apps/backend/src/modules/mercadopago/service.ts` | `isCardPaymentType`. `authorizePayment` (cartão) revalida e usa `data.payment_type_id` como `payment_method.type`. Ausente ou inválido → erro controlado, **sem** chamar a Orders API. |

**Verificação:**

- **Testes unitários do backend:** 141/141 passando (antes 121). Os 20 novos cobrem:
  - na allowlist, aceitar `credit_card`/`debit_card` e recusar `prepaid_card`, `foo`, `creditCard`, `debitCard`, `""`, `null` e `1`;
  - a remoção do tipo antigo;
  - Pix sem o campo;
  - no provider, `credit_card`, `debit_card`, ausente, `null`, `prepaid_card`, `creditCard`, `debitCard`, `""` e `foo`, sem Order nos casos inválidos;
  - Pix sem `payment_type_id`.
- **Checagem de tipos:** backend e storefront limpos.
- **Builds:** `medusa build` e `next build` concluídos. Os 2 warnings de lint (`@medusajs/no-service-mutations-in-api-route`) são de chamadas `updatePaymentSession` que já existiam.
- **E2E de regressão (crédito, sandbox):**
  - o Brick entregou `paymentTypeId = "credit_card"`;
  - a session gravou `payment_type_id = credit_card`;
  - `POST /v1/orders` foi enviado com `type: credit_card` e voltou processed/accredited;
  - Order Medusa **#80**.
- **Débito:** coberto por teste unitário (`debit_card` → `type: debit_card`). O E2E **não** foi validado, porque é inviável no sandbox (seção 7).
- **Frontend:** o storefront não tem testes automatizados. O envio de `paymentTypeId` → `payment_type_id` foi verificado pelo E2E acima.
