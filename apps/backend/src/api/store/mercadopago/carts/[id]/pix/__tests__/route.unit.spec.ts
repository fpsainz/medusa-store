const orderGetMock = jest.fn()

jest.mock("mercadopago", () => ({
  MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
  Order: jest.fn().mockImplementation(() => ({
    get: (...args: unknown[]) => orderGetMock(...args),
  })),
}))

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { GET } from "../route"

const STORED_PIX_DATA = {
  payment_method_id: "pix",
  payer: { email: "buyer@example.com" },
  mercadopago_order_payment_method: "pix",
  mercadopago_order_id: "ORD_PIX_A",
  mercadopago_order_status: "action_required",
  mercadopago_order_status_detail: "waiting_transfer",
  mercadopago_payment_status: "action_required",
  mercadopago_status_detail: "waiting_transfer",
  mercadopago_pix_qr_code: "000201",
  mercadopago_pix_qr_code_base64: "iVBOR",
  mercadopago_pix_ticket_url: "https://ticket",
  mercadopago_pix_date_of_expiration: "2026-09-26T12:00:00.000-03:00",
  mercadopago_pix_idempotency_key: "pix-key",
}

function liveOrder(status: string, detail = status) {
  return {
    id: "ORD_PIX_A",
    status,
    status_detail: detail,
    transactions: {
      payments: [
        {
          id: "PAY_PIX_A",
          status,
          status_detail: detail,
          payment_method: { qr_code: "000201", qr_code_base64: "iVBOR", ticket_url: "https://ticket" },
        },
      ],
    },
  }
}

function buildReq(cartGraphData: unknown[]) {
  const graph = jest.fn(async () => ({ data: cartGraphData }))
  const req: any = {
    params: { id: "cart_123" },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.QUERY) {
          return { graph }
        }
        throw new Error(`Unexpected module request: ${key}`)
      },
    },
  }
  const res: any = { json: jest.fn(), setHeader: jest.fn(), end: jest.fn() }
  res.status = jest.fn(() => res)
  return { req, res, graph }
}

function cartWithSessions(sessions: unknown[]) {
  return [{ id: "cart_123", payment_collection: { payment_sessions: sessions } }]
}

