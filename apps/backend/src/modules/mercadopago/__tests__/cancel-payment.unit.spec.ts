const orderCreateMock = jest.fn()
const orderGetMock = jest.fn()
const orderCancelMock = jest.fn()
const orderRefundMock = jest.fn()

jest.mock("mercadopago", () => {
  return {
    MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
    Order: jest.fn().mockImplementation(() => ({
      create: (...args: unknown[]) => orderCreateMock(...args),
      get: (...args: unknown[]) => orderGetMock(...args),
      cancel: (...args: unknown[]) => orderCancelMock(...args),
      refund: (...args: unknown[]) => orderRefundMock(...args),
    })),
  }
})

import { cardInput, createFakeCardAttempts, type FakeCardAttempts } from "../__fixtures__/fake-card-attempts"
import MercadoPagoPaymentProviderService from "../service"

// The session's base key: set by initiatePayment from the id the Payment
// Module passes as context.idempotency_key (the payment session id).
const BASE_KEY = "payses_01BASEKEY"
// What paymentModule.cancelPayment passes as context.idempotency_key.
const PAYMENT_ID = "pay_01PAYMENT"

let attempts: FakeCardAttempts

function buildProvider() {
  const ProviderClass = MercadoPagoPaymentProviderService as any
  return new ProviderClass({ mercadopagoCardAttempt: attempts }, { access_token: "test-access-token" })
}

// payment.data of an authorized card payment, as copied from the session.
function cardPaymentData(overrides: Record<string, unknown> = {}) {
  return {
    payment_method_id: "visa",
    payment_type_id: "credit_card",
    amount: "50.00",
    currency_code: "BRL",
    cart_id: "cart_1",
    card_attempt_id: "mpca_01ATTEMPT",
    mercadopago_order_id: "ORD_CARD_1",
    mercadopago_payment_id: "PAY_CARD_1",
    mercadopago_order_status: "action_required",
    mercadopago_order_status_detail: "waiting_capture",
    mercadopago_idempotency_key: BASE_KEY,
    ...overrides,
  }
}

function canceledOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "ORD_CARD_1",
    status: "canceled",
    status_detail: "canceled",
    transactions: {
      payments: [{ id: "PAY_CARD_1", status: "canceled", status_detail: "canceled_transaction" }],
    },
    ...overrides,
  }
}

function sentCancelKeys(): string[] {
  return orderCancelMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey)
}

beforeEach(() => {
  jest.clearAllMocks()
  attempts = createFakeCardAttempts()
})

describe("MercadoPagoPaymentProviderService.cancelPayment", () => {
  it("refuses without mercadopago_order_id and never calls the Orders API", async () => {
    const { mercadopago_order_id: _orderId, ...data } = cardPaymentData()

    await expect(
      buildProvider().cancelPayment({ data, context: { idempotency_key: PAYMENT_ID } })
    ).rejects.toMatchObject({
      type: "invalid_data",
      message: "Mercado Pago: mercadopago_order_id is required to cancel the payment.",
    })

    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(orderGetMock).not.toHaveBeenCalled()
  })

  it("sends POST /v1/orders/{id}/cancel with exactly the base key, not the payment id from the context", async () => {
    orderCancelMock.mockResolvedValue(canceledOrder())

    await buildProvider().cancelPayment({
      data: cardPaymentData(),
      context: { idempotency_key: PAYMENT_ID },
    })

    expect(orderCancelMock).toHaveBeenCalledTimes(1)
    expect(orderCancelMock).toHaveBeenCalledWith({
      id: "ORD_CARD_1",
      requestOptions: { idempotencyKey: BASE_KEY },
    })
    expect(orderCreateMock).not.toHaveBeenCalled()
    expect(orderGetMock).not.toHaveBeenCalled()
    expect(orderRefundMock).not.toHaveBeenCalled()
  })

  it("falls back to context.idempotency_key when the data has no base key", async () => {
    orderCancelMock.mockResolvedValue(canceledOrder())
    const { mercadopago_idempotency_key: _base, ...data } = cardPaymentData()

    await buildProvider().cancelPayment({ data, context: { idempotency_key: PAYMENT_ID } })

    expect(sentCancelKeys()).toEqual([PAYMENT_ID])
  })

  it("a repeated call with the same input sends the same request (same Order, same key)", async () => {
    orderCancelMock.mockResolvedValue(canceledOrder())
    const provider = buildProvider()
    const input = { data: cardPaymentData(), context: { idempotency_key: PAYMENT_ID } }

    await provider.cancelPayment(input)
    await provider.cancelPayment(input)

    expect(orderCancelMock).toHaveBeenCalledTimes(2)
    expect(orderCancelMock.mock.calls[0][0]).toEqual(orderCancelMock.mock.calls[1][0])
  })

  it("returns the payment data with the Order status of the response, keeping every other field", async () => {
    orderCancelMock.mockResolvedValue(canceledOrder())
    const data = cardPaymentData()

    const result = await buildProvider().cancelPayment({ data, context: { idempotency_key: PAYMENT_ID } })

    expect(result).toEqual({
      data: {
        ...data,
        mercadopago_order_id: "ORD_CARD_1",
        mercadopago_order_status: "canceled",
        mercadopago_order_status_detail: "canceled",
      },
    })
  })

  it("keeps the requested Order id when the response has none", async () => {
    orderCancelMock.mockResolvedValue(canceledOrder({ id: undefined }))

    const result = await buildProvider().cancelPayment({
      data: cardPaymentData(),
      context: { idempotency_key: PAYMENT_ID },
    })

    expect(result.data.mercadopago_order_id).toBe("ORD_CARD_1")
  })

  it("propagates an Orders API error (e.g. an Order already processed) and returns no data", async () => {
    const apiError = Object.assign(new Error("order cannot be canceled"), { status: 409 })
    orderCancelMock.mockRejectedValue(apiError)

    await expect(
      buildProvider().cancelPayment({ data: cardPaymentData(), context: { idempotency_key: PAYMENT_ID } })
    ).rejects.toBe(apiError)

    expect(orderCancelMock).toHaveBeenCalledTimes(1)
  })

  it("never touches the card attempt module (INV-009): no read, transition or token access", async () => {
    orderCancelMock.mockResolvedValue(canceledOrder())

    await buildProvider().cancelPayment({
      data: cardPaymentData(),
      context: { idempotency_key: PAYMENT_ID },
    })

    for (const [name, member] of Object.entries(attempts)) {
      if (jest.isMockFunction(member)) {
        expect({ name, calls: member.mock.calls.length }).toEqual({ name, calls: 0 })
      }
    }
  })
})

