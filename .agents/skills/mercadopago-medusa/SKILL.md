---
name: mercadopago-medusa
description: Use when integrating or debugging Mercado Pago with Medusa.js v2.20.1, Checkout Transparente, Card Payment Brick, Secure Fields, PaymentSession, or Mercado Pago Orders API in this repository.
---

# Mercado Pago + Medusa.js

Use this skill for the existing Mercado Pago integration: Checkout Transparente, Card Payment Brick, Secure Fields, Medusa payment sessions, automatic capture, and Mercado Pago Orders API.

## Source of truth

1. Consult the official Mercado Pago Developer documentation first for Card Payment Brick, Secure Fields, sandbox cards, Orders API, tokenization, and browser requirements.
2. Use the Mercado Pago MCP when it is available to search current documentation or validate an integration. Report which MCP calls were used.
3. Consult official Medusa 2.x documentation for payment checkout lifecycle and custom payment-provider contracts.
4. Inspect the installed SDK version and repository code before changing behavior. Do not invent endpoints, fields, callbacks, or methods.

## Expected lifecycle

Keep these stages explicit and ordered:

`product -> variant -> cart -> checkout -> shipping -> payment session -> Card Payment Brick -> token -> payment-session update -> review -> complete cart -> authorize payment -> Mercado Pago Orders API -> paid -> Medusa order`

Updating a PaymentSession must not authorize or capture a payment. Authorization belongs to the configured Medusa provider lifecycle and must use the existing idempotency and correlation rules.

## Card Payment Brick

- Initialize with the configured public key, the correct locale, and a numeric cart amount.
- Pass payer data only from the current cart or checkout state.
- Keep initialization, customization, and callbacks stable during the Brick lifecycle.
- With `@mercadopago/sdk-react` 1.0.7, remember that changing Brick props can trigger an internal unmount and remount. When initialization changes, explicitly follow the SDK's documented unmount/update lifecycle.
- Treat `fields_setup_failed` / `The integration with Secure Fields failed` as a rendering or iframe lifecycle failure, not as a card BIN failure.
- Distinguish Secure Fields failures from `no_payment_method_for_provided_bin`, token creation failures, and Orders API errors.

## Diagnostics

Capture browser request failures, response status, console errors, page errors, frame URLs, origin, CSP or security-policy messages, and whether the external iframe reached `onReady`. Never log full card numbers, CVV, tokens, access tokens, or private keys.

Compare prepared-checkout and real-UX runs by URL, origin, cart total, payment session, initialization amount, payer, provider selection, render timing, React remounts, cookies, and iframe lifecycle.

## Boundaries

- Do not change Orders API, provider authorization, completeCart, webhook, database, credentials, or dependencies while diagnosing a Brick failure unless explicitly requested.
- Do not retry with arbitrary cards. Use only official Mercado Pago sandbox data for the correct site and country.
- Stop at the first failing stage and record endpoint, HTTP status, error, cart state, PaymentSession state, and payment state.
