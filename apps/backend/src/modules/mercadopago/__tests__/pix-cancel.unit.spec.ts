import { createHash } from "node:crypto"

const orderGetMock = jest.fn()
const orderCancelMock = jest.fn()
const orderCreateMock = jest.fn()

jest.mock("mercadopago", () => {
  return {
    MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
    Order: jest.fn().mockImplementation(() => ({
      get: (...args: unknown[]) => orderGetMock(...args),
      cancel: (...args: unknown[]) => orderCancelMock(...args),
      create: (...args: unknown[]) => orderCreateMock(...args),
    })),
  }
})

import MercadoPagoPaymentProviderService from "../service"

// The orderCanceled hook reaches the provider through
// paymentModule.updatePaymentSession with the transient action "cancel"
// (ADR-012). These tests exercise that provider path.
function buildProvider() {
  const ProviderClass = MercadoPagoPaymentProviderService as any
  return new ProviderClass({}, { access_token: "test-access-token" })
}

function pendingPixSessionData(overrides: Record<string, unknown> = {}) {
  return {
    payment_method_id: "pix",
    amount: "110.00",
    currency_code: "BRL",
    cart_id: "cart_1",
    payer: { email: "buyer@example.com" },
    mercadopago_order_payment_method: "pix",
    mercadopago_order_id: "ORD_PIX_1",
    mercadopago_order_total_amount: "110.00",
    mercadopago_order_status: "action_required",
    mercadopago_order_status_detail: "waiting_transfer",
    mercadopago_payment_id: "PAY_PIX_1",
    mercadopago_payment_status: "action_required",
    mercadopago_status_detail: "waiting_transfer",
    mercadopago_pix_qr_code: "qr",
    mercadopago_pix_ticket_url: "https://ticket",
    mercadopago_idempotency_key: "session-base-key",
    mercadopago_pix_idempotency_key: "pix-create-key",
    mercadopago_pix_generation: 0,
    ...overrides,
  }
}

function mpOrder(status: string, statusDetail: string, paymentStatus = status, paymentDetail = statusDetail) {
  return {
    id: "ORD_PIX_1",
    status,
    status_detail: statusDetail,
    total_amount: "110.00",
    transactions: {
      payments: [{ id: "PAY_PIX_1", status: paymentStatus, status_detail: paymentDetail }],
    },
  }
}

function cancelInput(data: Record<string, unknown>) {
  return { amount: 110, currency_code: "brl", data: { ...data, mercadopago_pix_action: "cancel" } }
}

