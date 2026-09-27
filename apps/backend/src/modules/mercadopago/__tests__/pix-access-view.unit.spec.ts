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

describe("toPixAccessDto", () => {
  it("pending before the deadline: payable data only, by allowlist", () => {
    const dto = toPixAccessDto({ session_status: "pending", data: DATA, order_id: "order_1", now: NOW })

    expect(Object.keys(dto).sort()).toEqual(
      ["charge_ref", "expires_at", "order_id", "qr_code", "qr_code_base64", "status", "ticket_url"].sort()
    )
    expect(dto).toEqual(
      expect.objectContaining({
        status: "pending",
        order_id: "order_1",
        qr_code: "000201",
        qr_code_base64: "iVBOR",
        ticket_url: "https://ticket",
        expires_at: "2026-09-27T12:30:00.000Z",
      })
    )
    expect(JSON.stringify(dto)).not.toMatch(FORBIDDEN)
  })

  it("past the deadline: expired, status only, even if Mercado Pago still says action_required", () => {
    const dto = toPixAccessDto({
      session_status: "pending",
      data: DATA,
      order_id: "order_1",
      now: new Date("2026-09-27T12:30:00.000Z"),
    })

    expect(dto).toEqual({ status: "expired", order_id: "order_1" })
  })

  it("approved by Medusa: status only, no payable data", () => {
    expect(toPixAccessDto({ session_status: "authorized", data: DATA, order_id: "order_1", now: NOW })).toEqual({
      status: "approved",
      order_id: "order_1",
    })
  })

  it("approved is kept after the deadline (paid late, webhook delayed)", () => {
    const dto = toPixAccessDto({
      session_status: "pending",
      data: { ...DATA, mercadopago_order_status: "processed" },
      order_id: "order_1",
      now: new Date("2026-09-27T12:40:00.000Z"),
    })

    expect(dto).toEqual({ status: "approved", order_id: "order_1" })
  })

  it("keeps a final Mercado Pago status, status only", () => {
    for (const [mpStatus, expected] of [
      ["canceled", "canceled"],
      ["expired", "expired"],
      ["failed", "failed"],
      ["refunded", "refunded"],
    ]) {
      expect(
        toPixAccessDto({
          session_status: "pending",
          data: { ...DATA, mercadopago_order_status: mpStatus },
          order_id: null,
          now: NOW,
        })
      ).toEqual({ status: expected, order_id: null })
    }
  })

  it("processing (no payable data yet) before the deadline: status only", () => {
    expect(
      toPixAccessDto({
        session_status: "pending",
        data: { ...DATA, mercadopago_order_status: "processing" },
        order_id: "order_1",
        now: NOW,
      })
    ).toEqual({ status: "processing", order_id: "order_1" })
  })

  it("without a known deadline: never exposes payable data", () => {
    const { mercadopago_pix_expires_at: _omit, ...legacy } = DATA
    expect(toPixAccessDto({ session_status: "pending", data: legacy, order_id: "order_1", now: NOW })).toEqual({
      status: "expired",
      order_id: "order_1",
    })
  })
})
