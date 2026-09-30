# ADR-015: Reconciliação da Order de cartão com resultado ambíguo

> Status: **aceito** em 2026-09-30 [decisão humana 2026-09-30]. O módulo, a máquina de estados, a criptografia e a integração (provider, rota de update e webhook) estão implementados e testados. O H7 foi executado no webhook real e comprovou o fallback pela tentativa e a regra 12 (`unknown → resolved`) ([evidência](../investigations/INV-009-card-ambiguous-order-reconciliation.md#h7-no-webhook-real-2026-09-30-aprovado)) · Data: 2026-09-29 · Revisado: 2026-09-30 (armazenamento do `card_token`) · Commits: — (implementação ainda não commitada)

Investigação, evidências e plano de implementação: [INV-009](../investigations/INV-009-card-ambiguous-order-reconciliation.md). Complementa o [ADR-014](ADR-014-card-order-idempotency-key-from-body.md), que continua válido. Altera o invariante 19 (correlação do webhook).

Marcadores de origem:
- **[sandbox 2026-09-29]**: E2E da INV-009 (H1, H7);
- **[sandbox 2026-09-30]**: E2E final da INV-009, com H7 no webhook real;
- **[código 2.20.1]**: pacotes `@medusajs/*` 2.20.1 instalados, lidos em 2026-09-29/30;
- **[banco 2026-09-30]**: consulta read-only só com contagens.

**Revisão de 2026-09-30:** a primeira versão deste ADR, ainda proposta, guardava a tentativa e o `card_token` em `PaymentSession.data`. A [revisão de armazenamento](../investigations/INV-009-card-ambiguous-order-reconciliation.md#revisão-armazenamento-do-card_token-2026-09-30) mostrou que isso espalha o token por lugares que a limpeza da session não alcança. A tentativa passa para um módulo próprio, com o token criptografado.

## Contexto

O cenário:
1. `authorizePayment` (cartão) envia `POST /v1/orders`, e o resultado externo fica desconhecido: timeout ou erro de rede depois das 4 tentativas do SDK, `423`, `5xx` final, ou 2xx sem `id`.
2. O provider lança, o Payment Module não grava nada, e a Payment Session continua `pending`, sem `mercadopago_order_id` [código 2.20.1].
3. O cliente reenvia o cartão pelo Brick. Como o token é sempre novo, o body muda e, pelo ADR-014, a idempotency key também.
4. Se a primeira operação foi aceita e só a resposta se perdeu, a segunda cria **uma segunda cobrança**.

O que a INV-009 estabeleceu:
- **Não existe lookup por idempotency key** [doc oficial 2026-09-29].
- **`external_reference = cart_id` não identifica a tentativa:** o mesmo cart tem mais de uma Order, e até um `402` deixa uma Order `failed` [sandbox 2026-09-29].
- **Busca vazia não prova ausência:** busca exata, mas com atraso de indexação [sandbox 2026-09-29].
- **Replay da mesma operação é determinístico:** mesma chave + mesmo body depois de um `201` → mesmo `order.id` e mesmo payment, sem segunda cobrança (**H1**) [sandbox 2026-09-29].
- **`external_reference = <cart_id>-<attempt_id>` é preservado (H7):**
  - 58 caracteres, idêntico no `GET` [sandbox 2026-09-29];
  - chega no webhook real, onde o fallback encontra a tentativa depois de uma resposta perdida e a regra 12 a resolve [sandbox 2026-09-30] ([evidência](../investigations/INV-009-card-ambiguous-order-reconciliation.md#h7-no-webhook-real-2026-09-30-aprovado)).
- **O webhook atual não encontra a Order ambígua** (invariante 19).
- **`pending_authorization` não serve:** cria o pedido Medusa, o core descarta `failed`/`canceled`, e não há reautorização pela Store [código 2.20.1].
- **O replay exige o mesmo body e, portanto, o mesmo `card_token`.** O Mercado Pago não devolve o token, e uma nova tokenização muda o body e a chave.
- **Hoje o `card_token` fica em claro em `payment_session.data` (38 linhas), é copiado para `payment.data` (33) e aparece no contexto persistido do workflow `complete-cart` (13 execuções)** [banco 2026-09-30].
  - O `completeCartWorkflow` tem `store: true` e `retentionTime` de 3 dias, e o workflow engine grava no `workflow_execution` o resultado dos steps, incluindo o `cart-query` com `payment_collection.payment_sessions.*` [código 2.20.1].
  - A consulta padrão de pedido do Admin inclui `*payment_collections.payments` (com `data`) [código 2.20.1; não verificado em requisição real].

## Decisão

1. **`pending_authorization` não representa este caso.** O cart continua aberto, e nenhum pedido Medusa é criado durante a indefinição.
2. **Nenhum status customizado.** A Payment Session continua `pending`: nenhum dado da tentativa é gravado nela pela falha.
3. **A tentativa vive num módulo próprio do projeto** (`mercadopagoCardAttempt`, tabela `mercadopago_card_attempt`), não em `PaymentSession.data`. Precedente no projeto: o módulo `paymentAccess` (ADR-007), com tabela e migration próprias.
   - O registro nasce **quando o Brick envia o cartão** (estado `submitted`), porque a partir daí o token precisa estar em algum lugar, e passa a `authorizing` no Place order, **pelo provider, imediatamente antes do `POST`** [decisão humana 2026-09-30, opção B].
   - `PaymentSession.data` deixa de receber `card_token`.
4. **Um `attempt_id` por tentativa:** ULID gerado no servidor, um por envio do cartão. É o mesmo em retries e replays; um novo envio, fora de estados abertos, gera outro registro.
5. **`external_reference = <cart_id>-<attempt_id>`** nas Orders de cartão. Pix e Orders antigas continuam com `cart_id`, e o webhook aceita os dois formatos.
6. **A correlação atual é preservada.** Primeiro: `data.id` → `GET` → session com `mercadopago_order_id === data.id`.
7. **Fallback por `attempt_id`**, só quando nenhuma session guarda a Order:
   - `external_reference` → tentativa no módulo (única por `attempt_id`) → `payment_session_id`;
   - a session precisa pertencer ao cart do `external_reference` e ser `pp_mercadopago`;
   - a tentativa precisa estar aberta, o valor precisa bater, e não pode haver outra Order registrada.

   Satisfeito, o `mercadopago_order_id` é gravado **na tentativa** e o evento é emitido. Caso contrário, não associa: 503 se paga, 200 se não paga.
8. **O checkout fica congelado durante a indefinição** (`authorizing`/`unknown`):
   - nenhum novo envio de cartão;
   - nenhuma remoção da session (`deletePayment` recusa), o que também bloqueia mudanças que alteram o total do cart;
   - nenhum Place order concorrente com `authorizing` recente.
9. **Resolução:**
   - com `mercadopago_order_id` conhecido na tentativa: `GET`, nunca `POST`;
   - sem ele: replay da mesma tentativa (mesma chave, mesmo body, mesmo token), pelo Place order do cliente ou por um operador.
10. **Nenhum replay automático em segundo plano** sem decisão de produto.
11. **O job de reconciliação só lê e alerta.** Não chama `POST`, não repete, não grava.
12. **Prazo único `created_at + 24 h`** [decisão humana 2026-09-30]: governa replay, validade, decifração, expiração e destruição do token. O retry não renova o prazo. Passado o prazo, a tentativa aberta vira `expired`, o token é destruído, não há mais replay, e o caso vai para tratamento manual (limite conservador; H2 não validada). A condição é conferida no banco em cada transição e na leitura do token, não só por um job.
13. **`unknown → resolved`** [decisão humana 2026-09-30]: a confirmação pelo webhook chama o provider pelo `processPaymentWorkflow`, sem passar pelo Place order, então uma tentativa `unknown` com a Order registrada pode ir direto a `resolved`. As transições aprovadas estão na [INV-009](../investigations/INV-009-card-ambiguous-order-reconciliation.md#3a-transições); uma tentativa bloqueante (`authorizing`/`unknown`) nunca é substituída.

### Fluxo de erros no provider

O provider registra o resultado **na tentativa** (módulo), por uma gravação própria, antes de responder ao Payment Module:

| Resultado | Registro na tentativa | Resposta ao Payment Module |
|---|---|---|
| sucesso | `resolved` + `mercadopago_order_id`, token destruído | status mapeado (como hoje) |
| erro definitivo (400, 401, 402, 403, 422) | `failed`, token destruído | relança o erro (como hoje: session `pending`, `complete` → 200 com `PAYMENT_AUTHORIZATION_ERROR`) |
| ambíguo | `unknown`, token mantido criptografado | relança o erro (como acima) |

**Ownership (opção B)** [decisão humana 2026-09-30]: as regras 3, 4 e 5 (`submitted → authorizing` antes do `POST`, `unknown → authorizing` no replay e `authorizing → authorizing` na retomada de uma tentativa travada) são executadas **pelo provider**, não pelo hook `validate` do `completeCartWorkflow`. Nenhum hook é usado.
- Como o módulo grava em transação própria (comprovado na INV-009, T1/T2), `authorizing` fica persistido antes do `POST` e sobrevive a qualquer falha do workflow.
- Não existe compensação `authorizing → unknown`. Uma falha do workflow **antes** da autorização deixa a tentativa `submitted`. Um crash **durante** o `POST` deixa `authorizing`, retomada pela regra 5 depois da janela de 5 min.
- O body e o `body_sha256` são montados só no provider, e o token decifrado nunca passa por input nem output de step de workflow (`workflow_execution` persiste esses dados).

Essa gravação é independente da transação do Payment Module. Se a transação de `authorizePaymentSession_` falhar depois de um sucesso, a tentativa já está `resolved` com o ID da Order, e a próxima resolução faz `GET`, sem novo `POST`.

## Segurança

**`card_token`:**
- **Criptografia:** criptografado **antes** de entrar na entidade, com AES-256-GCM (`node:crypto`), a mesma construção do `encryptSecret` interno do `@medusajs/auth` 2.20.1, sem importá-lo:
  - IV aleatório de 12 bytes e tag de 16 bytes, com `authTagLength: 16` obrigatório na decifração (sem ele, o Node 24 aceita uma tag truncada de 4 bytes: verificado em 2026-09-30);
  - formato `v1:<kid>:<iv>:<tag>:<ciphertext>` em base64url, com validação estrita (tamanhos, regex e reencode canônico) antes de decifrar;
  - AAD = `JSON.stringify(["mercadopago_card_token", "v1", kid, attempt_id, payment_session_id])` (impede mover o ciphertext entre registros e trocar o `kid`);
  - detalhes e matriz de testes na [INV-009](../investigations/INV-009-card-ambiguous-order-reconciliation.md#3b-criptografia-verificado-no-node-v24210-do-projeto-nodecrypto).
- **Chave:** 32 bytes em variável de ambiente, **nunca no banco** (`MERCADOPAGO_CARD_TOKEN_KEYS` = `kid:chave,…`, `MERCADOPAGO_CARD_TOKEN_CURRENT_KID`). Rotação por anel de chaves (`kid` atual + anteriores), sem recriptografia na leitura. Como o token vive ≤ 24 h desde `created_at`, uma chave antiga só sai do anel 24 h + 1 h depois de deixar de ser a atual. Configuração malformada impede o boot; ausente deixa o backend subir, e as tentativas de cartão são recusadas.
- **Decifração:** só no provider, no momento do `POST` ou do replay. Nunca em rota, log, resposta ou input de step.
- **Nenhum hash do token** é guardado para busca: não há necessidade de deduplicar por token, e o hash não serve para replay. `body_hash` (SHA-256 do body canônico) serve só para conferir o replay.

**Nunca persistidos:** CVV, número do cartão, dados completos do cartão, body completo, header `Authorization`, access token do Mercado Pago, idempotency key derivada (invariante 47).

**Exposição:**
- o storefront não recebe nada da tentativa além de um estado derivado (`none`/`confirming`/`manual_review`), por rota própria e sem IDs;
- a tabela não é exposta por nenhuma rota da Store nem do Admin;
- logs só com IDs de session, tentativa e Order.

**Retenção:**
- **Token temporário.** Destruído (coluna anulada) em qualquer estado terminal, ao remover a session, ou no prazo único (`created_at + 24 h`), o que ocorrer primeiro.
- **Metadados da tentativa mantidos** para auditoria e conciliação: IDs, estado, `body_hash`, `external_reference`, Order, timestamps, classe do último erro. Prazo proposto: 90 dias, decisão a confirmar.

## Não-atomicidade

A Order do Mercado Pago, o módulo da tentativa e o Payment Module **não** formam uma transação. Este mecanismo:
- garante no máximo uma Order por tentativa, dentro da retenção da idempotência;
- impede uma segunda tentativa enquanto a primeira é desconhecida;
- oferece resolução determinística: `GET` por `order_id` registrado, replay, ou webhook com `attempt_id`.

Ele **reduz** o risco de cobrança dupla, mas não transforma Mercado Pago e Medusa em uma transação distribuída. Continuam possíveis:
- um crash entre a resposta do Mercado Pago e a gravação na tentativa (fica `authorizing` → `unknown` → replay devolve a mesma Order);
- tentativas além de 24 h;
- Orders criadas por terceiros com o access token.

## Alternativas consideradas

- **Tentativa e token em `PaymentSession.data`** (primeira versão deste ADR): o token se espalha para `payment.data`, para o `workflow_execution` do `complete-cart` (retido por 3 dias) e para a consulta de pedidos do Admin, e a limpeza da session não os alcança. Rejeitada.
- **Token criptografado em `PaymentSession.data`:** tira o texto claro, mas o ciphertext continua copiado nesses mesmos lugares; destruir o token não é possível de fato. Rejeitada.
- **Redis / secret manager:** Redis não está configurado no projeto ("fake redis" em desenvolvimento), e um secret manager por token é infraestrutura nova sem ganho sobre a tabela criptografada com a chave fora do banco. Rejeitada. Um KMS pode envolver a chave de criptografia no futuro.
- **Não guardar o token:** impossível fazer o replay (H1) sem o mesmo body. Guardar só em memória não sobrevive a restart e deploy. Rejeitada.
- **`pending_authorization` / `requires_more` / status customizado:** ver INV-009. Rejeitadas.
- **Busca por `external_reference = cart_id`, só webhook, replay automático, reuso da chave como cerca:** ver INV-009. Rejeitadas ou adiadas.

## Consequências e trade-offs

- **Migration nova** (tabela do módulo) e **registro do módulo** em `medusa-config.ts`.
- **O payment module passa a declarar `dependencies: ["mercadopagoCardAttempt"]`,** para o provider resolver o serviço. Nunca `id` (ADR-001). Suportado pelo loader 2.20.1 (`register-modules`, `load-internal`) e **comprovado em runtime** por um spike temporário (2026-09-30, [INV-009](../investigations/INV-009-card-ambiguous-order-reconciliation.md#spike-dependency-injection-do-módulo-próprio-2026-09-30)): provider, workflow e webhook resolvem o mesmo singleton, inclusive depois de restart. Restrição: acesso lazy e checagem explícita de presença.
- **A rota de update da session** passa a gravar o token no módulo, e não mais em `data`. As sessions de cartão antigas com `card_token` em `data` precisam de um plano de limpeza (decisão à parte, com autorização para escrita no banco).
- **Troca de cartão bloqueada** durante a indefinição. Se a Order nunca existiu, confirmar executa o cartão já informado.
- **Mudanças que alteram o total do cart ficam bloqueadas** durante a indefinição.
- **O webhook depende de entrega.** Sem ele, a resolução vem pelo cliente ou pelo operador.
- **H2 (retenção) não validada.** Limite de 24 h, com destruição do token nesse prazo.
- **H3 (replay concorrente) fora do escopo.**
- **Sem reconciliação automática em segundo plano;** tentativas com mais de 24 h exigem intervenção manual.
- **Relacionado, não resolvido aqui:** o lock do `completeCart` (2 min) × o pior caso do SDK (~247 s), do lado do pedido Medusa (INV-010, proposta).
