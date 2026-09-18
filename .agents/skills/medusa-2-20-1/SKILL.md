---
name: medusa-2-20-1
description: Use when working on Medusa.js v2.20.1 backend, Store API, modules, workflows, payment sessions, regions, carts, checkout, or Medusa customizations in this repository.
---

# Medusa.js v2.20.1

Use this skill for Medusa.js work in this repository. The target version is exactly 2.20.1; preserve the existing monorepo structure and APIs.

## Required approach

1. Inspect the owning Medusa module, route, workflow, provider, or storefront data function before editing.
2. Verify the installed Medusa package versions and read the local implementation and types before relying on memory.
3. Consult official Medusa 2.x documentation when behavior is version-sensitive. Do not invent endpoints, lifecycle methods, fields, or provider contracts.
4. Preserve existing regions, sales channels, currencies, products, prices, inventory, database data, and environment configuration.
5. Keep changes narrow and validate with the smallest relevant TypeScript, lint, integration, or browser check.

## Checkout and payments

- Treat cart, payment collection, payment session, authorization, capture, completion, and order creation as separate lifecycle stages.
- Do not authorize a payment while merely updating a payment session.
- Respect the Medusa payment provider contract and the configured automatic or manual capture mode.
- Correlate external payment data with the Medusa cart and payment session using existing project identifiers and idempotency behavior.
- Never change payment lifecycle code speculatively when the failure is in the storefront or external SDK.

## Safety boundaries

- Do not modify credentials, secrets, Supabase data, migrations, dependencies, or unrelated integrations without explicit authorization.
- Do not reset, seed, or mutate the database during diagnosis unless explicitly requested.
- Do not revert user changes or reorganize existing `.agents/` resources or `skills-lock.json`.
- For a failing behavior, first record the endpoint, status, error, cart state, payment-session state, and first failing stage.

## Validation

Prefer focused checks in this order: a behavior-scoped test, a narrow integration test, a TypeScript check, then lint. For checkout changes, validate the real user path from product and cart through checkout before using a prepared cart.
