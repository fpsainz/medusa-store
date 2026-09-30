const revokeRunMock = jest.fn()

jest.mock("../../../../../../workflows/payment-access/revoke-payment-session-access", () => ({
  revokePaymentSessionAccessWorkflow: jest.fn(() => ({ run: (...args: unknown[]) => revokeRunMock(...args) })),
}))

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { POST } from "../route"

beforeEach(() => {
  revokeRunMock.mockReset()
  revokeRunMock.mockResolvedValue({ result: 0 })
})

const PAYMENT_COLLECTION_ID = "paycol_123"

function buildReq(overrides: {
  body: Record<string, unknown>
  paymentSession?: Record<string, unknown>
  cartGraphData?: unknown[]
  updatePaymentSession?: jest.Mock
  cardAttempts?: Record<string, jest.Mock>
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
  const logger = { warn: jest.fn() }
  const cardAttempts = overrides.cardAttempts ?? {
    listMercadopagoCardAttempts: jest.fn(async () => []),
    submitAttempt: jest.fn(async () => ({ id: "mpca_new" })),
    replaceSubmitted: jest.fn(async () => ({ id: "mpca_old", state: "replaced" })),
  }

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

        if (key === ContainerRegistrationKeys.LOGGER) {
          return logger
        }

        if (key === "mercadopagoCardAttempt") {
          return cardAttempts
        }

        throw new Error(`Unexpected module request: ${key}`)
      },
    },
  }

  return { req, logger, retrievePaymentSession, updatePaymentSession, authorizePaymentSession, graph, cardAttempts }
}

describe("mercadopago payment session route — Pix payment capability revocation", () => {
  const pixSession = {
    id: "payses_123",
    amount: 100,
    currency_code: "BRL",
    provider_id: "pp_mercadopago",
    payment_collection_id: PAYMENT_COLLECTION_ID,
    data: { payment_method_id: "pix", cart_id: "cart_123", mercadopago_order_id: "ORD_PIX_A" },
  }
  const cardBody = {
    cart_id: "cart_123",
    card_token: "cardtoken_123",
    payment_method_id: "visa",
    payment_type_id: "credit_card",
    installments: 1,
    transaction_amount: 100,
  }

  it("revokes the session's Pix capabilities when it switches from Pix to card", async () => {
    const { req } = buildReq({ paymentSession: pixSession, body: cardBody })
    const res: any = { json: jest.fn() }

    await POST(req, res)

    expect(revokeRunMock).toHaveBeenCalledWith({
      input: { payment_session_id: "payses_123", reason: "payment_method_changed" },
    })
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it("does not revoke when the session stays Pix (resubmitted Pix data)", async () => {
    const { req } = buildReq({
      paymentSession: pixSession,
      body: { cart_id: "cart_123", payment_method_id: "pix", amount: 100 },
    })

    await POST(req, { json: jest.fn() } as any)

    expect(revokeRunMock).not.toHaveBeenCalled()
  })

  it("does not revoke for a card session updated with card data", async () => {
    const { req } = buildReq({
      paymentSession: { ...pixSession, data: { payment_method_id: "visa" } },
      body: cardBody,
    })

    await POST(req, { json: jest.fn() } as any)

    expect(revokeRunMock).not.toHaveBeenCalled()
  })

  it("still answers when the revocation fails (the read route rejects non-Pix sessions anyway)", async () => {
    revokeRunMock.mockRejectedValue(new Error("db down"))
    const { req, logger } = buildReq({ paymentSession: pixSession, body: cardBody })
    const res: any = { json: jest.fn() }

    await POST(req, res)

    expect(res.json).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("payses_123"))
  })
})

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
          card_attempt_id: "mpca_new",
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

  describe("payment_type_id (card type from the Payment Brick)", () => {
    const CARD_BODY = {
      cart_id: "cart_123",
      card_token: "cardtoken_123",
      payment_method_id: "visa",
      installments: 1,
    }

    it.each(["credit_card", "debit_card"])("accepts payment_type_id=%p", async (paymentTypeId) => {
      const { req, updatePaymentSession } = buildReq({ body: { ...CARD_BODY, payment_type_id: paymentTypeId } })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data.payment_type_id).toBe(paymentTypeId)
    })

    it.each([["prepaid_card"], ["foo"], ["creditCard"], ["debitCard"], [""], [null], [1]])(
      "rejects payment_type_id=%p without updating the session",
      async (paymentTypeId) => {
        const { req, updatePaymentSession } = buildReq({ body: { ...CARD_BODY, payment_type_id: paymentTypeId } })

        await expect(POST(req, { json: jest.fn() } as any)).rejects.toThrow(
          /payment_type_id must be credit_card or debit_card/
        )
        expect(updatePaymentSession).not.toHaveBeenCalled()
      }
    )

    it("drops a card type left over from an earlier card when a new card is submitted without one", async () => {
      const { req, updatePaymentSession } = buildReq({
        body: CARD_BODY,
        paymentSession: {
          id: "payses_123",
          amount: 100,
          currency_code: "BRL",
          provider_id: "pp_mercadopago",
          payment_collection_id: PAYMENT_COLLECTION_ID,
          data: { existing: true, payment_type_id: "debit_card" },
        },
      })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data).not.toHaveProperty("payment_type_id")
      expect(updateInput.data.card_attempt_id).toBe("mpca_new")
      expect(updateInput.data).not.toHaveProperty("card_token")
    })

    it("leaves a Pix update without payment_type_id untouched", async () => {
      const { req, updatePaymentSession } = buildReq({
        body: { cart_id: "cart_123", payment_method_id: "pix", payer: { email: "customer@example.com" } },
      })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data).toEqual({
        existing: true,
        cart_id: "cart_123",
        payment_method_id: "pix",
        payer: { email: "customer@example.com" },
      })
    })
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