describe("updatePayment with mercadopago_pix_action 'cancel' (order cancellation)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("pending Pix (action_required/waiting_transfer): reads the Order, cancels it and ends the session canceled", async () => {
    orderGetMock.mockResolvedValue(mpOrder("action_required", "waiting_transfer"))
    orderCancelMock.mockResolvedValue(mpOrder("canceled", "canceled", "canceled", "canceled_by_api"))

    const result = await buildProvider().updatePayment(cancelInput(pendingPixSessionData()))

    expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_PIX_1" })
    expect(orderCancelMock).toHaveBeenCalledTimes(1)
    expect(orderCancelMock).toHaveBeenCalledWith({
      id: "ORD_PIX_1",
      requestOptions: {
        idempotencyKey: createHash("sha256").update("pix-create-key:cancel").digest("hex"),
      },
    })
    expect(result.status).toBe("canceled")
    expect(result.data).toEqual(
      expect.objectContaining({
        mercadopago_order_id: "ORD_PIX_1",
        mercadopago_order_status: "canceled",
        mercadopago_order_status_detail: "canceled",
        mercadopago_payment_status: "canceled",
        mercadopago_status_detail: "canceled_by_api",
      })
    )
    expect(result.data).not.toHaveProperty("mercadopago_pix_action")
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("the cancellation key is stable for the same charge (retry) and never a creation, session or refund key", async () => {
    orderGetMock.mockResolvedValue(mpOrder("action_required", "waiting_transfer"))
    orderCancelMock.mockResolvedValue(mpOrder("canceled", "canceled"))

    const provider = buildProvider()
    await provider.updatePayment(cancelInput(pendingPixSessionData()))
    await provider.updatePayment(cancelInput(pendingPixSessionData()))

    const keys = orderCancelMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).not.toBe("pix-create-key")
    expect(keys[0]).not.toBe("session-base-key")
  })

  it("paid Pix (processed/accredited): throws NOT_ALLOWED and does not cancel on Mercado Pago", async () => {
    orderGetMock.mockResolvedValue(mpOrder("processed", "accredited"))

    await expect(buildProvider().updatePayment(cancelInput(pendingPixSessionData()))).rejects.toMatchObject({
      type: "not_allowed",
      message: "Mercado Pago: this Pix charge has already been paid and cannot be discarded.",
    })
    expect(orderCancelMock).not.toHaveBeenCalled()
  })

  it.each([
    ["expired", "expired"],
    ["canceled", "canceled"],
    ["failed", "failed"],
    ["refunded", "refunded"],
  ])("Order already %s: no cancel call, session ends canceled with the real status", async (status, detail) => {
    orderGetMock.mockResolvedValue(mpOrder(status, detail))

    const result = await buildProvider().updatePayment(cancelInput(pendingPixSessionData()))

    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(result.status).toBe("canceled")
    expect(result.data.mercadopago_order_status).toBe(status)
  })

  it("an unrecognized Order status throws UNEXPECTED_STATE and does not cancel (invariant 9)", async () => {
    orderGetMock.mockResolvedValue(mpOrder("mystery_status", "mystery"))

    await expect(buildProvider().updatePayment(cancelInput(pendingPixSessionData()))).rejects.toMatchObject({
      type: "unexpected_state",
      message: 'Mercado Pago: unrecognized Pix order status "mystery_status".',
    })
    expect(orderCancelMock).not.toHaveBeenCalled()
  })

  it("a Mercado Pago refusal (409 cannot_cancel_order) propagates", async () => {
    orderGetMock.mockResolvedValue(mpOrder("action_required", "waiting_transfer"))
    const apiError = Object.assign(new Error("cannot_cancel_order"), { status: 409 })
    orderCancelMock.mockRejectedValue(apiError)

    await expect(buildProvider().updatePayment(cancelInput(pendingPixSessionData()))).rejects.toBe(apiError)
  })

  it("a failed Order read propagates, without cancelling blindly", async () => {
    const apiError = Object.assign(new Error("order_not_found"), { status: 404 })
    orderGetMock.mockRejectedValue(apiError)

    await expect(buildProvider().updatePayment(cancelInput(pendingPixSessionData()))).rejects.toBe(apiError)
    expect(orderCancelMock).not.toHaveBeenCalled()
  })

  it("a Pix session without a Mercado Pago Order: nothing to cancel, no call, status unchanged", async () => {
    const data = pendingPixSessionData()
    for (const key of Object.keys(data)) {
      if (key.startsWith("mercadopago_") && key !== "mercadopago_idempotency_key") {
        delete (data as Record<string, unknown>)[key]
      }
    }

    const result = await buildProvider().updatePayment(cancelInput(data))

    expect(orderGetMock).not.toHaveBeenCalled()
    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(result.status).toBeUndefined()
  })

  it("a card session is refused before any call", async () => {
    await expect(
      buildProvider().updatePayment(
        cancelInput({
          payment_method_id: "visa",
          payment_type_id: "credit_card",
          card_token: "tok",
          amount: "110.00",
          mercadopago_order_id: "ORD_CARD_1",
        })
      )
    ).rejects.toThrow("Mercado Pago: the payment session is not a Pix payment.")
    expect(orderGetMock).not.toHaveBeenCalled()
    expect(orderCancelMock).not.toHaveBeenCalled()
  })
})
