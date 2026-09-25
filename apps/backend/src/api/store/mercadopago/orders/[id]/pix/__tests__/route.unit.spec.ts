import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { GET } from "../route"

function buildReq(orderGraphData: unknown[]) {
  const graph = jest.fn(async () => ({ data: orderGraphData }))

  const req: any = {
    params: { id: "order_123" },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.QUERY) {
          return { graph }
        }

        throw new Error(`Unexpected module request: ${key}`)
      },
    },
  }

  return { req, graph }
}

function buildRes() {
  return {
    setHeader: jest.fn(),
    json: jest.fn(),
  } as any
}

describe("GET /store/mercadopago/orders/:id/pix", () => {
  it("returns only the Pix DTO fields, never session.data/payer/idempotency key wholesale", async () => {
    const { req } = buildReq([
      {
        payment_collections: [
          {
            payment_sessions: [
              {
                id: "payses_123",
                provider_id: "pp_mercadopago",
                status: "pending_authorization",
                data: {
                  mercadopago_pix_qr_code: "00020126...6304ABCD",
                  mercadopago_pix_qr_code_base64: "iVBORw0KGgo=",
                  mercadopago_pix_ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket",
                  mercadopago_pix_date_of_expiration: "2026-01-01T00:00:00.000Z",
                  mercadopago_order_id: "internal-order-id",
                  mercadopago_payment_id: "internal-payment-id",
                  mercadopago_idempotency_key: "should-not-leak",
                  payer: { email: "customer@example.com", identification: { number: "12345678900" } },
                  cart_id: "cart_123",
                },
              },
            ],
          },
        ],
      },
    ])
    const res = buildRes()

    await GET(req, res)

    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")
    expect(res.json).toHaveBeenCalledWith({
      status: "pending_authorization",
      qr_code: "00020126...6304ABCD",
      qr_code_base64: "iVBORw0KGgo=",
      ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket",
      expires_at: "2026-01-01T00:00:00.000Z",
    })

    const [[payload]] = res.json.mock.calls
    expect(payload).not.toHaveProperty("payer")
    expect(payload).not.toHaveProperty("cart_id")
    expect(payload).not.toHaveProperty("mercadopago_idempotency_key")
    expect(payload).not.toHaveProperty("mercadopago_order_id")
    expect(payload).not.toHaveProperty("mercadopago_payment_id")
    expect(payload).not.toHaveProperty("data")
  })

  it("falls back to expiration_time when date_of_expiration is absent", async () => {
    const { req } = buildReq([
      {
        payment_collections: [
          {
            payment_sessions: [
              {
                id: "payses_123",
                provider_id: "pp_mercadopago",
                status: "pending_authorization",
                data: { mercadopago_pix_expiration_time: "2026-02-02T00:00:00.000Z" },
              },
            ],
          },
        ],
      },
    ])
    const res = buildRes()

    await GET(req, res)

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: "2026-02-02T00:00:00.000Z" })
    )
  })

  it("ignores payment sessions from other providers (e.g. card/manual)", async () => {
    const { req } = buildReq([
      {
        payment_collections: [
          {
            payment_sessions: [
              { id: "payses_card", provider_id: "pp_stripe", status: "authorized", data: {} },
            ],
          },
        ],
      },
    ])
    const res = buildRes()

    await expect(GET(req, res)).rejects.toThrow(/no Pix payment session found/)
  })

  it("throws NOT_FOUND when the order has no payment collections at all", async () => {
    const { req } = buildReq([{ payment_collections: [] }])
    const res = buildRes()

    await expect(GET(req, res)).rejects.toThrow(/no Pix payment session found/)
  })

  it("throws NOT_FOUND when the order does not exist", async () => {
    const { req } = buildReq([])
    const res = buildRes()

    await expect(GET(req, res)).rejects.toThrow(/no Pix payment session found/)
  })
})
