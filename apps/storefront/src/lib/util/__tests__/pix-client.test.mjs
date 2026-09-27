// Run with `pnpm test` in apps/storefront (node --test, no extra
// dependencies; needs Node >= 22.12 for TypeScript type stripping).
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  readIssuedPaymentAccess,
  splitPixAccessView,
  toClientPixCharge,
} from "../pix-client.ts"

const TOKEN = `pat_${"A".repeat(43)}`
const NOW = new Date("2026-09-27T12:00:00.000Z")

function headersOf(entries) {
  const headers = new Headers(entries)
  return headers
}

describe("toClientPixCharge (what reaches a Client Component)", () => {
  it("keeps only the allowlisted Pix fields", () => {
    const charge = toClientPixCharge({
      status: "pending",
      charge_ref: "abc123",
      qr_code: "000201",
      qr_code_base64: "iVBOR",
      ticket_url: "https://ticket",
      expires_at: "2026-09-27T13:00:00.000Z",
      order_id: "order_1",
      token: TOKEN,
      payment_access_token: TOKEN,
      mercadopago_order_id: "ORD_PIX_A",
      payer: { email: "buyer@example.com" },
    })

    assert.deepEqual(Object.keys(charge).sort(), [
      "charge_ref",
      "expires_at",
      "qr_code",
      "qr_code_base64",
      "status",
      "ticket_url",
    ])
    assert.doesNotMatch(JSON.stringify(charge), /pat_|order_1|ORD_PIX_A|buyer@example/)
  })

  it("passes payment_window_closed only as the boolean true", () => {
    assert.equal(toClientPixCharge({ status: "pending", payment_window_closed: true }).payment_window_closed, true)
    assert.equal("payment_window_closed" in toClientPixCharge({ status: "pending", payment_window_closed: "true" }), false)
    assert.equal("payment_window_closed" in toClientPixCharge({ status: "pending" }), false)
  })

  it("never lets a non-string value through and maps unknown statuses to unknown", () => {
    assert.deepEqual(toClientPixCharge({ status: "hacked", qr_code: { nested: TOKEN } }), { status: "unknown" })
    assert.deepEqual(toClientPixCharge(null), { status: "unknown" })
  })
})

describe("readIssuedPaymentAccess (capability from the prepare response headers)", () => {
  it("reads a well-formed, unexpired capability", () => {
    const access = readIssuedPaymentAccess(
      headersOf({
        "x-payment-access-token": TOKEN,
        "x-payment-access-expires-at": "2026-09-27T13:15:00.000Z",
      }),
      NOW
    )

    assert.equal(access?.token, TOKEN)
    assert.equal(access?.expiresAt.toISOString(), "2026-09-27T13:15:00.000Z")
  })

  it("ignores missing, malformed or expired capabilities", () => {
    for (const entries of [
      {},
      { "x-payment-access-token": TOKEN },
      { "x-payment-access-token": "not-a-token", "x-payment-access-expires-at": "2026-09-27T13:15:00.000Z" },
      { "x-payment-access-token": TOKEN, "x-payment-access-expires-at": "invalid" },
      { "x-payment-access-token": TOKEN, "x-payment-access-expires-at": "2026-09-27T11:59:59.000Z" },
    ]) {
      assert.equal(readIssuedPaymentAccess(headersOf(entries), NOW), null)
    }
  })
})

describe("splitPixAccessView (capability read on the server)", () => {
  it("separates order_id (server-only) from what the client may see", () => {
    const { orderId, charge } = splitPixAccessView({
      status: "approved",
      order_id: "order_1",
      token: TOKEN,
    })

    assert.equal(orderId, "order_1")
    assert.deepEqual(charge, { status: "approved" })
  })

  it("after the deadline: real status + window flag reach the client, nothing payable", () => {
    const { orderId, charge } = splitPixAccessView({
      status: "pending",
      payment_window_closed: true,
      order_id: "order_1",
    })

    assert.equal(orderId, "order_1")
    assert.deepEqual(charge, { status: "pending", payment_window_closed: true })
  })

  it("before the deadline: window open is simply absent on the client, QR kept", () => {
    const { charge } = splitPixAccessView({
      status: "pending",
      payment_window_closed: false,
      order_id: "order_1",
      qr_code: "000201",
    })

    assert.deepEqual(charge, { status: "pending", qr_code: "000201" })
  })

  it("treats a missing order_id as null", () => {
    assert.equal(splitPixAccessView({ status: "pending" }).orderId, null)
  })
})
