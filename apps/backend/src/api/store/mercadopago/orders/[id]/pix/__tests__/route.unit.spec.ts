import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

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

const PIX_SESSION_DATA = {
  payment_method_id: "pix",
  mercadopago_pix_qr_code: "00020126...6304ABCD",
  mercadopago_pix_qr_code_base64: "iVBORw0KGgo=",
  mercadopago_pix_ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket",
  mercadopago_pix_date_of_expiration: "2026-01-01T00:00:00.000Z",
  mercadopago_pix_expiration_time: "2026-01-01T00:00:00.000Z",
  mercadopago_pix_generation: 1,
  mercadopago_order_id: "internal-order-id",
  mercadopago_payment_id: "internal-payment-id",
  mercadopago_order_status: "action_required",
  mercadopago_idempotency_key: "should-not-leak",
  payer: {
    email: "customer@example.com",
    identification: { type: "CPF", number: "12345678900" },
  },
  cart_id: "cart_123",
}

function orderWithSessions(sessions: unknown[]) {
  return [{ payment_collections: [{ payment_sessions: sessions }] }]
}

async function expectNotFound(orderGraphData: unknown[]) {
  const { req } = buildReq(orderGraphData)
  const res = buildRes()

  const error = await GET(req, res).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(MedusaError)
  expect((error as MedusaError).type).toBe(MedusaError.Types.NOT_FOUND)
  expect((error as MedusaError).message).toMatch(/no Pix payment session found/)
  expect(res.json).not.toHaveBeenCalled()
}

describe("GET /store/mercadopago/orders/:id/pix", () => {
  it("returns only status and ticket_url for a pending Pix session", async () => {
    const { req } = buildReq(
      orderWithSessions([
        {
          id: "payses_123",
          provider_id: "pp_mercadopago",
          status: "pending_authorization",
          data: PIX_SESSION_DATA,
        },
      ])
    )
    const res = buildRes()

    await GET(req, res)

    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")

    const [[payload]] = res.json.mock.calls
    expect(payload).toStrictEqual({
      status: "pending_authorization",
      ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket",
    })
  })

  it("never returns QR/copy-paste, expiration, payer or Mercado Pago internals", async () => {
    const { req } = buildReq(
      orderWithSessions([
        {
          id: "payses_123",
          provider_id: "pp_mercadopago",
          status: "pending_authorization",
          data: PIX_SESSION_DATA,
        },
      ])
    )
    const res = buildRes()

    await GET(req, res)

    const [[payload]] = res.json.mock.calls
    for (const key of [
      "qr_code",
      "qr_code_base64",
      "expires_at",
      "data",
      "payer",
      "cart_id",
      "id",
      "provider_id",
      "mercadopago_order_id",
      "mercadopago_payment_id",
      "mercadopago_idempotency_key",
    ]) {
      expect(payload).not.toHaveProperty(key)
    }

    const serialized = JSON.stringify(payload)
    for (const secret of [
      "00020126...6304ABCD",
      "iVBORw0KGgo=",
      "customer@example.com",
      "12345678900",
      "should-not-leak",
      "internal-order-id",
      "internal-payment-id",
      "payses_123",
      "cart_123",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("reports an authorized (paid) Pix session", async () => {
    const { req } = buildReq(
      orderWithSessions([
        {
          id: "payses_123",
          provider_id: "pp_mercadopago",
          status: "authorized",
          data: PIX_SESSION_DATA,
        },
      ])
    )
    const res = buildRes()

    await GET(req, res)

    expect(res.json.mock.calls[0][0]).toStrictEqual({
      status: "authorized",
      ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket",
    })
  })

  it("omits ticket_url when the Pix session has none", async () => {
    const { req } = buildReq(
      orderWithSessions([
        {
          id: "payses_123",
          provider_id: "pp_mercadopago",
          status: "pending",
          data: { payment_method_id: "pix", mercadopago_pix_qr_code: "00020126...6304ABCD" },
        },
      ])
    )
    const res = buildRes()

    await GET(req, res)

    const [[payload]] = res.json.mock.calls
    expect(JSON.parse(JSON.stringify(payload))).toStrictEqual({ status: "pending" })
  })

  it("picks the Pix session when the order also has a Mercado Pago card session", async () => {
    const { req } = buildReq(
      orderWithSessions([
        {
          id: "payses_card",
          provider_id: "pp_mercadopago",
          status: "canceled",
          data: { payment_method_id: "visa", card_token: "card-token-should-not-leak" },
        },
        {
          id: "payses_pix",
          provider_id: "pp_mercadopago",
          status: "pending_authorization",
          data: PIX_SESSION_DATA,
        },
      ])
    )
    const res = buildRes()

    await GET(req, res)

    const [[payload]] = res.json.mock.calls
    expect(payload).toStrictEqual({
      status: "pending_authorization",
      ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket",
    })
  })

  it("throws NOT_FOUND for a Mercado Pago card order (not even its status leaks)", async () => {
    await expectNotFound(
      orderWithSessions([
        {
          id: "payses_card",
          provider_id: "pp_mercadopago",
          status: "authorized",
          data: {
            payment_method_id: "visa",
            payment_type_id: "credit_card",
            card_token: "card-token-should-not-leak",
            payer: PIX_SESSION_DATA.payer,
          },
        },
      ])
    )
  })

  it("throws NOT_FOUND for a Mercado Pago session without payment_method_id", async () => {
    await expectNotFound(
      orderWithSessions([
        { id: "payses_1", provider_id: "pp_mercadopago", status: "pending", data: {} },
      ])
    )
  })

  it("ignores payment sessions from other providers (e.g. card/manual)", async () => {
    await expectNotFound(
      orderWithSessions([
        {
          id: "payses_card",
          provider_id: "pp_stripe",
          status: "authorized",
          data: { payment_method_id: "pix" },
        },
      ])
    )
  })

  it("throws NOT_FOUND when the order has no payment collections at all", async () => {
    await expectNotFound([{ payment_collections: [] }])
  })

  it("throws NOT_FOUND when the order does not exist", async () => {
    await expectNotFound([])
  })
})
