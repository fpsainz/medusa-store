import { ContainerRegistrationKeys, Modules, PaymentWebhookEvents } from "@medusajs/framework/utils"

const validateMock = jest.fn()
const orderGetMock = jest.fn()
const mercadoPagoConfigMock = jest.fn()

// `function` (not `class`) so the declaration is fully hoisted above the
// `jest.mock` factory below, which Jest itself hoists to the top of the file.
// Called without `new` (see usage below) — it builds and returns the error itself.
function FakeInvalidWebhookSignatureError(reason: string): Error & { reason: string } {
  const err = new Error(`Invalid webhook signature: ${reason}`) as Error & { reason: string }
  // Links `err` into FakeInvalidWebhookSignatureError's prototype chain so that
  // route.ts's `err instanceof InvalidWebhookSignatureError` check (against this
  // same mocked export) matches, exactly like the real SDK class would.
  Object.setPrototypeOf(err, FakeInvalidWebhookSignatureError.prototype)
  err.name = "InvalidWebhookSignatureError"
  err.reason = reason
  return err
}

jest.mock("mercadopago", () => {
  return {
    WebhookSignatureValidator: {
      validate: (...args: unknown[]) => validateMock(...args),
    },
    InvalidWebhookSignatureError: FakeInvalidWebhookSignatureError,
    MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => {
      mercadoPagoConfigMock(...args)
      return {}
    }),
    Order: jest.fn().mockImplementation(() => ({
      get: (...args: unknown[]) => orderGetMock(...args),
    })),
  }
})

import { POST } from "../route"
import MercadoPagoPaymentProviderService from "../../../../../modules/mercadopago/service"

const WEBHOOK_SECRET = "test-secret"
const ACCESS_TOKEN = "test-access-token"
const VALID_SIGNATURE = "ts=1700000000,v1=abcdef"
const VALID_REQUEST_ID = "req-123"