describe("GET /store/mercadopago/carts/:id/pix", () => {
  const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.MERCADOPAGO_ACCESS_TOKEN = "test-access-token"
  })

  afterAll(() => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  })

  it("reads the live Mercado Pago Order for a pending charge and returns the safe DTO", async () => {
    orderGetMock.mockResolvedValue(liveOrder("action_required", "waiting_transfer"))
    const { req, res, graph } = buildReq(
      cartWithSessions([{ id: "payses_pix", provider_id: "pp_mercadopago", status: "pending", data: STORED_PIX_DATA }])
    )

    await GET(req, res)

    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "cart", filters: { id: "cart_123" } }),
      { throwIfKeyNotFound: false }
    )
    expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_PIX_A" })
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")
    const dto = res.json.mock.calls[0][0]
    expect(dto.status).toBe("pending")
    expect(dto.qr_code).toBe("000201")
    expect(Object.keys(dto).every((key) =>
      ["status", "charge_ref", "qr_code", "qr_code_base64", "ticket_url", "expires_at"].includes(key)
    )).toBe(true)
    expect(JSON.stringify(dto)).not.toMatch(
      /buyer@example|pix-key|ORD_PIX_A|PAY_PIX_A|action_required|waiting_transfer/
    )
  })

  it("reports expired when Mercado Pago has expired the charge", async () => {
    orderGetMock.mockResolvedValue(liveOrder("expired"))
    const { req, res } = buildReq(
      cartWithSessions([{ id: "payses_pix", provider_id: "pp_mercadopago", status: "pending", data: STORED_PIX_DATA }])
    )

    await GET(req, res)

    expect(res.json.mock.calls[0][0].status).toBe("expired")
  })

  it("reports approved for a session Medusa already authorized, without calling Mercado Pago", async () => {
    const { req, res } = buildReq(
      cartWithSessions([{ id: "payses_pix", provider_id: "pp_mercadopago", status: "authorized", data: STORED_PIX_DATA }])
    )

    await GET(req, res)

    expect(orderGetMock).not.toHaveBeenCalled()
    expect(res.json.mock.calls[0][0].status).toBe("approved")
  })

  it("does not call Mercado Pago for a charge already stored as expired", async () => {
    const { req, res } = buildReq(
      cartWithSessions([
        {
          id: "payses_pix",
          provider_id: "pp_mercadopago",
          status: "pending",
          data: { ...STORED_PIX_DATA, mercadopago_order_status: "expired" },
        },
      ])
    )

    await GET(req, res)

    expect(orderGetMock).not.toHaveBeenCalled()
    expect(res.json.mock.calls[0][0].status).toBe("expired")
  })

  it("returns the stored state when the Pix charge has not been prepared yet", async () => {
    const { req, res } = buildReq(
      cartWithSessions([
        { id: "payses_pix", provider_id: "pp_mercadopago", status: "pending", data: { payment_method_id: "pix" } },
      ])
    )

    await GET(req, res)

    expect(orderGetMock).not.toHaveBeenCalled()
    expect(JSON.parse(JSON.stringify(res.json.mock.calls[0][0]))).toStrictEqual({ status: "unknown" })
  })

  it("falls back to the stored state when Mercado Pago is unreachable", async () => {
    orderGetMock.mockRejectedValue(new Error("network"))
    const { req, res } = buildReq(
      cartWithSessions([{ id: "payses_pix", provider_id: "pp_mercadopago", status: "pending", data: STORED_PIX_DATA }])
    )

    await GET(req, res)

    expect(res.json.mock.calls[0][0].status).toBe("pending")
  })

  describe("completed cart", () => {
    function completedCart(sessions: unknown[]) {
      return [{ id: "cart_123", completed_at: "2026-09-27T12:00:00.000Z", payment_collection: { payment_sessions: sessions } }]
    }

    it("answers 410 with no body for a completed cart, even with a pending Pix session", async () => {
      const { req, res } = buildReq(
        completedCart([{ id: "payses_pix", provider_id: "pp_mercadopago", status: "pending", data: STORED_PIX_DATA }])
      )

      await GET(req, res)

      expect(res.status).toHaveBeenCalledWith(410)
      expect(res.end).toHaveBeenCalledWith()
      expect(res.json).not.toHaveBeenCalled()
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")
      expect(orderGetMock).not.toHaveBeenCalled()
    })

    it("answers 410 for a completed cart whose session was already authorized", async () => {
      const { req, res } = buildReq(
        completedCart([{ id: "payses_pix", provider_id: "pp_mercadopago", status: "authorized", data: STORED_PIX_DATA }])
      )

      await GET(req, res)

      expect(res.status).toHaveBeenCalledWith(410)
      expect(res.json).not.toHaveBeenCalled()
    })

    it("answers 410 for a completed cart without any Pix session", async () => {
      const { req, res } = buildReq(completedCart([]))

      await GET(req, res)

      expect(res.status).toHaveBeenCalledWith(410)
      expect(res.json).not.toHaveBeenCalled()
    })
  })

  it("returns 404 for an unknown cart", async () => {
    const { req, res } = buildReq([])

    await expect(GET(req, res)).rejects.toThrow("cart not found")
  })

  it("returns 404 when the cart's Mercado Pago session is a card session", async () => {
    const { req, res } = buildReq(
      cartWithSessions([
        { id: "payses_card", provider_id: "pp_mercadopago", status: "pending", data: { payment_method_id: "visa" } },
      ])
    )

    await expect(GET(req, res)).rejects.toThrow("no Pix payment session")
    expect(orderGetMock).not.toHaveBeenCalled()
  })

  it("only looks at sessions of the requested cart (another provider's session is ignored)", async () => {
    const { req, res } = buildReq(
      cartWithSessions([{ id: "payses_other", provider_id: "pp_system_default", status: "pending", data: { payment_method_id: "pix" } }])
    )

    await expect(GET(req, res)).rejects.toThrow("no Pix payment session")
  })
})