describe("mercadopago payment session route — Pix payer name from the billing address (ADR-010)", () => {
  const cartWithBilling = (billing_address: unknown) => [
    { id: "cart_123", payment_collection: { id: PAYMENT_COLLECTION_ID }, billing_address },
  ]
  const pixBody = (payer: Record<string, unknown>) => ({
    cart_id: "cart_123",
    payment_method_id: "pix",
    amount: 100,
    payer,
  })

  it("reads the billing name in the same cart query used for the ownership check", async () => {
    const { req, graph } = buildReq({
      body: pixBody({ email: "buyer@example.com" }),
      cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
    })

    await POST(req, { json: jest.fn() } as any)

    expect(graph).toHaveBeenCalledTimes(1)
    expect((graph.mock.calls[0] as any)[0].fields).toEqual(
      expect.arrayContaining(["payment_collection.id", "billing_address.first_name", "billing_address.last_name"])
    )
  })

  it("PS1: persists the billing first/last name in a Pix session's payer, keeping the rest of the payer", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: pixBody({ email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } }),
      cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({
      email: "buyer@example.com",
      identification: { type: "CPF", number: "12345678909" },
      first_name: "João",
      last_name: "Silva",
    })
  })

  it("PS2: ignores a first/last name sent by the client; the name always comes from the billing address", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: pixBody({ email: "buyer@example.com", first_name: "Atacante", last_name: "Nome" }),
      cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({ email: "buyer@example.com", first_name: "João", last_name: "Silva" })
  })

  it("PS2: without a billing name, a client-sent name is still not persisted", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: pixBody({ email: "buyer@example.com", first_name: "Atacante", last_name: "Nome" }),
      cartGraphData: cartWithBilling(null),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({ email: "buyer@example.com" })
  })

  it.each([
    ["absent", {}],
    ["empty", { first_name: "", last_name: "" }],
    ["whitespace only", { first_name: "   ", last_name: "\t" }],
    ["not a string", { first_name: 1, last_name: null }],
  ])("PS3: omits the name when the billing name is %s (no empty string, no placeholder)", async (_label, billing) => {
    const { req, updatePaymentSession } = buildReq({
      body: pixBody({ email: "buyer@example.com" }),
      cartGraphData: cartWithBilling(billing),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({ email: "buyer@example.com" })
  })

  it("PS3: keeps only the part of the name that is present and trims it", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: pixBody({ email: "buyer@example.com" }),
      cartGraphData: cartWithBilling({ first_name: "  APRO  ", last_name: " " }),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({ email: "buyer@example.com", first_name: "APRO" })
  })

  it("replaces a name persisted earlier with the current billing name when the Pix data is resubmitted", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: pixBody({ email: "buyer@example.com" }),
      paymentSession: {
        id: "payses_123",
        amount: 100,
        currency_code: "BRL",
        provider_id: "pp_mercadopago",
        payment_collection_id: PAYMENT_COLLECTION_ID,
        data: { payment_method_id: "pix", payer: { email: "buyer@example.com", first_name: "João", last_name: "Silva" } },
      },
      cartGraphData: cartWithBilling({ first_name: "Maria", last_name: "Silva" }),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payer).toEqual({ email: "buyer@example.com", first_name: "Maria", last_name: "Silva" })
  })

  it("does not create a payer when the Pix update carries none", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: { cart_id: "cart_123", payment_method_id: "pix", amount: 100 },
      cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).not.toHaveProperty("payer")
  })

  describe("PS4: card sessions", () => {
    const cardBody = {
      cart_id: "cart_123",
      card_token: "cardtoken_123",
      payment_method_id: "visa",
      payment_type_id: "credit_card",
      installments: 1,
      transaction_amount: 100,
      payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    }

    it("never adds the billing name to a card session's payer", async () => {
      const { req, updatePaymentSession } = buildReq({
        body: cardBody,
        cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
      })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data.payer).toEqual(cardBody.payer)
    })

    it("does not carry a name persisted by an earlier Pix selection into the card payer", async () => {
      const { req, updatePaymentSession } = buildReq({
        body: cardBody,
        paymentSession: {
          id: "payses_123",
          amount: 100,
          currency_code: "BRL",
          provider_id: "pp_mercadopago",
          payment_collection_id: PAYMENT_COLLECTION_ID,
          data: { payment_method_id: "pix", payer: { email: "buyer@example.com", first_name: "João", last_name: "Silva" } },
        },
        cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
      })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data.payer).toEqual(cardBody.payer)
      expect(updateInput.data.payment_method_id).toBe("visa")
    })

    it("removes an inherited Pix name even when the card update sends no payer", async () => {
      const { payer: _payer, ...cardBodyWithoutPayer } = cardBody
      const { req, updatePaymentSession } = buildReq({
        body: cardBodyWithoutPayer,
        paymentSession: {
          id: "payses_123",
          amount: 100,
          currency_code: "BRL",
          provider_id: "pp_mercadopago",
          payment_collection_id: PAYMENT_COLLECTION_ID,
          data: { payment_method_id: "pix", payer: { email: "buyer@example.com", first_name: "João", last_name: "Silva" } },
        },
        cartGraphData: cartWithBilling({ first_name: "João", last_name: "Silva" }),
      })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data.payer).toEqual({ email: "buyer@example.com" })
    })
  })
})

