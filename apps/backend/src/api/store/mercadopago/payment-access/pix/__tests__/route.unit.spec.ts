const orderGetMock = jest.fn()

jest.mock("mercadopago", () => ({
  MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
  Order: jest.fn().mockImplementation(() => ({
    get: (...args: unknown[]) => orderGetMock(...args),
  })),
}))

import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

import { PAYMENT_ACCESS_MODULE } from "../../../../../../modules/payment-access"
import { GET } from "../route"

const TOKEN = `pat_${"A".repeat(43)}`
const FUTURE_DEADLINE = new Date(Date.now() + 30 * 60 * 1000).toISOString()

const GRANT = {
  id: "pag_1",
  purpose: "pix_payment_view",
  provider_id: "pp_mercadopago",
  payment_method: "pix",
  payment_session_id: "payses_pix",
  payment_collection_id: "paycol_1",
  cart_id: "cart_1",
  expires_at: FUTURE_DEADLINE,
  revoked_at: null,
}

const SESSION = {
  id: "payses_pix",
  provider_id: "pp_mercadopago",
  payment_collection_id: "paycol_1",
  status: "pending",
  data: {
    payment_method_id: "pix",
    cart_id: "cart_1",
    card_token: "tok_should_not_leak",
    payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    mercadopago_idempotency_key: "base-key",
    mercadopago_pix_idempotency_key: "pix-key",
    mercadopago_order_id: "ORD_PIX_A",
    mercadopago_payment_id: "PAY_PIX_A",
    mercadopago_order_payment_method: "pix",
    mercadopago_order_status: "action_required",
    mercadopago_order_status_detail: "waiting_transfer",
    mercadopago_pix_qr_code: "000201",
    mercadopago_pix_qr_code_base64: "iVBOR",
    mercadopago_pix_ticket_url: "https://ticket",
    mercadopago_pix_expires_at: FUTURE_DEADLINE,
  },
}

function liveOrder(status: string) {
  return {
    id: "ORD_PIX_A",
    status,
    status_detail: status,
    transactions: { payments: [{ id: "PAY_PIX_A", status, status_detail: status }] },
  }
}

function build(overrides: {
  headers?: Record<string, unknown>
  query?: Record<string, unknown>
  grant?: Record<string, unknown> | null
  sessions?: unknown[]
  collections?: unknown[]
} = {}) {
  const findUsableGrant = jest.fn(async () => ("grant" in overrides ? overrides.grant : GRANT))
  const listPaymentSessions = jest.fn(async () => overrides.sessions ?? [SESSION])
  const graph = jest.fn(async () => ({
    data: overrides.collections ?? [{ id: "paycol_1", order: { id: "order_1" } }],
  }))

  const req: any = {
    headers: overrides.headers ?? { "x-payment-access-token": TOKEN },
    query: overrides.query ?? {},
    params: {},
    scope: {
      resolve: (key: string) => {
        if (key === PAYMENT_ACCESS_MODULE) return { findUsableGrant }
        if (key === Modules.PAYMENT) return { listPaymentSessions }
        if (key === ContainerRegistrationKeys.QUERY) return { graph }
        throw new Error(`Unexpected module request: ${key}`)
      },
    },
  }
  const res: any = { json: jest.fn(), setHeader: jest.fn() }

  return { req, res, findUsableGrant, listPaymentSessions, graph }
}

async function expectGenericNotFound(ctx: ReturnType<typeof build>) {
  const error = await GET(ctx.req, ctx.res).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(MedusaError)
  expect((error as MedusaError).type).toBe(MedusaError.Types.NOT_FOUND)
  expect((error as MedusaError).message).toBe("Payment not found.")
  expect(ctx.res.json).not.toHaveBeenCalled()
}

