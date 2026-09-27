import {
  redactMercadoPagoDataMiddleware,
  redactMercadoPagoProviderData,
  toPublicMercadoPagoData,
} from "../redact-mercadopago-data"

// Shapes mirror what the Store API returned for real Mercado Pago sessions
// (keys only; values are fake).
function cardSessionData() {
  return {
    amount: 135,
    currency_code: "BRL",
    cart_id: "cart_123",
    session_id: "payses_card",
    card_token: "tok_secret",
    payment_method_id: "visa",
    payment_type_id: "credit_card",
    issuer_id: "25",
    installments: 1,
    transaction_amount: 135,
    payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    mercadopago_orders_api: true,
    mercadopago_idempotency_key: "idem-base",
    mercadopago_order_id: "ORD123",
    mercadopago_payment_id: "PAY123",
    mercadopago_external_reference: "cart_123",
    mercadopago_status: "processed",
    mercadopago_status_detail: "accredited",
    mercadopago_order_status: "processed",
    mercadopago_order_status_detail: "accredited",
    mercadopago_payment_status: "processed",
  }
}

function pixSessionData() {
  return {
    amount: 160,
    currency_code: "BRL",
    cart_id: "cart_456",
    session_id: "payses_pix",
    payment_method_id: "pix",
    payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    mercadopago_orders_api: true,
    mercadopago_idempotency_key: "idem-base",
    mercadopago_pix_idempotency_key: "idem-pix",
    mercadopago_pix_generation: 0,
    mercadopago_order_id: "ORD456",
    mercadopago_payment_id: "PAY456",
    mercadopago_order_payment_method: "pix",
    mercadopago_pix_qr_code: "000201...",
    mercadopago_pix_qr_code_base64: "iVBOR...",
    mercadopago_pix_ticket_url: "https://example.com/ticket",
    mercadopago_pix_date_of_expiration: "2026-09-28T00:00:00.000Z",
    mercadopago_status: "action_required",
  }
}

function session(id: string, data: unknown, extra: Record<string, unknown> = {}) {
  return {
    id,
    provider_id: "pp_mercadopago",
    status: "pending",
    amount: 135,
    currency_code: "brl",
    data,
    ...extra,
  }
}

const FORBIDDEN_KEYS = [
  "card_token",
  "payer",
  "issuer_id",
  "installments",
  "mercadopago_idempotency_key",
  "mercadopago_pix_idempotency_key",
  "mercadopago_order_id",
  "mercadopago_payment_id",
  "mercadopago_pix_qr_code",
  "session_id",
]

function expectNoProviderSecrets(data: unknown) {
  for (const key of FORBIDDEN_KEYS) {
    expect(data).not.toHaveProperty(key)
  }
}

describe("redactMercadoPagoProviderData — /store/carts responses", () => {
  it("reduces a card session's data to payment_method_id (no card_token, payer, keys or ids)", () => {
    const body = {
      cart: {
        id: "cart_123",
        total: 135,
        payment_collection: { id: "paycol_1", payment_sessions: [session("payses_card", cardSessionData())] },
      },
    }

    const result = redactMercadoPagoProviderData(body) as any
    const redacted = result.cart.payment_collection.payment_sessions[0]

    expect(redacted.data).toEqual({ payment_method_id: "visa" })
    expectNoProviderSecrets(redacted.data)
  })

  it("keeps the public session fields the checkout reads (id, provider_id, status, amount)", () => {
    const body = {
      cart: { id: "cart_123", payment_collection: { payment_sessions: [session("payses_card", cardSessionData())] } },
    }

    const redacted = (redactMercadoPagoProviderData(body) as any).cart.payment_collection.payment_sessions[0]

    expect(redacted).toEqual(
      expect.objectContaining({
        id: "payses_card",
        provider_id: "pp_mercadopago",
        status: "pending",
        amount: 135,
        currency_code: "brl",
      })
    )
    expect((redactMercadoPagoProviderData(body) as any).cart.id).toBe("cart_123")
  })

  it("keeps payment_method_id 'pix' so the Review still detects a Pix session, and drops QR/ticket/keys", () => {
    const body = {
      cart: { payment_collection: { payment_sessions: [session("payses_pix", pixSessionData())] } },
    }

    const redacted = (redactMercadoPagoProviderData(body) as any).cart.payment_collection.payment_sessions[0]

    expect(redacted.data).toEqual({ payment_method_id: "pix" })
    // Same predicate as apps/storefront review/index.tsx
    expect(redacted.provider_id === "pp_mercadopago" && redacted.data?.payment_method_id === "pix").toBe(true)
    expectNoProviderSecrets(redacted.data)
  })

  it("also redacts payments[].data (Payment stores a copy of the session data)", () => {
    const body = {
      cart: {
        payment_collection: {
          payment_sessions: [session("payses_card", cardSessionData())],
          payments: [{ id: "pay_1", provider_id: "pp_mercadopago", amount: 135, data: cardSessionData() }],
        },
      },
    }

    const payment = (redactMercadoPagoProviderData(body) as any).cart.payment_collection.payments[0]

    expect(payment).toEqual({ id: "pay_1", provider_id: "pp_mercadopago", amount: 135, data: { payment_method_id: "visa" } })
  })

  it("redacts rows requested without provider_id (?fields=payment_collection.payment_sessions.data)", () => {
    const body = { cart: { id: "cart_123", payment_collection: { payment_sessions: [{ data: cardSessionData() }] } } }

    const redacted = (redactMercadoPagoProviderData(body) as any).cart.payment_collection.payment_sessions[0]

    expect(redacted).toEqual({ data: { payment_method_id: "visa" } })
  })

  it("redacts the cart returned by the complete route on a payment error", () => {
    const body = {
      type: "cart",
      cart: { payment_collection: { payment_sessions: [session("payses_card", cardSessionData())] } },
      error: { message: "Payment authorization failed", name: "Error", type: "payment_authorization_error" },
    }

    const result = redactMercadoPagoProviderData(body) as any

    expect(result.cart.payment_collection.payment_sessions[0].data).toEqual({ payment_method_id: "visa" })
    expect(result.error).toEqual(body.error)
    expect(result.type).toBe("cart")
  })

  it("returns {} when a Mercado Pago session has no data", () => {
    const body = { cart: { payment_collection: { payment_sessions: [session("payses_empty", null)] } } }

    expect((redactMercadoPagoProviderData(body) as any).cart.payment_collection.payment_sessions[0].data).toEqual({})
  })
})

