const orderRefundMock = jest.fn()
const orderGetMock = jest.fn()

jest.mock("mercadopago", () => {
  return {
    MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
    Order: jest.fn().mockImplementation(() => ({
      refund: (...args: unknown[]) => orderRefundMock(...args),
      get: (...args: unknown[]) => orderGetMock(...args),
    })),
  }
})

import MercadoPagoPaymentProviderService from "../service"

// What the Payment Module hands to refundPayment in Medusa 2.20.1
// (refundPaymentFromProvider_): payment.data, refund.raw_amount and
// context.idempotency_key = refund.id. raw_amount is the BigNumber raw value
// the MikroORM property stores: { value, precision }.
function buildProvider() {
  const ProviderClass = MercadoPagoPaymentProviderService as any
  return new ProviderClass({}, { access_token: "test-access-token" })
}

// payment.data of a paid Pix charge, as copied from the session at
// authorization.
function pixPaymentData(overrides: Record<string, unknown> = {}) {
  return {
    payment_method_id: "pix",
    amount: "135.00",
    currency_code: "BRL",
    cart_id: "cart_1",
    mercadopago_order_payment_method: "pix",
    mercadopago_order_id: "ORD_PIX_1",
    mercadopago_order_total_amount: "135.00",
    mercadopago_order_status: "processed",
    mercadopago_order_status_detail: "accredited",
    mercadopago_payment_id: "PAY_PIX_1",
    mercadopago_payment_status: "processed",
    mercadopago_status_detail: "accredited",
    mercadopago_idempotency_key: "session-base-key",
    mercadopago_pix_idempotency_key: "pix-create-key",
    mercadopago_pix_generation: 0,
    ...overrides,
  }
}

function refundedOrder(input: {
  status: string
  statusDetail: string
  refunds: Array<{ id: string; amount: string; status?: string }>
}) {
  return {
    id: "ORD_PIX_1",
    status: input.status,
    status_detail: input.statusDetail,
    transactions: {
      payments: [
        {
          id: "PAY_PIX_1",
          status: input.status,
          status_detail: input.statusDetail,
        },
      ],
      refunds: input.refunds.map((refund) => ({
        transaction_id: "PAY_PIX_1",
        status: "processed",
        ...refund,
      })),
    },
  }
}

const RAW_TEN = { value: "10", precision: 20 }

