# ADR-005: Tipo do cartão vem do Payment Brick (`payment_type_id`)

> Status: aceito · Data: 2026-09-27 · Commits: `3a56150` · Investigação: [INV-001](../investigations/INV-001-debit-card-sent-as-credit-card.md)

## Contexto

- A Orders API exige `transactions.payments[].payment_method.type` = `credit_card` para crédito e `debit_card` para débito ("Obrigatório", página oficial "Cartões" do Checkout Transparente via Orders API).
- O provider enviava `type: 'credit_card'` para **todo** pagamento com cartão, desde `92d16ec`.
- A Orders API também exige que `type` seja coerente com o `payment_method.id` (validação de esquema). Um débito real (`id: debelo`) com `type: credit_card` é recusado com HTTP 400 (INV-001, seção 5).
- O Payment Brick (`@mercadopago/sdk-react` 1.0.7) informa o tipo **fora** de `formData`. Em runtime, no crédito, `additionalData.paymentTypeId` (2º argumento do `onSubmit`) = `"credit_card"`.

## Decisão

1. O storefront envia `additionalData.paymentTypeId` como **`payment_type_id`** no payload de cartão de `POST /store/mercadopago/payment-sessions/:id`.
2. A rota aceita `payment_type_id` **somente** com os valores `credit_card` ou `debit_card`. Qualquer outro valor enviado (inclusive `prepaid_card`, `creditCard`, `debitCard`, `""`, `null`) é recusado com `INVALID_DATA`, sem atualizar a session.
3. Numa submissão de cartão nova (com `card_token`) sem `payment_type_id`, a rota remove o `payment_type_id` que já estiver na session, para que o tipo de um cartão anterior nunca seja reaproveitado.
4. `authorizePayment` (caminho de cartão) **revalida** `data.payment_type_id` com `isCardPaymentType` (`service.ts`) e o envia como `payment_method.type`. Isso vale mesmo que o dado tenha chegado à session por outro caminho.
5. Sem `payment_type_id` (ausente ou `null`), `authorizePayment` recusa com erro controlado ("the card payment session is missing the card type. Please re-enter your payment information."). Com valor fora do contrato, também recusa. Nos dois casos, **nenhuma Order é criada no Mercado Pago**.
6. O tipo **nunca** é inferido: nem do `payment_method_id`, nem por fallback para `credit_card`.

## Alternativas consideradas

- **`selectedPaymentMethod`** (1º argumento): reflete a opção escolhida no formulário, não o tipo do meio de pagamento, e os tipos TypeScript instalados dão o formato errado (`'creditCard'`). Descartada como fonte principal.
- **Derivar do `payment_method_id` no backend:** o identificador da bandeira não determina o tipo sozinho (por exemplo, `elo`, `visa` e `master` existem como crédito e como pré-pago nesta conta). Descartada [decisão humana 2026-09-27].
- **Fallback para `credit_card` em sessions antigas:** repetiria o bug para um débito. Descartada [decisão humana 2026-09-27].

## Consequências

- Crédito: comportamento inalterado (`credit_card` → `credit_card`).
- Débito: passa a ser enviado como `debit_card`. **Não validado em E2E:** o único cartão de débito de teste oficial do MLB é classificado como `prepaid_card` e o Brick o recusa antes do `onSubmit` (INV-001, seção 7).
- **Sessions de cartão criadas antes desta mudança** (sem `payment_type_id`) não são autorizadas. O comprador precisa preencher os dados de pagamento de novo no Brick, o que grava o campo.
- `prepaid_card` continua fora do contrato, e `prepaidCard` continua desabilitado no Brick. Habilitar pré-pago exige um novo ADR (a Orders API proíbe `installments` para `prepaid_card`).
- `debitCard: "all"` continua habilitado no Brick [decisão humana 2026-09-27].
- Pix não é afetado: não usa `payment_type_id`, e seu discriminador (`isPixSession`) não olha esse campo.