describe("mercadopago webhook route override", () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      MERCADOPAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADOPAGO_ACCESS_TOKEN: ACCESS_TOKEN,
    }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  function buildReq(overrides: Partial<Record<string, unknown>> = {}) {
    const emit = jest.fn(async () => undefined)
    const graph = jest.fn(async () => ({
      data: [{ id: "cart_123", payment_collection: { id: "paycol_123" } }],
    }))
    const listPaymentSessions = jest.fn(async (): Promise<unknown[]> => [
      {
        id: "payses_123",
        provider_id: "pp_mercadopago",
        status: "pending",
        data: { mercadopago_order_id: "789012" },
      },
    ])
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

    const scopeState = {
      emit,
      graph,
      listPaymentSessions,
      logger,
      paymentOptions: { webhook_delay: 5000, webhook_retries: 3 },
      ...overrides.scopeState as Record<string, unknown>,
    }

    const req: any = {
      params: { provider: "mercadopago" },
      query: { "data.id": "789012" },
      headers: {
        "x-signature": VALID_SIGNATURE,
        "x-request-id": VALID_REQUEST_ID,
      },
      body: { type: "order", action: "order.processed", data: { id: "789012" } },
      rawBody: Buffer.from('{"type":"order"}'),
      scope: {
        resolve: (key: string) => {
          if (key === Modules.PAYMENT) {
            return {
              options: scopeState.paymentOptions,
              listPaymentSessions: scopeState.listPaymentSessions,
            }
          }
          if (key === Modules.EVENT_BUS) {
            return { emit: scopeState.emit }
          }
          if (key === ContainerRegistrationKeys.QUERY) {
            return { graph: scopeState.graph }
          }
          if (key === ContainerRegistrationKeys.LOGGER) {
            return scopeState.logger
          }
          throw new Error(`Unexpected container key: ${key}`)
        },
      },
      ...overrides,
    }

    return { req, emit, graph, listPaymentSessions, logger }
  }

  function buildRes() {
    const res: any = {
      statusCode: undefined as number | undefined,
      body: undefined as unknown,
      sendStatus: jest.fn(function (this: any, code: number) {
        this.statusCode = code
        return this
      }),
      status: jest.fn(function (this: any, code: number) {
        this.statusCode = code
        return this
      }),
      send: jest.fn(function (this: any, body: unknown) {
        this.body = body
        return this
      }),
    }
    return res
  }

  function mockValidSignature() {
    validateMock.mockImplementation(() => undefined)
  }

  function mockValidOrder(overrides: Partial<Record<string, unknown>> = {}) {
    orderGetMock.mockResolvedValue({
      id: "789012",
      status: "processed",
      status_detail: "accredited",
      external_reference: "cart_123",
      transactions: {
        payments: [
          {
            status: "processed",
            status_detail: "accredited",
            amount: "130.00",
            paid_amount: "130.00",
          },
        ],
      },
      ...overrides,
    })
  }

  // 25. Other provider: identical to core behavior, no HMAC/correlation
  it("replicates core behavior for a non-Mercado Pago provider", async () => {
    const { req, emit, graph, listPaymentSessions } = buildReq({
      params: { provider: "stripe_stripe" },
      query: {},
      headers: {},
      body: { foo: "bar" },
    })
    const res = buildRes()

    await POST(req, res)

    expect(validateMock).not.toHaveBeenCalled()
    expect(graph).not.toHaveBeenCalled()
    expect(listPaymentSessions).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider: "stripe_stripe",
          payload: { data: req.body, rawData: req.rawBody, headers: req.headers },
        },
      },
      { delay: 5000, attempts: 3 }
    )
    expect(res.sendStatus).toHaveBeenCalledWith(200)
  })

  // 1. valid data.id
  it("accepts a single valid data.id from the query string", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req } = buildReq()
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
  })

  // 2. missing query
  it("rejects when data.id is missing from the query", async () => {
    const { req } = buildReq({ query: {} })
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(400)
    expect(validateMock).not.toHaveBeenCalled()
  })

  // 3. ambiguous query (multiple values)
  it("rejects when data.id has multiple ambiguous values", async () => {
    const { req } = buildReq({ query: { "data.id": ["1", "2"] } })
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(400)
    expect(validateMock).not.toHaveBeenCalled()
  })

  // 4. missing x-signature
  it("rejects when x-signature header is missing", async () => {
    const { req } = buildReq({ headers: { "x-request-id": VALID_REQUEST_ID } })
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(400)
    expect(validateMock).not.toHaveBeenCalled()
  })

  // 5. missing x-request-id
  it("rejects when x-request-id header is missing", async () => {
    const { req } = buildReq({ headers: { "x-signature": VALID_SIGNATURE } })
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(400)
    expect(validateMock).not.toHaveBeenCalled()
  })

  // 6. missing secret
  it("responds 500 without validating when the webhook secret is not configured", async () => {
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET
    const { req } = buildReq()
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(500)
    expect(validateMock).not.toHaveBeenCalled()
  })

  // 7. invalid signature
  it("responds 401 and does not emit when the signature is invalid", async () => {
    validateMock.mockImplementation(() => {
      // FakeInvalidWebhookSignatureError already builds and returns a full
      // Error instance with the right prototype; no `new` needed here.
      throw FakeInvalidWebhookSignatureError("SignatureMismatch")
    })
    const { req, emit } = buildReq()
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(emit).not.toHaveBeenCalled()
    expect(orderGetMock).not.toHaveBeenCalled()
  })

  // 8. valid signature
  it("proceeds past signature validation when the signature is valid", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req } = buildReq()
    const res = buildRes()

    await POST(req, res)

    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        xSignature: VALID_SIGNATURE,
        xRequestId: VALID_REQUEST_ID,
        dataId: "789012",
        secret: WEBHOOK_SECRET,
      })
    )
    expect(res.sendStatus).toHaveBeenCalledWith(200)
  })

  // dataId case handling: the generic SDK validator preserves whatever case
  // it's given, but the Orders API's own notifications documentation still
  // requires an alphanumeric data.id to be lowercased before it's used in
  // the HMAC manifest — confirmed by two real Orders webhooks from the test
  // application, whose received signature only matched the lowercase
  // variant. So only the value handed to the validator is lowercased; the
  // query string's original case (e.g. sandbox order ids like ORDTST...)
  // must still reach Order.get() and the event payload unchanged.
  it("lowercases dataId only for signature validation, preserving the original case elsewhere", async () => {
    mockValidSignature()
    const MIXED_CASE_ID = "ORDTST01M2ZNA9X4H9JQ3QC29NYHN0VV"
    mockValidOrder({ id: MIXED_CASE_ID })
    const { req, emit, listPaymentSessions } = buildReq({ query: { "data.id": MIXED_CASE_ID } })
    listPaymentSessions.mockResolvedValue([
      {
        id: "payses_123",
        provider_id: "pp_mercadopago",
        status: "pending",
        data: { mercadopago_order_id: MIXED_CASE_ID },
      },
    ])
    const res = buildRes()

    await POST(req, res)

    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: MIXED_CASE_ID.toLowerCase() })
    )
    expect(orderGetMock).toHaveBeenCalledWith({ id: MIXED_CASE_ID })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ dataId: MIXED_CASE_ID }),
        }),
      }),
      expect.anything()
    )
    expect(res.sendStatus).toHaveBeenCalledWith(200)
  })

  // 9. body data.id differs from query data.id: query must be the source of truth for HMAC
  it("uses the query data.id for HMAC validation even if the body carries a different id", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req } = buildReq({
      query: { "data.id": "789012" },
      body: { type: "order", data: { id: "DIFFERENT_ID_999" } },
    })
    const res = buildRes()

    await POST(req, res)

    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: "789012" })
    )
  })

  // 10. Order without external_reference
  it("acks with 200 and does not emit when the Order has no external_reference", async () => {
    mockValidSignature()
    mockValidOrder({ external_reference: undefined })
    const { req, emit } = buildReq()
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(emit).not.toHaveBeenCalled()
  })

  // 11. Cart not found
  it("responds 503 (retry) and does not emit when a paid Order's Cart is not found", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, graph } = buildReq()
    graph.mockResolvedValue({ data: [] })
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
  })

  // 12. PaymentCollection missing
  it("responds 503 (retry) and does not emit when a paid Order's Cart has no payment_collection", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, graph } = buildReq()
    graph.mockResolvedValue({ data: [{ id: "cart_123" }] } as any)
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
  })

  // 13. zero sessions
  it("responds 503 (retry) and does not emit when no PaymentSession holds a paid Order", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, listPaymentSessions } = buildReq()
    listPaymentSessions.mockResolvedValue([])
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
  })

  // 14. two sessions claim the same Mercado Pago Order: never guess
  it("responds 503, logs an error and does not emit when two PaymentSessions hold the same Order", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, listPaymentSessions, logger } = buildReq()
    listPaymentSessions.mockResolvedValue([
      { id: "payses_1", provider_id: "pp_mercadopago", status: "pending", data: { mercadopago_order_id: "789012" } },
      { id: "payses_2", provider_id: "pp_mercadopago", status: "pending", data: { mercadopago_order_id: "789012" } },
    ])
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  // 15. defensive provider_id check on the resolved session
  it("responds 503 when the single matching session has an unexpected provider_id", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, listPaymentSessions } = buildReq()
    listPaymentSessions.mockResolvedValue([
      { id: "payses_1", provider_id: "pp_stripe_stripe", status: "pending", data: { mercadopago_order_id: "789012" } },
    ])
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
  })

  // 16, 21, 22, 23, 24 combined: valid session -> event emitted with dataId, sessionId,
  // preserved provider/rawData, preserved delay/attempts
  it("emits the core event enriched with dataId and sessionId, preserving provider/rawData/delay/attempts", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit } = buildReq({
      scopeState: { paymentOptions: { webhook_delay: 9999, webhook_retries: 2 } },
    })
    const res = buildRes()

    await POST(req, res)

    expect(emit).toHaveBeenCalledWith(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider: "mercadopago",
          payload: expect.objectContaining({
            data: req.body,
            rawData: req.rawBody,
            headers: req.headers,
            dataId: "789012",
            sessionId: "payses_123",
            orderStatus: "processed",
            paymentStatus: "processed",
            amount: "130.00",
          }),
        },
      },
      { delay: 9999, attempts: 2 }
    )
    expect(res.sendStatus).toHaveBeenCalledWith(200)
  })

  // 20. Order query failure
  it("responds 502 and does not emit when orderClient.get fails", async () => {
    mockValidSignature()
    orderGetMock.mockRejectedValue(new Error("network error"))
    const { req, emit } = buildReq()
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(502)
    expect(emit).not.toHaveBeenCalled()
  })

  describe("correlation by the notified Mercado Pago Order id", () => {
    const CURRENT_ORDER = "ORD_B_CURRENT"
    const OLD_ORDER = "ORD_A_OLD"

    // The cart's single Mercado Pago session now holds Order B (Order A was
    // replaced, e.g. expired and regenerated). Another provider's session is
    // present too and must be ignored.
    function sessionsHoldingCurrentOrder() {
      return [
        { id: "payses_current", provider_id: "pp_mercadopago", status: "pending", data: { mercadopago_order_id: CURRENT_ORDER } },
        { id: "payses_other_provider", provider_id: "pp_stripe_stripe", status: "pending", data: { mercadopago_order_id: OLD_ORDER } },
      ]
    }

    it("case 1 — current Order: emits for the session holding exactly that Order", async () => {
      mockValidSignature()
      mockValidOrder({ id: CURRENT_ORDER })
      const { req, emit, listPaymentSessions } = buildReq({ query: { "data.id": CURRENT_ORDER } })
      listPaymentSessions.mockResolvedValue(sessionsHoldingCurrentOrder())
      const res = buildRes()

      await POST(req, res)

      expect(listPaymentSessions).toHaveBeenCalledWith(
        { payment_collection_id: "paycol_123", provider_id: "pp_mercadopago" },
        { select: ["id", "provider_id", "status", "data"] }
      )
      expect(emit).toHaveBeenCalledTimes(1)
      expect((emit.mock.calls[0] as any)[0].data.payload.sessionId).toBe("payses_current")
      expect(res.sendStatus).toHaveBeenCalledWith(200)
    })

    it.each([
      ["cancelled", "canceled"],
      ["expired", "expired"],
      ["still pending", "action_required"],
    ])(
      "case 2 — old %s Order A: acks 200, never touches the session now holding Order B",
      async (_label, status) => {
        mockValidSignature()
        mockValidOrder({
          id: OLD_ORDER,
          status,
          status_detail: status,
          transactions: { payments: [{ status, status_detail: status, amount: "130.00" }] },
        })
        const { req, emit, listPaymentSessions, logger } = buildReq({ query: { "data.id": OLD_ORDER } })
        listPaymentSessions.mockResolvedValue(sessionsHoldingCurrentOrder())
        const res = buildRes()

        await POST(req, res)

        expect(emit).not.toHaveBeenCalled()
        expect(res.sendStatus).toHaveBeenCalledWith(200)
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(OLD_ORDER))
      }
    )

    it("case 2b — old Order A reported PAID: 503 for retry + warning, still never touches Order B's session", async () => {
      mockValidSignature()
      mockValidOrder({ id: OLD_ORDER })
      const { req, emit, listPaymentSessions, logger } = buildReq({ query: { "data.id": OLD_ORDER } })
      listPaymentSessions.mockResolvedValue(sessionsHoldingCurrentOrder())
      const res = buildRes()

      await POST(req, res)

      expect(emit).not.toHaveBeenCalled()
      expect(res.sendStatus).toHaveBeenCalledWith(503)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(OLD_ORDER))
    })

    it("case 3 — unknown Order pointing at a cart none of whose sessions hold it: not attached to that cart", async () => {
      mockValidSignature()
      mockValidOrder({
        id: "ORD_UNKNOWN",
        status: "action_required",
        transactions: { payments: [{ status: "action_required", amount: "130.00" }] },
      })
      const { req, emit } = buildReq({ query: { "data.id": "ORD_UNKNOWN" } })
      const res = buildRes()

      await POST(req, res)

      expect(emit).not.toHaveBeenCalled()
      expect(res.sendStatus).toHaveBeenCalledWith(200)
    })

    it("case 3b — a session without any Mercado Pago Order yet is never matched", async () => {
      mockValidSignature()
      mockValidOrder()
      const { req, emit, listPaymentSessions } = buildReq()
      listPaymentSessions.mockResolvedValue([
        { id: "payses_new", provider_id: "pp_mercadopago", status: "pending", data: { payment_method_id: "pix" } },
      ])
      const res = buildRes()

      await POST(req, res)

      expect(emit).not.toHaveBeenCalled()
    })

    it("case 4 — the same notification twice: the route keeps no state and emits the same payload for the same session", async () => {
      mockValidSignature()
      mockValidOrder()
      const first = buildReq()
      const second = buildReq()

      await POST(first.req, buildRes())
      await POST(second.req, buildRes())

      const payloadOf = (emit: jest.Mock) => (emit.mock.calls[0] as any)[0].data.payload
      expect(payloadOf(first.emit).sessionId).toBe("payses_123")
      expect(payloadOf(second.emit)).toEqual(payloadOf(first.emit))
      // Duplicate processing is absorbed by Medusa core: authorizePaymentSession
      // returns the existing Payment, capturePayment skips an already captured
      // one, order transactions are de-duplicated by reference_id and
      // completeCart returns the existing order (cart lock + order_cart).
    })

    it("case 7 — approved Order: emitted payload makes the provider return 'captured' for that session (native flow)", async () => {
      mockValidSignature()
      mockValidOrder({ id: CURRENT_ORDER })
      const { req, emit, listPaymentSessions } = buildReq({ query: { "data.id": CURRENT_ORDER } })
      listPaymentSessions.mockResolvedValue(sessionsHoldingCurrentOrder())
      await POST(req, buildRes())

      const payload = (emit.mock.calls[0] as any)[0].data.payload
      const ProviderClass = MercadoPagoPaymentProviderService as any
      const provider = new ProviderClass({}, { access_token: "test-access-token" })

      await expect(provider.getWebhookActionAndData(payload)).resolves.toEqual({
        action: "captured",
        data: { session_id: "payses_current", amount: "130.00" },
      })
    })
  })
})