// INV-009 / ADR-015: the card token goes only to the card attempt module;
// PaymentSession.data keeps card_attempt_id; a blocking attempt freezes the
// session.
describe("mercadopago payment session route — card attempt (INV-009)", () => {
  const CARD_BODY = {
    cart_id: "cart_123",
    card_token: "cardtoken_SECRET",
    payment_method_id: "visa",
    payment_type_id: "credit_card",
    installments: 1,
    transaction_amount: 100,
    payer: { email: "customer@example.com" },
  }
  const session = (data: Record<string, unknown>) => ({
    id: "payses_123",
    amount: 100,
    currency_code: "BRL",
    provider_id: "pp_mercadopago",
    payment_collection_id: PAYMENT_COLLECTION_ID,
    data,
  })

  it("sends the card token to submitAttempt and keeps only card_attempt_id in the session data", async () => {
    const { req, updatePaymentSession, cardAttempts } = buildReq({ body: CARD_BODY })
    const res: any = { json: jest.fn() }

    await POST(req, res)

    expect(cardAttempts.submitAttempt).toHaveBeenCalledWith({
      payment_session_id: "payses_123",
      cart_id: "cart_123",
      card_token: "cardtoken_SECRET",
    })
    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.card_attempt_id).toBe("mpca_new")
    expect(updateInput.data.payment_type_id).toBe("credit_card")
    expect(updateInput.data.installments).toBe(1)
    expect(JSON.stringify(updateInput)).not.toContain("cardtoken_SECRET")
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("cardtoken_SECRET")
  })

  it("looks for a blocking attempt with the blocking states only, without reading the ciphertext", async () => {
    const { req, cardAttempts } = buildReq({ body: CARD_BODY })

    await POST(req, { json: jest.fn() } as any)

    expect(cardAttempts.listMercadopagoCardAttempts).toHaveBeenCalledWith(
      { payment_session_id: "payses_123", state: ["authorizing", "unknown", "expired"] },
      { select: ["id", "state"], take: 1 }
    )
  })

  it.each([
    ["authorizing", "card_attempt_pending"],
    ["unknown", "card_attempt_pending"],
    ["expired", "card_attempt_manual_review"],
  ])("refuses a new card while an attempt is %s (%s), without creating an attempt nor updating", async (state, code) => {
    const cardAttempts = {
      listMercadopagoCardAttempts: jest.fn(async () => [{ id: "mpca_open", state }]),
      submitAttempt: jest.fn(),
      replaceSubmitted: jest.fn(),
    }
    const { req, updatePaymentSession } = buildReq({ body: CARD_BODY, cardAttempts })

    await expect(POST(req, { json: jest.fn() } as any)).rejects.toMatchObject({ code })
    expect(cardAttempts.submitAttempt).not.toHaveBeenCalled()
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("the freeze also refuses a switch to Pix and an update without a new card", async () => {
    for (const body of [
      { cart_id: "cart_123", payment_method_id: "pix", payer: { email: "c@example.com" } },
      { cart_id: "cart_123", installments: 3 },
    ]) {
      const cardAttempts = {
        listMercadopagoCardAttempts: jest.fn(async () => [{ id: "mpca_open", state: "unknown" }]),
        submitAttempt: jest.fn(),
        replaceSubmitted: jest.fn(),
      }
      const { req, updatePaymentSession } = buildReq({
        body,
        cardAttempts,
        paymentSession: session({ payment_method_id: "visa", card_attempt_id: "mpca_open" }),
      })

      await expect(POST(req, { json: jest.fn() } as any)).rejects.toMatchObject({ code: "card_attempt_pending" })
      expect(updatePaymentSession).not.toHaveBeenCalled()
      expect(cardAttempts.replaceSubmitted).not.toHaveBeenCalled()
    }
  })

  it("propagates a refusal of submitAttempt (a concurrent authorization) without updating the session", async () => {
    const cardAttempts = {
      listMercadopagoCardAttempts: jest.fn(async () => []),
      submitAttempt: jest.fn(async () => {
        throw Object.assign(new Error("A previous card payment attempt is still being confirmed."), {
          code: "card_attempt_pending",
        })
      }),
      replaceSubmitted: jest.fn(),
    }
    const { req, updatePaymentSession } = buildReq({ body: CARD_BODY, cardAttempts })

    await expect(POST(req, { json: jest.fn() } as any)).rejects.toMatchObject({ code: "card_attempt_pending" })
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("removes a card_token persisted by an older version from the session data", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: { cart_id: "cart_123", installments: 2 },
      paymentSession: session({ payment_method_id: "visa", card_token: "legacy_token", card_attempt_id: "mpca_keep" }),
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).not.toHaveProperty("card_token")
    expect(updateInput.data.card_attempt_id).toBe("mpca_keep")
    expect(updateInput.data.installments).toBe(2)
  })

  it("an update without a new card keeps the attempt and creates none", async () => {
    const { req, updatePaymentSession, cardAttempts } = buildReq({
      body: { cart_id: "cart_123", installments: 3 },
      paymentSession: session({ payment_method_id: "visa", payment_type_id: "credit_card", card_attempt_id: "mpca_keep" }),
    })

    await POST(req, { json: jest.fn() } as any)

    expect(cardAttempts.submitAttempt).not.toHaveBeenCalled()
    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).toMatchObject({ card_attempt_id: "mpca_keep", payment_type_id: "credit_card", installments: 3 })
  })

  it("never accepts a card_attempt_id sent by the client", async () => {
    const { req, updatePaymentSession } = buildReq({
      body: { cart_id: "cart_123", installments: 1, card_attempt_id: "mpca_forged" },
    })

    await POST(req, { json: jest.fn() } as any)

    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data).not.toHaveProperty("card_attempt_id")
  })

  it("switching to Pix releases the submitted card attempt (rule 2) and drops card_attempt_id", async () => {
    const { req, updatePaymentSession, cardAttempts } = buildReq({
      body: { cart_id: "cart_123", payment_method_id: "pix", card_token: "ignored_token", payer: { email: "c@example.com" } },
      paymentSession: session({ payment_method_id: "visa", payment_type_id: "credit_card", card_attempt_id: "mpca_old" }),
    })

    await POST(req, { json: jest.fn() } as any)

    expect(cardAttempts.replaceSubmitted).toHaveBeenCalledWith("mpca_old")
    expect(cardAttempts.submitAttempt).not.toHaveBeenCalled()
    const [[updateInput]] = updatePaymentSession.mock.calls
    expect(updateInput.data.payment_method_id).toBe("pix")
    expect(updateInput.data).not.toHaveProperty("card_attempt_id")
    expect(updateInput.data).not.toHaveProperty("card_token")
  })

  it.each(["card_attempt_conflict", "card_attempt_not_found"])(
    "switching to Pix with an attempt already final (%s) still updates the session",
    async (code) => {
      const cardAttempts = {
        listMercadopagoCardAttempts: jest.fn(async () => []),
        submitAttempt: jest.fn(),
        replaceSubmitted: jest.fn(async () => {
          throw Object.assign(new Error("x"), { code })
        }),
      }
      const { req, updatePaymentSession } = buildReq({
        body: { cart_id: "cart_123", payment_method_id: "pix" },
        cardAttempts,
        paymentSession: session({ payment_method_id: "visa", card_attempt_id: "mpca_done" }),
      })

      await POST(req, { json: jest.fn() } as any)

      const [[updateInput]] = updatePaymentSession.mock.calls
      expect(updateInput.data).not.toHaveProperty("card_attempt_id")
    }
  )
})