describe("GET /store/mercadopago/payment-access/pix", () => {
  const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.MERCADOPAGO_ACCESS_TOKEN = "test-access-token"
    orderGetMock.mockResolvedValue(liveOrder("action_required"))
  })

  afterAll(() => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  })

  it("returns the allowlisted Pix view, resolving session and order from the capability only", async () => {
    const ctx = build()

    await GET(ctx.req, ctx.res)

    expect(ctx.findUsableGrant).toHaveBeenCalledWith(TOKEN, "pix_payment_view")
    expect(ctx.listPaymentSessions).toHaveBeenCalledWith({ id: "payses_pix" }, expect.anything())
    expect(ctx.graph).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "payment_collection", filters: { id: "paycol_1" } }),
      { throwIfKeyNotFound: false }
    )
    expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_PIX_A" })
    expect(ctx.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")
    expect(ctx.res.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer")

    const dto = ctx.res.json.mock.calls[0][0]
    expect(dto).toEqual(
      expect.objectContaining({ status: "pending", order_id: "order_1", qr_code: "000201", ticket_url: "https://ticket" })
    )
    expect(Object.keys(dto).every((key) =>
      ["status", "order_id", "charge_ref", "qr_code", "qr_code_base64", "ticket_url", "expires_at"].includes(key)
    )).toBe(true)
    expect(JSON.stringify(dto)).not.toMatch(
      /tok_should_not_leak|buyer@example|12345678909|base-key|pix-key|ORD_PIX_A|PAY_PIX_A|payses_pix|paycol_1|cart_1|pag_1|test-access-token|pat_/
    )
  })

  it("returns order_id null while the cart is not completed yet", async () => {
    const ctx = build({ collections: [{ id: "paycol_1", order: null }] })

    await GET(ctx.req, ctx.res)

    expect(ctx.res.json.mock.calls[0][0].order_id).toBeNull()
  })

  it("after approval returns the status only", async () => {
    const ctx = build({ sessions: [{ ...SESSION, status: "authorized" }] })

    await GET(ctx.req, ctx.res)

    expect(orderGetMock).not.toHaveBeenCalled()
    expect(ctx.res.json.mock.calls[0][0]).toEqual({ status: "approved", order_id: "order_1" })
  })

  it("reflects a live final state (canceled) with the status only", async () => {
    orderGetMock.mockResolvedValue(liveOrder("canceled"))
    const ctx = build()

    await GET(ctx.req, ctx.res)

    expect(ctx.res.json.mock.calls[0][0]).toEqual({ status: "canceled", order_id: "order_1" })
  })

  it("answers from the stored state when Mercado Pago is unreachable", async () => {
    orderGetMock.mockRejectedValue(new Error("network"))
    const ctx = build()

    await GET(ctx.req, ctx.res)

    expect(ctx.res.json.mock.calls[0][0].status).toBe("pending")
  })

  it("past the deadline stops exposing the QR", async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString()
    const ctx = build({
      sessions: [{ ...SESSION, data: { ...SESSION.data, mercadopago_pix_expires_at: past } }],
    })

    await GET(ctx.req, ctx.res)

    expect(ctx.res.json.mock.calls[0][0]).toEqual({ status: "expired", order_id: "order_1" })
  })

  describe("uniform failure", () => {
    it("no token header", async () => {
      const ctx = build({ headers: {} })
      await expectGenericNotFound(ctx)
      expect(ctx.findUsableGrant).not.toHaveBeenCalled()
    })

    it("token only in the query string is never read", async () => {
      const ctx = build({ headers: {}, query: { token: TOKEN, "x-payment-access-token": TOKEN } })
      await expectGenericNotFound(ctx)
      expect(ctx.findUsableGrant).not.toHaveBeenCalled()
    })

    it("repeated token header", async () => {
      await expectGenericNotFound(build({ headers: { "x-payment-access-token": [TOKEN, TOKEN] } }))
    })

    it("unknown, expired, revoked or wrong-purpose token (module returns null)", async () => {
      await expectGenericNotFound(build({ grant: null }))
    })

    it("grant for another provider or payment method", async () => {
      await expectGenericNotFound(build({ grant: { ...GRANT, provider_id: "pp_other" } }))
      await expectGenericNotFound(build({ grant: { ...GRANT, payment_method: "boleto" } }))
    })

    it("payment session no longer exists", async () => {
      await expectGenericNotFound(build({ sessions: [] }))
    })

    it("session moved to another payment collection", async () => {
      await expectGenericNotFound(build({ sessions: [{ ...SESSION, payment_collection_id: "paycol_other" }] }))
    })

    it("session switched to card", async () => {
      await expectGenericNotFound(
        build({ sessions: [{ ...SESSION, data: { ...SESSION.data, payment_method_id: "visa" } }] })
      )
    })

    it("session of another provider", async () => {
      await expectGenericNotFound(build({ sessions: [{ ...SESSION, provider_id: "pp_system_default" }] }))
    })

    it("session without a Pix charge", async () => {
      await expectGenericNotFound(
        build({ sessions: [{ ...SESSION, data: { payment_method_id: "pix" } }] })
      )
    })
  })
})