describe("redactMercadoPagoProviderData — other responses and providers", () => {
  it("redacts sessions and payments nested in /store/orders payment_collections", () => {
    const body = {
      order: {
        id: "order_1",
        payment_collections: [
          {
            payment_sessions: [session("payses_card", cardSessionData())],
            payments: [{ id: "pay_1", provider_id: "pp_mercadopago", data: cardSessionData() }],
          },
        ],
      },
    }

    const collection = (redactMercadoPagoProviderData(body) as any).order.payment_collections[0]

    expect(collection.payment_sessions[0].data).toEqual({ payment_method_id: "visa" })
    expect(collection.payments[0].data).toEqual({ payment_method_id: "visa" })
  })

  it("redacts /store/payment-collections responses", () => {
    const body = { payment_collection: { id: "paycol_1", payment_sessions: [session("payses_card", cardSessionData())] } }

    expect((redactMercadoPagoProviderData(body) as any).payment_collection.payment_sessions[0].data).toEqual({
      payment_method_id: "visa",
    })
  })

  it("leaves other providers' session data untouched (e.g. Stripe client_secret)", () => {
    const stripe = { id: "payses_stripe", provider_id: "pp_stripe_stripe", data: { id: "pi_1", client_secret: "pi_1_secret" } }
    const body = { cart: { payment_collection: { payment_sessions: [stripe] } } }

    expect((redactMercadoPagoProviderData(body) as any).cart.payment_collection.payment_sessions[0]).toEqual(stripe)
  })

  it("leaves rows without provider_id and without Mercado Pago keys untouched", () => {
    const row = { data: { id: "pi_1", client_secret: "pi_1_secret" } }
    const body = { cart: { payment_collection: { payment_sessions: [row] } } }

    expect((redactMercadoPagoProviderData(body) as any).cart.payment_collection.payment_sessions[0]).toEqual(row)
  })

  it("does not mutate the input (stored session data is never touched) and keeps non-plain values", () => {
    const createdAt = new Date("2026-09-27T00:00:00.000Z")
    const data = cardSessionData()
    const body = {
      cart: { created_at: createdAt, payment_collection: { payment_sessions: [session("payses_card", data)] } },
    }

    const result = redactMercadoPagoProviderData(body) as any

    expect(body.cart.payment_collection.payment_sessions[0].data).toBe(data)
    expect(data).toEqual(cardSessionData())
    expect(result.cart.created_at).toBe(createdAt)
  })

  it("passes through bodies without payment rows and primitives", () => {
    expect(redactMercadoPagoProviderData({ products: [{ id: "prod_1", data: { a: 1 } }] })).toEqual({
      products: [{ id: "prod_1", data: { a: 1 } }],
    })
    expect(redactMercadoPagoProviderData(null)).toBeNull()
    expect(redactMercadoPagoProviderData("ok")).toBe("ok")
  })
})

describe("toPublicMercadoPagoData", () => {
  it("keeps only a string payment_method_id", () => {
    expect(toPublicMercadoPagoData({ payment_method_id: "pix", card_token: "x" })).toEqual({ payment_method_id: "pix" })
    expect(toPublicMercadoPagoData({ payment_method_id: 1 })).toEqual({})
    expect(toPublicMercadoPagoData(undefined)).toEqual({})
  })
})

describe("redactMercadoPagoDataMiddleware", () => {
  function buildRes() {
    const originalJson = jest.fn((body: unknown) => body)
    const res: any = { json: originalJson }
    return { res, originalJson }
  }

  it("calls next and makes res.json send the redacted body", () => {
    const { res, originalJson } = buildRes()
    const next = jest.fn()

    redactMercadoPagoDataMiddleware({} as any, res, next)
    res.json({ cart: { payment_collection: { payment_sessions: [session("payses_card", cardSessionData())] } } })

    expect(next).toHaveBeenCalledTimes(1)
    expect(originalJson).toHaveBeenCalledTimes(1)
    const sent = originalJson.mock.calls[0][0] as any
    expect(sent.cart.payment_collection.payment_sessions[0].data).toEqual({ payment_method_id: "visa" })
  })

  it("works for guest requests (no auth context) and does not change access", () => {
    const { res, originalJson } = buildRes()
    const next = jest.fn()
    const guestReq: any = { params: { id: "cart_123" }, auth_context: undefined }

    redactMercadoPagoDataMiddleware(guestReq, res, next)
    res.json({ cart: { id: "cart_123" } })

    expect(next).toHaveBeenCalledWith()
    expect(originalJson).toHaveBeenCalledWith({ cart: { id: "cart_123" } })
  })
})
