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
    const listPaymentSessions = jest.fn(async () => [
      {
        id: "payses_123",
        provider_id: "pp_mercadopago",
        status: "pending",
      },
    ])

    const scopeState = {
      emit,
      graph,
      listPaymentSessions,
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
          throw new Error(`Unexpected container key: ${key}`)
        },
      },
      ...overrides,
    }

    return { req, emit, graph, listPaymentSessions }
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

  // dataId case handling: MercadoPago signs the HMAC manifest using data.id's
  // original casing (mercadopago/sdk-nodejs PR #439, shipped in 3.2.0 and
  // present in our installed 3.6.1, deliberately removed an internal
  // .toLowerCase() from the manifest builder for this exact reason). The
  // query string may carry mixed case (e.g. sandbox order ids like
  // ORDTST...); that original case must reach the validator unchanged, and
  // must also be preserved in Order.get() and the event payload.
  it("passes dataId to the signature validator in its original case, preserved everywhere else", async () => {
    mockValidSignature()
    const MIXED_CASE_ID = "ORDTST01M2ZNA9X4H9JQ3QC29NYHN0VV"
    mockValidOrder()
    const { req, emit } = buildReq({ query: { "data.id": MIXED_CASE_ID } })
    const res = buildRes()

    await POST(req, res)

    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: MIXED_CASE_ID })
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
  it("responds 503 and does not emit when the Cart is not found", async () => {
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
  it("responds 503 and does not emit when the Cart has no payment_collection", async () => {
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
  it("responds 503 and does not emit when no PaymentSession matches", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, listPaymentSessions } = buildReq()
    listPaymentSessions.mockResolvedValue([])
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
  })

  // 14. multiple sessions
  it("responds 503 and does not emit when multiple PaymentSessions match", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, listPaymentSessions } = buildReq()
    listPaymentSessions.mockResolvedValue([
      { id: "payses_1", provider_id: "pp_mercadopago", status: "pending" },
      { id: "payses_2", provider_id: "pp_mercadopago", status: "pending" },
    ])
    const res = buildRes()

    await POST(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(emit).not.toHaveBeenCalled()
  })

  // 15. defensive provider_id check on the resolved session
  it("responds 503 when the single matching session has an unexpected provider_id", async () => {
    mockValidSignature()
    mockValidOrder()
    const { req, emit, listPaymentSessions } = buildReq()
    listPaymentSessions.mockResolvedValue([
      { id: "payses_1", provider_id: "pp_stripe_stripe", status: "pending" },
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
