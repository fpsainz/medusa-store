# ADR-004: HMAC do webhook com `data.id` em minúsculas

> Status: aceito · Data: 2026-09-21 · Commits: `823a51f` (tentativa anterior), `81f0a34` (esta decisão)

## Contexto

O `WebhookSignatureValidator` do SDK `mercadopago` 3.6.1 monta o manifesto HMAC com o `dataId` recebido, sem alterar maiúsculas/minúsculas.

Em `823a51f` o projeto passou a enviar `data.id` no case original. Um comentário da época dizia que o PR #439 do SDK (3.2.0) tinha removido o `.toLowerCase()` interno porque o Mercado Pago assina com o case original.

## Decisão

Em `81f0a34`: enviar ao validador **somente** `data.id.toLowerCase()`. Todo o resto (`Order.get`, correlação com a session, payload do evento) usa o valor original.

Motivo, conforme registrado no comentário do código: a documentação de notificações da Orders API exige `data.id` alfanumérico em minúsculas no manifesto, e dois webhooks reais de Orders da aplicação de teste só validaram com a variante minúscula.

## Alternativas consideradas

- Case original (versão `823a51f`): correto para notificações da API de Payments, segundo o mesmo comentário, mas falhou com notificações de Orders.

## Consequências

- Coberto por teste em `route.unit.spec.ts` ("lowercases dataId only for signature validation…").
- Se o projeto passar a receber notificações de outros tipos (por exemplo, Payments clássicos), esta regra precisa ser reavaliada. Hoje o provider processa só `type === 'order'`.
- A referência à documentação oficial e ao PR #439 vem de comentários do código. **[não validado]** diretamente contra a documentação atual do Mercado Pago.
