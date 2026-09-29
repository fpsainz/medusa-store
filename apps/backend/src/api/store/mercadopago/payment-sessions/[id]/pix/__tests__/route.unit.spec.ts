const issueRunMock = jest.fn()

jest.mock("../../../../../../../workflows/payment-access/issue-pix-payment-access", () => ({
  issuePixPaymentAccessWorkflow: jest.fn(() => ({ run: (...args: unknown[]) => issueRunMock(...args) })),
}))

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { POST } from "../route"

const ISSUED = {
  token: `pat_${"A".repeat(43)}`,
  expires_at: "2026-09-27T13:15:00.000Z",
}

beforeEach(() => {
  issueRunMock.mockReset()
  issueRunMock.mockResolvedValue({ result: null })
})

const PAYMENT_COLLECTION_ID = "paycol_123"

const PIX_SESSION = {
  id: "payses_pix",
  amount: 50,
  currency_code: "brl",
  provider_id: "pp_mercadopago",
  payment_collection_id: PAYMENT_COLLECTION_ID,
  status: "pending",
  data: {
    payment_method_id: "pix",
    cart_id: "cart_123",
    payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    mercadopago_idempotency_key: "base-key",
  },
}

const PREPARED_DATA = {
  ...PIX_SESSION.data,
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

function buildReq(overrides: {
  body?: Record<string, unknown>
  paymentSession?: Record<string, unknown>
  retrievePaymentSession?: jest.Mock
  cartGraphData?: unknown[]
} = {}) {
  const paymentSession = overrides.paymentSession ?? PIX_SESSION

  const retrievePaymentSession =
    overrides.retrievePaymentSession ?? jest.fn(async () => paymentSession)
  const updatePaymentSession = jest.fn(async (input) => ({
    ...paymentSession,
    status: "pending",
    data: PREPARED_DATA,
    id: input.id,
  }))
  const authorizePaymentSession = jest.fn()

  const cartGraphData = overrides.cartGraphData ?? [
    { id: "cart_123", completed_at: null, payment_collection: { id: PAYMENT_COLLECTION_ID } },
  ]
  const graph = jest.fn(async () => ({ data: cartGraphData }))

  const logger = { warn: jest.fn() }

  const req: any = {
    params: { id: paymentSession.id },
    body: overrides.body ?? { cart_id: "cart_123" },
    scope: {
      resolve: (key: string) => {
        if (key === Modules.PAYMENT) {
          return { retrievePaymentSession, updatePaymentSession, authorizePaymentSession }
        }
        if (key === ContainerRegistrationKeys.QUERY) {
          return { graph }
        }
        if (key === ContainerRegistrationKeys.LOGGER) {
          return logger
        }
        throw new Error(`Unexpected module request: ${key}`)
      },
    },
  }

  const res: any = { json: jest.fn(), setHeader: jest.fn() }

  return { req, res, logger, graph, retrievePaymentSession, updatePaymentSession, authorizePaymentSession }
}

describe("POST /store/mercadopago/payment-sessions/:id/pix — Pix payment capability", () => {
  const tokenHeaderCalls = (res: any) =>
    res.setHeader.mock.calls.filter(([name]: [string]) => name.startsWith("x-payment-access"))

  it("issues the capability for the prepared session and sends it only in response headers", async () => {
    issueRunMock.mockResolvedValue({ result: ISSUED })
    const { req, res } = buildReq()

    await POST(req, res)

    expect(issueRunMock).toHaveBeenCalledWith({
      input: { cart_id: "cart_123", payment_session_id: "payses_pix" },
    })
    expect(res.setHeader).toHaveBeenCalledWith("x-payment-access-token", ISSUED.token)
    expect(res.setHeader).toHaveBeenCalledWith("x-payment-access-expires-at", ISSUED.expires_at)
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(ISSUED.token)
  })

  it("also issues it when the session is already authorized (paid before Place order)", async () => {
    issueRunMock.mockResolvedValue({ result: ISSUED })
    const { req, res } = buildReq({
      paymentSession: { ...PIX_SESSION, status: "authorized", data: PREPARED_DATA },
    })

    await POST(req, res)

    expect(issueRunMock).toHaveBeenCalledTimes(1)
    expect(res.setHeader).toHaveBeenCalledWith("x-payment-access-token", ISSUED.token)
  })

  it("sends no capability header when none may be issued", async () => {
    const { req, res } = buildReq()

    await POST(req, res)

    expect(tokenHeaderCalls(res)).toHaveLength(0)
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it("still prepares the Pix charge when issuing the capability fails", async () => {
    issueRunMock.mockRejectedValue(new Error('relation "payment_access_grant" does not exist'))
    const { req, res, logger } = buildReq()

    await POST(req, res)

    expect(res.json).toHaveBeenCalledTimes(1)
    expect(tokenHeaderCalls(res)).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("payses_pix"))
  })

  it("issues again on every call (repeated/concurrent prepares); the module keeps at most 3 active", async () => {
    issueRunMock.mockResolvedValue({ result: ISSUED })
    const first = buildReq()
    const second = buildReq({ paymentSession: { ...PIX_SESSION, data: PREPARED_DATA } })

    await Promise.all([POST(first.req, first.res), POST(second.req, second.res)])

    expect(issueRunMock).toHaveBeenCalledTimes(2)
  })

  it("never issues for a completed cart, another cart's session or a non-Pix session", async () => {
    const completed = buildReq({
      cartGraphData: [{ id: "cart_123", completed_at: "2026-09-27T12:00:00.000Z", payment_collection: { id: PAYMENT_COLLECTION_ID } }],
    })
    await expect(POST(completed.req, completed.res)).rejects.toThrow()

    const otherCart = buildReq({
      cartGraphData: [{ id: "cart_123", completed_at: null, payment_collection: { id: "paycol_other" } }],
    })
    await expect(POST(otherCart.req, otherCart.res)).rejects.toThrow()

    const card = buildReq({
      paymentSession: { ...PIX_SESSION, data: { ...PIX_SESSION.data, payment_method_id: "visa" } },
    })
    await expect(POST(card.req, card.res)).rejects.toThrow()

    expect(issueRunMock).not.toHaveBeenCalled()
  })
})

describe("POST /store/mercadopago/payment-sessions/:id/pix", () => {
  it("prepares the Pix charge through the Payment Module and returns the safe DTO", async () => {
    const { req, res, updatePaymentSession, authorizePaymentSession } = buildReq()

    await POST(req, res)

    expect(updatePaymentSession).toHaveBeenCalledWith({
      id: "payses_pix",
      currency_code: "brl",
      amount: 50,
      data: { ...PIX_SESSION.data, mercadopago_pix_action: "prepare" },
    })
    expect(authorizePaymentSession).not.toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")

    const dto = res.json.mock.calls[0][0]
    expect(dto).toEqual(
      expect.objectContaining({
        status: "pending",
        qr_code: "000201",
        qr_code_base64: "iVBOR",
        ticket_url: "https://ticket",
        expires_at: "2026-09-26T12:00:00.000-03:00",
      })
    )
    expect(typeof dto.charge_ref).toBe("string")
    expect(JSON.stringify(dto)).not.toMatch(
      /buyer@example|12345678909|pix-key|base-key|ORD_PIX_A|action_required|waiting_transfer/
    )
  })

  it("passes 'regenerate' only when explicitly requested", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      body: { cart_id: "cart_123", regenerate: true },
    })

    await POST(req, res)

    expect(updatePaymentSession.mock.calls[0][0].data.mercadopago_pix_action).toBe("regenerate")
  })

  it("a repeated call is forwarded as another 'prepare' (the provider reuses the charge)", async () => {
    const first = buildReq()
    await POST(first.req, first.res)
    const second = buildReq({ paymentSession: { ...PIX_SESSION, data: PREPARED_DATA } })
    await POST(second.req, second.res)

    expect(second.updatePaymentSession.mock.calls[0][0].data).toEqual({
      ...PREPARED_DATA,
      mercadopago_pix_action: "prepare",
    })
    // Same charge → same opaque reference, so the Review does not reopen the QR.
    expect(second.res.json.mock.calls[0][0].charge_ref).toBe(first.res.json.mock.calls[0][0].charge_ref)
  })

  it("does not update an already authorized (paid) session", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      paymentSession: { ...PIX_SESSION, status: "authorized", data: PREPARED_DATA },
    })

    await POST(req, res)

    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(res.json.mock.calls[0][0].status).toBe("approved")
  })

  it("propagates the Payment Module error for a nonexistent session", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      retrievePaymentSession: jest.fn(async () => {
        throw new Error("PaymentSession with id: payses_x was not found")
      }),
    })

    await expect(POST(req, res)).rejects.toThrow("was not found")
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("rejects a session that belongs to another cart", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      cartGraphData: [{ id: "cart_123", payment_collection: { id: "paycol_other" } }],
    })

    await expect(POST(req, res)).rejects.toThrow("does not belong to the given cart")
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("rejects an unknown cart", async () => {
    const { req, res, updatePaymentSession } = buildReq({ cartGraphData: [] })

    await expect(POST(req, res)).rejects.toThrow("does not belong to the given cart")
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("rejects a session of a different provider", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      paymentSession: { ...PIX_SESSION, provider_id: "pp_stripe_stripe" },
    })

    await expect(POST(req, res)).rejects.toThrow("does not belong to the Mercado Pago provider")
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("rejects a Mercado Pago session that is not Pix (card is never prepared)", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      paymentSession: { ...PIX_SESSION, data: { payment_method_id: "visa", card_token: "tok" } },
    })

    await expect(POST(req, res)).rejects.toThrow("not a Pix payment")
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("rejects a completed cart", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      cartGraphData: [
        { id: "cart_123", completed_at: "2026-09-25T10:00:00Z", payment_collection: { id: PAYMENT_COLLECTION_ID } },
      ],
    })

    await expect(POST(req, res)).rejects.toThrow("already completed")
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("requires cart_id", async () => {
    const { req, res, retrievePaymentSession } = buildReq({ body: {} })

    await expect(POST(req, res)).rejects.toThrow("cart_id is required")
    expect(retrievePaymentSession).not.toHaveBeenCalled()
  })
})

