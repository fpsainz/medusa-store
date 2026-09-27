import { toPixAccessDto } from "../pix-access-view"

const NOW = new Date("2026-09-27T12:00:00.000Z")

const DATA = {
  payment_method_id: "pix",
  payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
  mercadopago_idempotency_key: "base-key",
  mercadopago_pix_idempotency_key: "pix-key",
  mercadopago_order_id: "ORD_PIX_A",
  mercadopago_payment_id: "PAY_PIX_A",
  mercadopago_order_payment_method: "pix",
  mercadopago_order_status: "action_required",
  mercadopago_order_status_detail: "waiting_transfer",
  mercadopago_pix_qr_code: "000201",
  mercadopago_pix_qr_code_base64: "iVBOR",
  mercadopago_pix_ticket_url: "https://ticket",
  mercadopago_pix_expires_at: "2026-09-27T12:30:00.000Z",
}

const FORBIDDEN = /buyer@example|12345678909|base-key|pix-key|ORD_PIX_A|PAY_PIX_A|action_required|waiting_transfer/

const PAYABLE_KEYS = ["qr_code", "qr_code_base64", "ticket_url", "charge_ref", "expires_at"]

describe("toPixAccessDto", () => {
  it("1. before the deadline: status=pending, window open, QR present (allowlist)", () => {
    const dto = toPixAccessDto({ session_status: "pending", data: DATA, order_id: "order_1", now: NOW })

    expect(Object.keys(dto).sort()).toEqual(
      ["charge_ref", "expires_at", "order_id", "payment_window_closed", "qr_code", "qr_code_base64", "status", "ticket_url"].sort()
    )
    expect(dto).toEqual(
      expect.objectContaining({
        status: "pending",
        payment_window_closed: false,
        order_id: "order_1",
        qr_code: "000201",
        qr_code_base64: "iVBOR",
        ticket_url: "https://ticket",
        expires_at: "2026-09-27T12:30:00.000Z",
      })
    )
    expect(JSON.stringify(dto)).not.toMatch(FORBIDDEN)
  })

  it("2. after the deadline with Mercado Pago still action_required: status stays pending, window closed, no QR", () => {
    const dto = toPixAccessDto({
      session_status: "pending",
      data: DATA,
      order_id: "order_1",
      now: new Date("2026-09-27T12:30:00.000Z"),
    })

    expect(dto).toEqual({ status: "pending", payment_window_closed: true, order_id: "order_1" })
  })

  it("3. Mercado Pago canceled: status canceled (before or after the deadline)", () => {
    const canceled = { ...DATA, mercadopago_order_status: "canceled" }

    expect(toPixAccessDto({ session_status: "pending", data: canceled, order_id: "order_1", now: NOW })).toEqual({
      status: "canceled",
      payment_window_closed: false,
      order_id: "order_1",
    })
    expect(
      toPixAccessDto({ session_status: "pending", data: canceled, order_id: "order_1", now: new Date("2026-09-27T13:00:00.000Z") })
    ).toEqual({ status: "canceled", payment_window_closed: true, order_id: "order_1" })
  })

  it("4. approved/processed: the real status is kept, before and after the deadline", () => {
    const processed = { ...DATA, mercadopago_order_status: "processed" }
    const late = new Date("2026-09-27T12:40:00.000Z")

    expect(toPixAccessDto({ session_status: "authorized", data: DATA, order_id: "order_1", now: NOW })).toEqual({
      status: "approved",
      payment_window_closed: false,
      order_id: "order_1",
    })
    expect(toPixAccessDto({ session_status: "pending", data: processed, order_id: "order_1", now: late })).toEqual({
      status: "approved",
      payment_window_closed: true,
      order_id: "order_1",
    })
  })

  it("keeps every other real Mercado Pago status (expired, failed, refunded) as is", () => {
    for (const mpStatus of ["expired", "failed", "refunded"]) {
      expect(
        toPixAccessDto({ session_status: "pending", data: { ...DATA, mercadopago_order_status: mpStatus }, order_id: null, now: NOW })
      ).toEqual({ status: mpStatus, payment_window_closed: false, order_id: null })
    }
  })

  it("processing (no payable data yet) before the deadline: status only", () => {
    expect(
      toPixAccessDto({ session_status: "pending", data: { ...DATA, mercadopago_order_status: "processing" }, order_id: "order_1", now: NOW })
    ).toEqual({ status: "processing", payment_window_closed: false, order_id: "order_1" })
  })

  it("5. no payable artifact is ever returned after the deadline, whatever the status", () => {
    const after = new Date("2026-09-27T12:31:00.000Z")
    for (const mpStatus of ["action_required", "processing", "processed", "canceled", "expired", "failed"]) {
      for (const sessionStatus of ["pending", "authorized"]) {
        const dto = toPixAccessDto({
          session_status: sessionStatus,
          data: { ...DATA, mercadopago_order_status: mpStatus },
          order_id: "order_1",
          now: after,
        })
        expect(dto.payment_window_closed).toBe(true)
        for (const key of PAYABLE_KEYS) expect(dto).not.toHaveProperty(key)
        expect(JSON.stringify(dto)).not.toMatch(/000201|iVBOR|https:\/\/ticket/)
      }
    }
  })

  it("without a known deadline: window treated as closed, real status kept, nothing payable", () => {
    const { mercadopago_pix_expires_at: _omit, ...legacy } = DATA
    expect(toPixAccessDto({ session_status: "pending", data: legacy, order_id: "order_1", now: NOW })).toEqual({
      status: "pending",
      payment_window_closed: true,
      order_id: "order_1",
    })
  })
})
