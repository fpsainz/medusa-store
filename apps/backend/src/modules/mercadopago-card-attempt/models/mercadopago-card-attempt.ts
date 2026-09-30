import { model } from "@medusajs/framework/utils"

import { CARD_ATTEMPT_STATES, LIVE_CARD_ATTEMPT_STATES_SQL } from "../attempt-states"

// One card authorization attempt against the Mercado Pago Orders API
// (ADR-015, INV-009). It lives outside PaymentSession.data so the card token
// never reaches payment_session/payment data or workflow checkpoints.
// payment_session_id and cart_id belong to other modules: plain text, no
// foreign keys, and the attempt outlives a deleted payment session (audit).
const MercadopagoCardAttempt = model
  .define("mercadopago_card_attempt", {
    id: model.id({ prefix: "mpca" }).primaryKey(),
    payment_session_id: model.text(),
    cart_id: model.text(),
    state: model.enum([...CARD_ATTEMPT_STATES]),
    // `${cart_id}-${ULID of id}`, sent to Mercado Pago as external_reference.
    external_reference: model.text(),
    // SHA-256 of the canonical Orders API body, set when authorization starts.
    body_sha256: model.text().nullable(),
    // Encrypted envelope of the card token; null once destroyed.
    encrypted_card_token: model.text().nullable(),
    token_destroyed_at: model.dateTime().nullable(),
    mercadopago_order_id: model.text().nullable(),
    // Error class of the last Orders API call (no message, no body).
    last_error_class: model.text().nullable(),
    // First POST /v1/orders of the attempt: start of the replay window.
    authorization_started_at: model.dateTime().nullable(),
    // Last entry into `authorizing`: detects an attempt stuck there.
    authorizing_at: model.dateTime().nullable(),
    // Entry into a terminal state: start of the retention period.
    ended_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      name: "IDX_mercadopago_card_attempt_one_live_per_session",
      on: ["payment_session_id"],
      unique: true,
      where: LIVE_CARD_ATTEMPT_STATES_SQL,
    },
    { on: ["payment_session_id"] },
    { on: ["external_reference"], unique: true },
    {
      name: "IDX_mercadopago_card_attempt_mp_order_unique",
      on: ["mercadopago_order_id"],
      unique: true,
      where: "mercadopago_order_id IS NOT NULL",
    },
    { on: ["state"] },
  ])

export default MercadopagoCardAttempt