describe("POST /store/mercadopago/payment-sessions/:id/pix — payer comes from the persisted session (ADR-010)", () => {
  const NAMED_PIX_SESSION = {
    ...PIX_SESSION,
    data: {
      ...PIX_SESSION.data,
      payer: { ...PIX_SESSION.data.payer, first_name: "João", last_name: "Silva" },
    },
  }

  it("PX1: hands session.data.payer to the provider unchanged", async () => {
    const { req, res, updatePaymentSession } = buildReq({ paymentSession: NAMED_PIX_SESSION })

    await POST(req, res)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).toEqual({ ...NAMED_PIX_SESSION.data, mercadopago_pix_action: "prepare" })
    expect(updateInput.data.payer).toEqual(NAMED_PIX_SESSION.data.payer)
  })

  it("PX2: reads the cart only for ownership and completion, never for payer data", async () => {
    const { req, res, graph } = buildReq({ paymentSession: NAMED_PIX_SESSION })

    await POST(req, res)

    expect(graph).toHaveBeenCalledTimes(1)
    const fields: string[] = (graph.mock.calls[0] as any)[0].fields
    expect(fields).toEqual(["id", "completed_at", "payment_collection.id"])
    expect(fields.some((field) => field.startsWith("billing_address") || field.startsWith("shipping_address"))).toBe(false)
  })

  it("PX3: a billing address changed after the payer was persisted does not change the payer of a new prepare", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      paymentSession: NAMED_PIX_SESSION,
      cartGraphData: [
        {
          id: "cart_123",
          completed_at: null,
          payment_collection: { id: PAYMENT_COLLECTION_ID },
          billing_address: { first_name: "Maria", last_name: "Souza" },
        },
      ],
    })

    await POST(req, res)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({
      email: "buyer@example.com",
      identification: { type: "CPF", number: "12345678909" },
      first_name: "João",
      last_name: "Silva",
    })
  })

  it("PX3: regenerate also keeps the persisted payer", async () => {
    const { req, res, updatePaymentSession } = buildReq({
      paymentSession: NAMED_PIX_SESSION,
      body: { cart_id: "cart_123", regenerate: true },
    })

    await POST(req, res)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.mercadopago_pix_action).toBe("regenerate")
    expect(updateInput.data.payer).toEqual(NAMED_PIX_SESSION.data.payer)
  })
})
