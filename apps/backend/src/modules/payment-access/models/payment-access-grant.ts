import { model } from "@medusajs/framework/utils"

import { PAYMENT_ACCESS_PURPOSES } from "../grants"

// A temporary, read-only capability to follow one payment after checkout
// (ADR-007). Only the SHA-256 of the token is stored; the plaintext token is
// never persisted. It is bound to a Payment Session (and its collection);
// the order is resolved server-side when the capability is read.
const PaymentAccessGrant = model
  .define("payment_access_grant", {
    id: model.id({ prefix: "pag" }).primaryKey(),
    token_hash: model.text(),
    purpose: model.enum([...PAYMENT_ACCESS_PURPOSES]),
    provider_id: model.text(),
    payment_method: model.text(),
    payment_session_id: model.text(),
    payment_collection_id: model.text(),
    // Cart the capability was issued from (issuance context/audit).
    cart_id: model.text(),
    expires_at: model.dateTime(),
    revoked_at: model.dateTime().nullable(),
    revoked_reason: model.text().nullable(),
  })
  .indexes([
    { on: ["token_hash"], unique: true },
    { on: ["payment_session_id"] },
    { on: ["expires_at"] },
  ])

export default PaymentAccessGrant
