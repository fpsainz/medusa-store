---
name: integration-testing
description: Use when testing the real Medusa storefront and Mercado Pago integration with Playwright, browser/network debugging, integration tests, or end-to-end checkout validation.
---

# Integration and E2E Testing

Use this skill to validate the real user journey in this repository with Playwright, browser diagnostics, and focused integration checks.

## Real E2E contract

Start from a clean browser session and follow the UI in order:

`store -> product -> variant -> add to cart -> cart -> checkout -> shipping -> Mercado Pago -> Card Payment Brick -> Secure Fields -> tokenization -> PaymentSession -> review -> completeCart -> authorizePayment -> Orders API -> paid -> Medusa order -> order confirmed`

Do not create a cart, PaymentSession, payment, or order through an API before the real-UX test. Do not skip the product, variant selection, cart, or checkout pages.

## Playwright procedure

1. Confirm backend and storefront readiness without changing application code.
2. Use a clean browser context when the test requires a clean cart; do not rely on a prepared checkout.
3. Capture the product handle, selected variant, quantity, displayed price, currency, and cart identifier.
4. At checkout, capture shipping completion and the selected provider.
5. Observe Card Payment Brick rendering, Secure Fields frames, `onReady`, `onError`, `onSubmit`, and the review gate.
6. Capture request/response status for Medusa cart, payment-session, completion, provider authorization, and Mercado Pago calls.
7. Never print full card numbers, CVV, tokens, access tokens, public credentials, or personal secrets.
8. Stop at the first failure. Do not patch code and continue within the same failure run.

## Browser and network debugging

Inspect `requestfailed`, response status, console errors, page errors, frame tree, iframe URLs, origin, referer when relevant, CSP/security-policy messages, mixed-content warnings, and browser privacy or network blocking. Do not assume a CORS problem for iframe failures.

For `The integration with Secure Fields failed`, determine whether the iframe was blocked, aborted by a component remount, rejected by browser policy, or returned an SDK error. For `no_payment_method_for_provided_bin`, verify the official sandbox card, site ID, country, public key, and `payment_methods/search` response before changing code.

## Assertions

For a successful real run, assert:

- exactly one intended line item and quantity;
- expected variant and BRL amount;
- shipping method selected;
- Mercado Pago PaymentSession pending before tokenization;
- Secure Fields loaded and Brick ready;
- tokenization and payment-session update succeeded;
- review and cart completion succeeded;
- provider authorization reached Orders API;
- Mercado Pago status is `paid`;
- Medusa order and confirmation page match the cart.

For a failed run, report the first failing stage, endpoint, HTTP status, error, cart ID, PaymentSession status, and payment status. Do not report sensitive payment values.