describe("mercadopago provider getWebhookActionAndData (status mapping only, no network/container access)", () => {
  function buildProvider() {
    // Cast to `any`: the abstract base's constructor is `protected` in its
    // `.d.ts`, which trips TS's construct-signature inference for `new` here
    // even though the concrete subclass constructor is public at runtime.
    const ProviderClass = MercadoPagoPaymentProviderService as any
    return new ProviderClass({}, { access_token: "test-access-token" })
  }

  // 17. processed -> captured
  it("maps a processed payment/order to the captured action", async () => {
    const provider = buildProvider()

    const result = await provider.getWebhookActionAndData({
      data: { type: "order" },
      sessionId: "payses_123",
      orderStatus: "processed",
      paymentStatus: "processed",
      amount: "130.00",
    })

    expect(result).toEqual({
      action: "captured",
      data: { session_id: "payses_123", amount: "130.00" },
    })
  })

  // 18. authorized -> authorized
  it("maps an authorized payment to the authorized action", async () => {
    const provider = buildProvider()

    const result = await provider.getWebhookActionAndData({
      data: { type: "order" },
      sessionId: "payses_123",
      orderStatus: "authorized",
      paymentStatus: "authorized",
      amount: "130.00",
    })

    expect(result).toEqual({
      action: "authorized",
      data: { session_id: "payses_123", amount: "130.00" },
    })
  })

  // 19. unsupported state
  it("returns not_supported for a status outside authorized/captured", async () => {
    const provider = buildProvider()

    const result = await provider.getWebhookActionAndData({
      data: { type: "order" },
      sessionId: "payses_123",
      orderStatus: "cancelled",
      paymentStatus: "cancelled",
      amount: "130.00",
    })

    expect(result).toEqual({
      action: "not_supported",
      data: { session_id: "payses_123", amount: 0 },
    })
  })

  it("returns not_supported when the notification is not an order event", async () => {
    const provider = buildProvider()

    const result = await provider.getWebhookActionAndData({
      data: { type: "payment" },
      sessionId: "payses_123",
      orderStatus: "processed",
      paymentStatus: "processed",
      amount: "130.00",
    })

    expect(result.action).toBe("not_supported")
  })

  it("returns not_supported when the amount is missing or invalid", async () => {
    const provider = buildProvider()

    const result = await provider.getWebhookActionAndData({
      data: { type: "order" },
      sessionId: "payses_123",
      orderStatus: "processed",
      paymentStatus: "processed",
      amount: undefined,
    })

    expect(result.action).toBe("not_supported")
  })
})
