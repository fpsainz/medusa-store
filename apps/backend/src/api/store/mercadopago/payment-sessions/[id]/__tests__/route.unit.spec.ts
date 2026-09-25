import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { POST } from "../route"

const PAYMENT_COLLECTION_ID = "paycol_123"

function buildReq(overrides: {
  body: Record<string, unknown>
  paymentSession?: Record<string, unknown>
  cartGraphData?: unknown[]
  updatePaymentSession?: jest.Mock
}) {
  const paymentSession = overrides.paymentSession ?? {
    id: "payses_123",
    amount: 100,
    currency_code: "BRL",
    provider_id: "pp_mercadopago",
    payment_collection_id: PAYMENT_COLLECTION_ID,
    data: {
      existing: true,
    },
  }

  const updatePaymentSession =
    overrides.updatePaymentSession ??
    jest.fn(async (input) => ({
      ...input,
      id: input.id,
    }))
  const retrievePaymentSession = jest.fn(async () => paymentSession)
  const authorizePaymentSession = jest.fn(async () => ({ id: "pay_123" }))

  const cartGraphData =
    overrides.cartGraphData ?? [
      { id: "cart_123", payment_collection: { id: PAYMENT_COLLECTION_ID } },
    ]
  const graph = jest.fn(async () => ({ data: cartGraphData }))

  const req: any = {
    params: { id: paymentSession.id },
    body: overrides.body,
    scope: {
      resolve: (key: string) => {
        if (key === Modules.PAYMENT) {
          return {
            retrievePaymentSession,
            updatePaymentSession,
            authorizePaymentSession,
          }
        }

        if (key === ContainerRegistrationKeys.QUERY) {
          return { graph }
        }

        throw new Error(`Unexpected module request: ${key}`)
      },
    },
  }

  return { req, retrievePaymentSession, updatePaymentSession, authorizePaymentSession, graph }
}

describe("mercadopago payment session route", () => {
  it("updates the Medusa payment session without authorizing it", async () => {
    const { req, retrievePaymentSession, updatePaymentSession, authorizePaymentSession } = buildReq({
      body: {
        cart_id: "cart_123",
        card_token: "cardtoken_123",
        payment_method_id: "visa",
        installments: 1,
        transaction_amount: 100,
        payer: { email: "customer@example.com" },
      },
    })

    const res: any = {
      json: jest.fn(),
    }

    await POST(req, res)

    expect(retrievePaymentSession).toHaveBeenCalledWith(
      "payses_123",
      expect.objectContaining({ select: expect.arrayContaining(["payment_collection_id"]) })
    )
    expect(updatePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "payses_123",
        amount: 100,
        currency_code: "BRL",
        data: expect.objectContaining({
          existing: true,
          card_token: "cardtoken_123",
          payment_method_id: "visa",
          installments: 1,
          transaction_amount: 100,
          payer: { email: "customer@example.com" },
        }),
      })
    )
    expect(authorizePaymentSession).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_session: expect.objectContaining({ id: "payses_123" }),
      })
    )
  })

  it("strips mercadopago_*, status and Pix-result fields sent by the client (allowlist)", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: {
        cart_id: "cart_123",
        payment_method_id: "pix",
        payer: { email: "customer@example.com" },
        // Everything below must never reach session.data from the client:
        // it is written exclusively by the provider (service.ts), from data
        // it obtained itself from Mercado Pago.
        mercadopago_order_id: "attacker-controlled-order-id",
        mercadopago_payment_id: "attacker-controlled-payment-id",
        mercadopago_payment_status: "approved",
        mercadopago_idempotency_key: "attacker-key",
        status: "authorized",
        qr_code: "forged-qr",
        qr_code_base64: "forged-base64",
        ticket_url: "https://attacker.example/ticket",
        date_of_expiration: "2099-01-01T00:00:00Z",
        expiration_time: "2099-01-01T00:00:00Z",
      },
    })

    const res: any = { json: jest.fn() }

    await POST(req, res)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).toEqual({
      existing: true,
      cart_id: "cart_123",
      payment_method_id: "pix",
      payer: { email: "customer@example.com" },
    })
    expect(updateInput.data).not.toHaveProperty("mercadopago_order_id")
    expect(updateInput.data).not.toHaveProperty("mercadopago_payment_id")
    expect(updateInput.data).not.toHaveProperty("mercadopago_payment_status")
    expect(updateInput.data).not.toHaveProperty("mercadopago_idempotency_key")
    expect(updateInput.data).not.toHaveProperty("status")
    expect(updateInput.data).not.toHaveProperty("qr_code")
    expect(updateInput.data).not.toHaveProperty("qr_code_base64")
    expect(updateInput.data).not.toHaveProperty("ticket_url")
    expect(updateInput.data).not.toHaveProperty("date_of_expiration")
    expect(updateInput.data).not.toHaveProperty("expiration_time")
  })

  it("never lets a non-string/non-number field through under an allowed key", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: {
        cart_id: "cart_123",
        payment_method_id: { toString: () => "visa" },
        installments: "1",
        payer: "not-an-object",
      },
    })

    const res: any = { json: jest.fn() }

    await POST(req, res)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).toEqual({ existing: true, cart_id: "cart_123" })
  })

  it("rejects the request when cart_id is missing", async () => {
    const { req } = buildReq({ body: {} })
    const res: any = { json: jest.fn() }

    await expect(POST(req, res)).rejects.toThrow(/cart_id is required/)
  })

  it("rejects the request when the payment session does not belong to the given cart", async () => {
    const { req } = buildReq({
      body: { cart_id: "cart_123", payment_method_id: "pix" },
      cartGraphData: [{ id: "cart_123", payment_collection: { id: "some-other-payment-collection" } }],
    })
    const res: any = { json: jest.fn() }

    await expect(POST(req, res)).rejects.toThrow(/does not belong to the given cart/)
  })

  it("rejects the request when the cart has no matching payment_collection", async () => {
    const { req } = buildReq({
      body: { cart_id: "cart_123", payment_method_id: "pix" },
      cartGraphData: [],
    })
    const res: any = { json: jest.fn() }

    await expect(POST(req, res)).rejects.toThrow(/does not belong to the given cart/)
  })

  it("rejects a payment session that does not belong to the Mercado Pago provider", async () => {
    const { req } = buildReq({
      body: { cart_id: "cart_123", payment_method_id: "pix" },
      paymentSession: {
        id: "payses_123",
        amount: 100,
        currency_code: "BRL",
        provider_id: "pp_stripe",
        payment_collection_id: PAYMENT_COLLECTION_ID,
        data: {},
      },
    })
    const res: any = { json: jest.fn() }

    await expect(POST(req, res)).rejects.toThrow(/does not belong to the Mercado Pago provider/)
  })
})
