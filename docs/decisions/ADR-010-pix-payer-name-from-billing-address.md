# ADR-010: Nome do pagador do Pix derivado do endereço de cobrança do cart

> Status: aceito · Data: 2026-09-29 · Commits: ainda não commitado (implementado sobre `a4aae37`) · Evidência: [INV-003](../investigations/INV-003-pix-sandbox-approval.md)

Marcadores de origem: [../README.md](../README.md#convenções). **[MCP 2026-09-29]** indica documentação oficial do Mercado Pago consultada pelo MCP `search_documentation` (MLB) nessa data. O código citado é o do commit `a4aae37`, com o `@medusajs/payment` 2.20.1 e o SDK `mercadopago` 3.6.1 instalados.

## Contexto

### Problema

A Order Pix criada pelo checkout não leva `payer.first_name` nem `payer.last_name`:

- no Pix, o Payment Brick só pré-preenche `payer.email` [MCP 2026-09-29], e o storefront envia `email` + `identification` (`mercadopago-payment-container/index.tsx`);
- a rota `POST /store/mercadopago/payment-sessions/:id` reduz `payer` a `email` + `identification` (`sanitizePayer`, invariante 2);
- `createPixOrder` envia `session.data.payer` sem alteração.

No mecanismo de teste de Pix do sandbox, `payer.first_name = "APRO"` é o gatilho documentado da aprovação automática [MCP 2026-09-29], e a [INV-003](../investigations/INV-003-pix-sandbox-approval.md) confirmou isso com o corpo real do `createPixOrder`. Sem ele, o Pix do checkout fica em `waiting_transfer` até vencer, e os cenários B e B' não podem ser executados de ponta a ponta.

### Escopo do `APRO`

- `first_name = "APRO"` é um gatilho **do sandbox**, documentado e confirmado.
- Isso **não** significa que `first_name` seja obrigatório para Pix em produção. Nas páginas consultadas, `first_name`/`last_name` aparecem como opcionais ou como dados que "podem melhorar a aprovação" [MCP 2026-09-29].
- Esta decisão **não** se justifica por um requisito geral de produção do Mercado Pago. O motivo é permitir testar o fluxo real de ponta a ponta sem código específico de teste. Levar o nome no `payer` é apenas uma forma permitida pela API de usar um dado que a loja já tem.

### Estrutura atual relevante

- **Onde o nome existe:** `first_name` e `last_name` são campos `required` nos formulários de entrega e de cobrança do storefront. `setAddresses` (`apps/storefront/src/lib/data/cart.ts`) sempre grava `billing_address`: com "same as billing" é uma cópia do endereço de entrega. Esse passo vem antes da escolha do pagamento. A Store API do Medusa aceita atualizar o cart sem essa validação, então o servidor não pode presumir os campos preenchidos.
- **Onde o `payer` é montado:** a rota de update (`payment-sessions/[id]/route.ts`) já lê o cart com `query.graph` (verificação de posse), monta o `payer` com `sanitizePayer` e grava `{ ...session.data, ...allowedData }`. O merge é raso: um `payer` enviado substitui o anterior inteiro.
- **O prepare e o fallback só leem `session.data`:** a rota de prepare (`payment-sessions/[id]/pix/route.ts`) repassa `session.data` com o campo transitório `mercadopago_pix_action`. O fallback `authorizePayment` → `authorizePix` → `createPixOrder` roda dentro do Payment Module e não tem acesso ao cart.
- **Armazenamento:** `session.data.payer` é persistido e copiado para `payment.data`. A Store API o reduz a `{ payment_method_id }` (ADR-006, invariante 24).

### Idempotência da criação da Order Pix

**Restrição do Mercado Pago:**
- `X-Idempotency-Key` é obrigatório na criação da Order;
- repetir a requisição com a mesma chave pode devolver o resultado original;
- reutilizar a chave com **body diferente** pode ser rejeitado com `idempotency_key_already_used`;
- uma operação distinta deve usar uma chave nova.

Daí a restrição que este ADR preserva:

```text
mesma chave de idempotência  ⇒  mesmo body
```

**Como a chave é formada hoje:**

```text
chave base = session.data.mercadopago_idempotency_key = payment_session.id
             (o Medusa passa context.idempotency_key = session.id ao criar a session; o initiatePayment o grava)
chave Pix  = sha256(`${chave base}:pix:${amount}:${generation}`)            (getPixIdempotencyKey)
generation = mercadopago_pix_generation + 1, ou 0; gravada só no retorno de sucesso de createPixOrder
```

**Operação idempotente:** a criação da Order Pix da geração N de uma Payment Session. Não existe outra entidade para isso, e nenhuma é criada.

**Por que a regra se mantém hoje:** o body do `createPixOrder` depende só de dados persistidos da session (`amount`, `cart_id`, `payer`) e de constantes (`expiration_time` é a duração `PT1H`, não uma data). Depois de uma falha, nada é gravado, porque o Payment Module chama o provider antes de gravar a session. A tentativa seguinte reconstrói então a mesma chave **e** o mesmo body, e o Mercado Pago devolve a Order original em vez de criar outra. O SDK também repete sozinho (até 3 vezes em timeout de 60 s, erro de rede, 429 e 5xx) com a mesma chave e o mesmo body.

## Decisão

1. **A origem do nome** é o `billing_address.first_name` e `billing_address.last_name` do cart, lidos pelo backend. O cliente não fornece esses campos: `sanitizePayer` continua descartando qualquer nome enviado (a invariante 2 permanece).
2. **O ponto de leitura** é a rota de update da Payment Session (`POST /store/mercadopago/payment-sessions/:id`), no `query.graph` do cart que ela já faz. **Só para sessions Pix** (`payment_method_id === "pix"` no resultado da allowlist), o nome é incorporado ao `payer` gravado: `payer = { ...sanitizePayer(body.payer), first_name?, last_name? }`. Entram apenas valores presentes e não vazios. Sem nome no cart, o `payer` fica como hoje.
3. **O nome é persistido em `session.data.payer`**, junto com o e-mail. Não passa por campo transitório.
4. **`createPixOrder` não muda:** continua enviando `session.data.payer`.
5. **O prepare não relê o cart** para montar o `payer` e continua repassando `session.data` sem alteração.
6. **O fallback `authorizePix`** usa o mesmo `payer` persistido, com o mesmo body e a mesma chave do prepare.
7. **O cartão não muda.** A rota não acrescenta nome a sessions de cartão. Como o cartão sempre envia `payer` e o merge é raso, um nome gravado numa seleção Pix anterior não passa ao cartão.
8. **Vale para todos os ambientes**, sem ramo específico do sandbox. No sandbox, o teste usa "APRO" como nome no endereço de cobrança.

### Por que preserva a idempotência

O nome passa a fazer parte dos dados persistidos da session **antes** de qualquer criação de Order, na mesma etapa que já grava o e-mail. O body do `createPixOrder` continua dependendo só de `session.data`. Assim, a mesma geração sempre reconstrói o mesmo body: no prepare, num novo prepare depois de uma falha, no regenerate da geração seguinte e no fallback.

**Endereço alterado depois:**
- **com a Order já criada:** não altera a Order. Ela é reutilizada enquanto pagável (`preparePixOrder`), e o nome é apenas informativo;
- **sem reenviar o Brick:** também não altera o `payer` da session. Só um novo envio do Brick relê o endereço.

### Invariantes novas

Invariantes **40** e **41** em [../mercadopago/invariants.md](../mercadopago/invariants.md) (nome só do `billing_address`, lido no servidor e só para Pix; body do `createPixOrder` só de `session.data` persistida + constantes).

## Alternativas consideradas

| Alternativa | Idempotência | Duplicação / órfã | Endereço muda | Arquitetura |
|---|---|---|---|---|
| **A. Continuar só com `payer.email`** | Inalterada | Nenhuma | — | B e B' continuam impossíveis no sandbox |
| **B. Ler o nome no prepare (versão anterior deste ADR), campo transitório, chave atual** | **Quebra "mesma chave ⇒ mesmo body".** Depois de uma criação cuja resposta se perdeu, a mesma geração é refeita com outro nome. O fallback `authorizePix` refaria a geração sem nome mesmo sem mudança de endereço. | Não duplica: a API tende a recusar (`idempotency_key_already_used`) | A session trava: todo prepare e todo regenerate repetem a geração não gravada e falham, até a session ser recriada | Insumo não persistido dentro de uma operação idempotente. Descartada |
| **C. Colocar o payer na composição da chave** | Mantém a relação, mas cada payer vira uma operação nova | **Pode gerar uma segunda Order.** Se a primeira criação aconteceu e a resposta se perdeu, ela fica **órfã**, pagável até vencer e fora de qualquer session (fere o objetivo da invariante 8). O fallback sem nome geraria outra chave. | Nova Order a cada mudança | Troca o travamento por Orders órfãs. Descartada |
| **D. Gerar chave nova a cada mudança do payer** | Idem C | **Também pode gerar Orders órfãs**, pelo mesmo motivo | Nova Order a cada mudança | Exigiria gravar o payer da última tentativa, que não existe quando a tentativa falha. Descartada |
| **E. Congelar o payload antes do POST** | Mantém | Nenhuma | O nome fica congelado na tentativa | Exigiria gravar a session **antes** de chamar o Mercado Pago. Hoje o Payment Module chama o provider e só depois grava, então seria uma mudança maior no ciclo de `updatePaymentSession`. Descartada |
| **F. Persistir o nome em `session.data.payer` na rota de update** (escolhida) | Mantém: o body continua dependendo só de dados persistidos | Nenhuma nova | Relido só em novo envio do Brick; a Order criada não muda | Usa a etapa que já monta e grava o `payer`, sem entidade, schema, rota ou mudança no storefront |
| **G. Coletar nome e sobrenome no frontend** | Igual à F, se persistido na mesma rota | Nenhuma nova | Declarado no pagamento | O Brick não coleta nome no Pix: seriam campos próprios, `sanitizePayer` teria de aceitar mais dados do cliente (contra a invariante 2), e o storefront não tem testes de componentes. Descartada |
| **H. Só `first_name`, para satisfazer o sandbox** | Igual à F | Igual à F | Igual à F | Vindo do mesmo endereço, omitir o sobrenome não economiza nada. Com valor fixo ou variável de ambiente, seria código de teste no caminho de produção. Descartada |

## Consequências

- **Testes:** no sandbox, o nome de cobrança "APRO" permite executar B' com o fluxo real do checkout. B continua difícil de reproduzir, porque a aprovação leva segundos ([INV-003](../investigations/INV-003-pix-sandbox-approval.md#implicações-para-os-cenários-b-e-b)).
- **Privacidade:** o nome de cobrança passa a ficar em `session.data.payer` e `payment.data` (hoje com e-mail e, quando houver, CPF) e é enviado ao Mercado Pago. A Store API continua sem expô-lo (ADR-006).
- **Nome possivelmente defasado:** se o endereço mudar depois do envio do Brick, a Order sai com o nome anterior. É aceito, porque o nome é informativo.
- **Documentação:** invariantes 40 e 41 em [../mercadopago/invariants.md](../mercadopago/invariants.md); campos de `session.data` em [../mercadopago/README.md](../mercadopago/README.md).
- **Não muda:** prepare, `service.ts`, `getPixIdempotencyKey`, webhook, correlação, `sanitizePayer`, Payment Brick, storefront, schema e banco.

### Risco pré-existente (fora do escopo deste ADR)

O código atual já tem um risco do mesmo tipo:

1. o prepare cria a Order no Mercado Pago;
2. a resposta se perde (a geração não é gravada);
3. o cliente reenvia o Brick com o `payer` alterado (outro e-mail ou CPF);
4. o prepare seguinte reconstrói a mesma geração, com a mesma chave e um body diferente.

Esse risco não foi criado pelo ADR-010. A mudança só acrescenta `first_name`/`last_name` aos dados que podem mudar num reenvio do Brick. Ele **não** é resolvido aqui. Fica registrado para decisão própria, na mesma família da pendência 7 do [status](../status.md) (chave do cartão estável durante a session).

### Questões em aberto (não são requisitos desta implementação)

- TTL da idempotency key no Mercado Pago.
- Requisições simultâneas com a mesma chave (por exemplo, dois prepares em abas diferentes).
- Comportamento exato da API quando a mesma chave recebe body diferente: rejeição ou devolução da Order original.
- Recuperação de uma Order já criada por `external_reference`: o fluxo não faz isso hoje.

## Implementação e testes

A implementação ficou só em `payment-sessions/[id]/route.ts` (`getBillingName`, `withPayerName`, dois campos a mais na consulta do cart). `service.ts`, a rota de prepare, `getPixIdempotencyKey`, o webhook e o storefront não mudaram. Uma decisão de implementação: numa session que não é Pix, a rota **remove** qualquer nome do `payer`. Isso cobre o caso de um update de cartão sem `payer`, que herdaria o `payer` de uma seleção Pix anterior pelo merge raso.

Cobertura (backend: 12 suítes, 263 testes passando em 2026-09-29). E2E em 2026-09-29: B' confirmado ([E2E-B-PRIME-2026-09-29](../investigations/E2E-B-PRIME-2026-09-29.md)); B não reproduzido ([E2E-B-2026-09-29](../investigations/E2E-B-2026-09-29.md)).

**S** (`modules/mercadopago/__tests__/service.unit.spec.ts`, bloco "payer name and idempotency (ADR-010)"):
- `createPixOrder` envia `first_name`/`last_name` presentes em `session.data.payer`.
- Não inventa esses campos quando ausentes.
- Retry depois de um `create` rejeitado reutiliza a mesma chave e um body idêntico (deep equal), sem avançar a geração.
- `authorizePix` (fallback, sem Order) usa a mesma chave e o mesmo body do prepare para os mesmos dados.
- O regenerate incrementa a geração (chave nova) e preserva o `payer`.

**PX** (`api/store/mercadopago/payment-sessions/[id]/pix/__tests__/route.unit.spec.ts`):
- O prepare repassa `session.data.payer` sem alteração.
- O prepare não relê o cart para reconstruir o `payer`.
- Uma alteração do endereço depois do update não muda o `payer` daquela session.

**PS** (`api/store/mercadopago/payment-sessions/[id]/__tests__/route.unit.spec.ts`):
- Session Pix recebe `first_name`/`last_name` do `billing_address` do cart.
- Nome enviado pelo cliente no `payer` é ignorado.
- Campos vazios ou ausentes são omitidos.
- Session de cartão continua inalterada: sem nome acrescentado, inclusive depois de uma seleção Pix anterior.