describe("MercadoPagoPaymentProviderService.refundPayment", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("E1 — amount as the Payment Module sends it (BigNumber raw value)", () => {
    it("accepts refund.raw_amount ({ value, precision }) and sends it as a 2-decimal string", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "10.00" }],
        })
      )

      await buildProvider().refundPayment({
        data: pixPaymentData(),
        amount: RAW_TEN,
        context: { idempotency_key: "ref_01A" },
      })

      expect(orderRefundMock).toHaveBeenCalledTimes(1)
      expect(orderRefundMock.mock.calls[0][0].body).toEqual({
        transactions: [{ id: "PAY_PIX_1", amount: "10.00" }],
      })
    })

    it.each([
      ["a number", 10],
      ["a decimal string", "10"],
      ["a raw value with a long precision string", { value: "10.000000000000000000", precision: 20 }],
    ])("accepts %s", async (_label, amount) => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "10.00" }],
        })
      )

      await buildProvider().refundPayment({
        data: pixPaymentData(),
        amount,
        context: { idempotency_key: "ref_01A" },
      })

      expect(orderRefundMock.mock.calls[0][0].body).toEqual({
        transactions: [{ id: "PAY_PIX_1", amount: "10.00" }],
      })
    })

    it.each([
      ["zero", { value: "0", precision: 20 }],
      ["negative", { value: "-5", precision: 20 }],
      ["missing", undefined],
    ])("rejects a %s amount without calling Mercado Pago", async (_label, amount) => {
      await expect(
        buildProvider().refundPayment({
          data: pixPaymentData(),
          amount,
          context: { idempotency_key: "ref_01A" },
        })
      ).rejects.toThrow("Mercado Pago: refund amount must be a positive number.")

      expect(orderRefundMock).not.toHaveBeenCalled()
    })
  })

  describe("E2 — idempotency key per refund (context.idempotency_key = refund.id)", () => {
    it("two refunds of the same Payment use two different keys, the ones Medusa provides", async () => {
      orderRefundMock
        .mockResolvedValueOnce(
          refundedOrder({
            status: "processed",
            statusDetail: "partially_refunded",
            refunds: [{ id: "REF_1", amount: "10.00" }],
          })
        )
        .mockResolvedValueOnce(
          refundedOrder({
            status: "processed",
            statusDetail: "partially_refunded",
            refunds: [
              { id: "REF_1", amount: "10.00" },
              { id: "REF_2", amount: "20.00" },
            ],
          })
        )

      const provider = buildProvider()

      const first = await provider.refundPayment({
        data: pixPaymentData(),
        amount: RAW_TEN,
        context: { idempotency_key: "ref_01A" },
      })
      // The Payment Module stores the returned data on the Payment and hands
      // it back on the next refund.
      await provider.refundPayment({
        data: first.data,
        amount: { value: "20", precision: 20 },
        context: { idempotency_key: "ref_01B" },
      })

      const keys = orderRefundMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey)
      expect(keys).toEqual(["ref_01A", "ref_01B"])
    })

    it("with plain numeric amounts too (independent of E1)", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "10.00" }],
        })
      )

      const provider = buildProvider()
      await provider.refundPayment({
        data: pixPaymentData(),
        amount: 10,
        context: { idempotency_key: "ref_01A" },
      })
      await provider.refundPayment({
        data: pixPaymentData(),
        amount: 20,
        context: { idempotency_key: "ref_01B" },
      })

      const keys = orderRefundMock.mock.calls.map((call) => call[0].requestOptions.idempotencyKey)
      expect(keys).toEqual(["ref_01A", "ref_01B"])
    })

    it("never uses the session base key nor the Pix creation key", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "10.00" }],
        })
      )

      await buildProvider().refundPayment({
        data: pixPaymentData(),
        amount: RAW_TEN,
        context: { idempotency_key: "ref_01A" },
      })

      const key = orderRefundMock.mock.calls[0][0].requestOptions.idempotencyKey
      expect(key).not.toBe("session-base-key")
      expect(key).not.toBe("pix-create-key")
    })

    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["longer than 128 characters", "r".repeat(129)],
    ])("refuses to refund with a %s idempotency key, without calling Mercado Pago", async (_label, key) => {
      await expect(
        buildProvider().refundPayment({
          data: pixPaymentData(),
          amount: RAW_TEN,
          context: key === undefined ? {} : { idempotency_key: key },
        })
      ).rejects.toThrow("Mercado Pago: a unique idempotency key is required to refund the payment.")

      expect(orderRefundMock).not.toHaveBeenCalled()
    })
  })

  describe("total × partial (Orders API contract)", () => {
    it("total: the full payment amount is refunded with no body", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "refunded",
          statusDetail: "refunded",
          refunds: [{ id: "REF_1", amount: "135.00", status: "processing" }],
        })
      )

      const result = await buildProvider().refundPayment({
        data: pixPaymentData(),
        amount: { value: "135", precision: 20 },
        context: { idempotency_key: "ref_01A" },
      })

      const call = orderRefundMock.mock.calls[0][0]
      expect(call).toEqual({
        id: "ORD_PIX_1",
        requestOptions: { idempotencyKey: "ref_01A" },
      })
      expect("body" in call).toBe(false)
      expect(result.data).toEqual(
        expect.objectContaining({
          mercadopago_order_status: "refunded",
          mercadopago_order_status_detail: "refunded",
          mercadopago_refund_id: "REF_1",
          mercadopago_refunded_amount: "135.00",
        })
      )
    })

    it("partial: transactions[{ id: <transactions.payments[].id>, amount }]", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "10.00" }],
        })
      )

      const result = await buildProvider().refundPayment({
        data: pixPaymentData(),
        amount: RAW_TEN,
        context: { idempotency_key: "ref_01A" },
      })

      expect(orderRefundMock).toHaveBeenCalledWith({
        id: "ORD_PIX_1",
        body: { transactions: [{ id: "PAY_PIX_1", amount: "10.00" }] },
        requestOptions: { idempotencyKey: "ref_01A" },
      })
      expect(result.data).toEqual(
        expect.objectContaining({
          mercadopago_order_status: "processed",
          mercadopago_order_status_detail: "partially_refunded",
          mercadopago_refund_id: "REF_1",
          mercadopago_refunded_amount: "10.00",
        })
      )
    })

    it("the remainder after a partial refund is sent as partial (Medusa only allows it when nothing else was refunded)", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "refunded",
          statusDetail: "refunded",
          refunds: [
            { id: "REF_1", amount: "10.00" },
            { id: "REF_2", amount: "125.00" },
          ],
        })
      )

      await buildProvider().refundPayment({
        data: pixPaymentData({ mercadopago_refund_id: "REF_1", mercadopago_refunded_amount: "10.00" }),
        amount: { value: "125", precision: 20 },
        context: { idempotency_key: "ref_01B" },
      })

      expect(orderRefundMock.mock.calls[0][0].body).toEqual({
        transactions: [{ id: "PAY_PIX_1", amount: "125.00" }],
      })
    })

    it("a payment without the stored amount is never refunded as total", async () => {
      const { amount: _omit, ...data } = pixPaymentData()
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "refunded",
          statusDetail: "refunded",
          refunds: [{ id: "REF_1", amount: "135.00" }],
        })
      )

      await buildProvider().refundPayment({
        data,
        amount: { value: "135", precision: 20 },
        context: { idempotency_key: "ref_01A" },
      })

      expect(orderRefundMock.mock.calls[0][0].body).toEqual({
        transactions: [{ id: "PAY_PIX_1", amount: "135.00" }],
      })
    })

    it("partial without the Mercado Pago transaction id is refused before any call", async () => {
      await expect(
        buildProvider().refundPayment({
          data: pixPaymentData({ mercadopago_payment_id: undefined }),
          amount: RAW_TEN,
          context: { idempotency_key: "ref_01A" },
        })
      ).rejects.toThrow("Mercado Pago: mercadopago_payment_id is required for a partial refund.")

      expect(orderRefundMock).not.toHaveBeenCalled()
    })

    it("any refund without the Mercado Pago Order id is refused before any call", async () => {
      await expect(
        buildProvider().refundPayment({
          data: pixPaymentData({ mercadopago_order_id: undefined }),
          amount: { value: "135", precision: 20 },
          context: { idempotency_key: "ref_01A" },
        })
      ).rejects.toThrow("Mercado Pago: mercadopago_order_id is required to refund the payment.")

      expect(orderRefundMock).not.toHaveBeenCalled()
    })

    it("card payments follow the same contract (shared provider method)", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "30.00" }],
        })
      )

      await buildProvider().refundPayment({
        data: {
          payment_method_id: "visa",
          payment_type_id: "credit_card",
          amount: "100.00",
          mercadopago_order_id: "ORD_CARD_1",
          mercadopago_payment_id: "PAY_CARD_1",
          mercadopago_idempotency_key: "card-create-key",
        },
        amount: { value: "30", precision: 20 },
        context: { idempotency_key: "ref_01C" },
      })

      expect(orderRefundMock).toHaveBeenCalledWith({
        id: "ORD_CARD_1",
        body: { transactions: [{ id: "PAY_CARD_1", amount: "30.00" }] },
        requestOptions: { idempotencyKey: "ref_01C" },
      })
    })

    it("does not read the Order before refunding", async () => {
      orderRefundMock.mockResolvedValue(
        refundedOrder({
          status: "processed",
          statusDetail: "partially_refunded",
          refunds: [{ id: "REF_1", amount: "10.00" }],
        })
      )

      await buildProvider().refundPayment({
        data: pixPaymentData(),
        amount: RAW_TEN,
        context: { idempotency_key: "ref_01A" },
      })

      expect(orderGetMock).not.toHaveBeenCalled()
    })
  })

  describe("Mercado Pago errors", () => {
    it("propagates an API error so the Payment Module deletes the Refund record", async () => {
      const apiError = Object.assign(new Error("refund_amount_exceeds"), { status: 400 })
      orderRefundMock.mockRejectedValue(apiError)

      await expect(
        buildProvider().refundPayment({
          data: pixPaymentData(),
          amount: RAW_TEN,
          context: { idempotency_key: "ref_01A" },
        })
      ).rejects.toBe(apiError)
    })
  })
})