// Invariant 48: the session's base key is sent raw only by cancelPayment.
// Every other write to the Orders API uses a key derived from it (card and
// Pix creation, Pix cancellation) or the refund id, so reusing the base key
// for the cancellation never collides with another operation.
describe("invariant 48 — the raw base key is sent only by cancelPayment", () => {
  function pendingPixOrder() {
    return {
      id: "ORD_PIX_1",
      status: "action_required",
      status_detail: "waiting_transfer",
      total_amount: "50.00",
      transactions: {
        payments: [
          {
            id: "PAY_PIX_1",
            status: "action_required",
            status_detail: "waiting_transfer",
            payment_method: { qr_code: "qr", qr_code_base64: "b64", ticket_url: "https://ticket" },
          },
        ],
      },
    }
  }

  it("card creation, Pix creation, Pix cancellation and refund never send the base key; cancelPayment does", async () => {
    const provider = buildProvider()

    // Card Order creation (ADR-014: key derived from the base key and body).
    orderCreateMock.mockResolvedValueOnce({
      id: "ORD_CARD_1",
      status: "processed",
      status_detail: "accredited",
      transactions: { payments: [{ id: "PAY_CARD_1", status: "processed", status_detail: "accredited" }] },
    })
    await provider.authorizePayment(
      cardInput(attempts, {
        payment_method_id: "visa",
        payment_type_id: "credit_card",
        card_token: "card_token_abc",
        installments: 1,
        amount: "50.00",
        cart_id: "cart_1",
        payer: { email: "buyer@example.com" },
        mercadopago_idempotency_key: BASE_KEY,
      })
    )

    // Pix Order creation (derived: base key + amount + generation).
    orderCreateMock.mockResolvedValueOnce(pendingPixOrder())
    const prepared = await provider.updatePayment({
      amount: 50,
      currency_code: "brl",
      data: {
        payment_method_id: "pix",
        cart_id: "cart_1",
        payer: { email: "buyer@example.com" },
        mercadopago_idempotency_key: BASE_KEY,
        mercadopago_pix_action: "prepare",
      },
    })

    // Pix cancellation on order cancel (derived: sha256(<pix key>:cancel)).
    orderGetMock.mockResolvedValueOnce(pendingPixOrder())
    orderCancelMock.mockResolvedValueOnce({ ...pendingPixOrder(), status: "canceled", status_detail: "canceled" })
    await provider.updatePayment({
      amount: 50,
      currency_code: "brl",
      data: { ...prepared.data, mercadopago_pix_action: "cancel" },
    })

    // Refund (refund.id from the Payment Module).
    orderRefundMock.mockResolvedValueOnce({
      id: "ORD_CARD_1",
      status: "refunded",
      status_detail: "refunded",
      transactions: {
        payments: [{ id: "PAY_CARD_1", status: "refunded", status_detail: "refunded" }],
        refunds: [{ id: "REF_1", amount: "50.00" }],
      },
    })
    await provider.refundPayment({
      data: cardPaymentData({ mercadopago_order_status: "processed" }),
      amount: 50,
      context: { idempotency_key: "ref_01REFUND" },
    })

    const otherWriteKeys = [
      ...orderCreateMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey),
      ...orderCancelMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey),
      ...orderRefundMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey),
    ]

    expect(orderCreateMock).toHaveBeenCalledTimes(2)
    expect(orderCancelMock).toHaveBeenCalledTimes(1)
    expect(orderRefundMock).toHaveBeenCalledTimes(1)
    expect(otherWriteKeys).toHaveLength(4)
    for (const key of otherWriteKeys) {
      expect(typeof key).toBe("string")
      expect(key).not.toBe(BASE_KEY)
    }
    expect(new Set(otherWriteKeys).size).toBe(4)

    // The payment cancellation is the only write that sends it raw.
    orderCancelMock.mockResolvedValueOnce(canceledOrder())
    await provider.cancelPayment({ data: cardPaymentData(), context: { idempotency_key: PAYMENT_ID } })

    expect(sentCancelKeys().at(-1)).toBe(BASE_KEY)
  })
})
