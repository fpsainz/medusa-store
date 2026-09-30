import { createHash } from "node:crypto"

const orderCreateMock = jest.fn()
const orderGetMock = jest.fn()
const orderCancelMock = jest.fn()

jest.mock("mercadopago", () => {
  return {
    MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
    Order: jest.fn().mockImplementation(() => ({
      create: (...args: unknown[]) => orderCreateMock(...args),
      get: (...args: unknown[]) => orderGetMock(...args),
      cancel: (...args: unknown[]) => orderCancelMock(...args),
    })),
  }
})

import { cardInput, createFakeCardAttempts, type FakeCardAttempts } from "../__fixtures__/fake-card-attempts"
import MercadoPagoPaymentProviderService, {
  PIX_EXPIRATION_TIME,
  classifyCardOrderError,
  computePixDeadline,
  normalizePixStatus,
  toPixPaymentDto,
} from "../service"

describe("MercadoPagoPaymentProviderService.authorizePayment", () => {
  let attempts: FakeCardAttempts

  function buildProvider() {
    // Cast to `any`: the abstract base's constructor is `protected` in its
    // `.d.ts`, which trips TS's construct-signature inference for `new` here
    // even though the concrete subclass constructor is public at runtime.
    const ProviderClass = MercadoPagoPaymentProviderService as any
    return new ProviderClass({ mercadopagoCardAttempt: attempts }, { access_token: "test-access-token" })
  }

  beforeEach(() => {
    jest.clearAllMocks()
    attempts = createFakeCardAttempts()
  })

  function mockCreatedOrder(overrides: Partial<Record<string, unknown>> = {}) {
    orderCreateMock.mockResolvedValue({
      id: "ORD_TEST_1",
      status: "processed",
      status_detail: "accredited",
      transactions: {
        payments: [
          {
            id: "PAY_TEST_1",
            status: "processed",
            status_detail: "accredited",
          },
        ],
      },
      ...overrides,
    })
  }

  // TESTE 1 — CARTÃO: comportamento atual preservado, sem regressão.
  it("card: creates a credit_card Order and returns captured, unchanged from before", async () => {
    mockCreatedOrder()
    const provider = buildProvider()

    const result = await provider.authorizePayment(
      cardInput(attempts, {
        payment_method_id: "visa",
        payment_type_id: "credit_card",
        card_token: "card_token_abc",
        issuer_id: "123",
        installments: 3,
        transaction_amount: 100,
        cart_id: "cart_123",
        payer: { email: "buyer@example.com" },
      })
    )

    expect(orderCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          transactions: {
            payments: [
              expect.objectContaining({
                amount: "100.00",
                payment_method: {
                  id: "visa",
                  token: "card_token_abc",
                  type: "credit_card",
                  installments: 3,
                },
              }),
            ],
          },
        }),
      })
    )
    expect(result.status).toBe("captured")
    expect(result.data.mercadopago_order_id).toBe("ORD_TEST_1")
  })

  describe("card payment type (payment_type_id → payment_method.type)", () => {
    const CARD_DATA = {
      payment_method_id: "debelo",
      card_token: "card_token_debit",
      installments: 1,
      transaction_amount: 100,
      cart_id: "cart_debit",
      payer: { email: "buyer@example.com" },
    }

    it("sends type debit_card for a debit card session, never credit_card", async () => {
      mockCreatedOrder()
      const provider = buildProvider()

      await provider.authorizePayment(cardInput(attempts, { ...CARD_DATA, payment_type_id: "debit_card" }))

      const [[createArgs]] = orderCreateMock.mock.calls
      expect(createArgs.body.transactions.payments[0].payment_method).toEqual({
        id: "debelo",
        token: "card_token_debit",
        type: "debit_card",
        installments: 1,
      })
    })

    it("refuses a card session without payment_type_id (never falls back to credit_card) and creates no Order", async () => {
      const provider = buildProvider()

      await expect(provider.authorizePayment(cardInput(attempts, { ...CARD_DATA }))).rejects.toThrow(
        /missing the card type\. Please re-enter your payment information/
      )

      expect(orderCreateMock).not.toHaveBeenCalled()
    })

    it.each(["prepaid_card", "creditCard", "debitCard", "", "foo"])(
      "refuses payment_type_id=%p and creates no Order",
      async (paymentTypeId) => {
        const provider = buildProvider()

        await expect(
          provider.authorizePayment(cardInput(attempts, { ...CARD_DATA, payment_type_id: paymentTypeId }))
        ).rejects.toThrow(/unsupported card payment type/)

        expect(orderCreateMock).not.toHaveBeenCalled()
      }
    )

    it("treats payment_type_id=null like a missing card type", async () => {
      const provider = buildProvider()

      await expect(
        provider.authorizePayment(cardInput(attempts, { ...CARD_DATA, payment_type_id: null }))
      ).rejects.toThrow(/missing the card type/)

      expect(orderCreateMock).not.toHaveBeenCalled()
    })

    it("does not require payment_type_id on the Pix path", async () => {
      orderCreateMock.mockResolvedValue({
        id: "ORD_PIX_TYPE",
        status: "action_required",
        status_detail: "waiting_transfer",
        total_amount: "100.00",
        transactions: { payments: [{ id: "PAY_PIX_TYPE", status: "action_required", status_detail: "waiting_transfer" }] },
      })
      const provider = buildProvider()

      const result = await provider.authorizePayment({
        data: {
          payment_method_id: "pix",
          transaction_amount: 100,
          cart_id: "cart_pix_type",
          payer: { email: "buyer@example.com" },
        },
      })

      expect(result.status).toBe("pending_authorization")
      const [[createArgs]] = orderCreateMock.mock.calls
      expect(createArgs.body.transactions.payments[0].payment_method).toEqual({ id: "pix", type: "bank_transfer" })
    })
  })

  // TESTE 2 — PRIMEIRA AUTORIZAÇÃO PIX
  it("pix: first authorization creates an Order with payment_method id=pix, type=bank_transfer, no card fields", async () => {
    mockCreatedOrder({
      status: "action_required",
      status_detail: "waiting_transfer",
      transactions: {
        payments: [
          {
            id: "PAY_PIX_1",
            status: "action_required",
            status_detail: "waiting_transfer",
          },
        ],
      },
    })
    const provider = buildProvider()

    await provider.authorizePayment({
      data: {
        payment_method_id: "pix",
        transaction_amount: 50,
        cart_id: "cart_pix_1",
        payer: { email: "buyer@example.com" },
      },
    })

    expect(orderCreateMock).toHaveBeenCalledTimes(1)
    const [call] = orderCreateMock.mock.calls
    const body = call[0].body
    expect(body.transactions.payments[0].payment_method).toEqual({
      id: "pix",
      type: "bank_transfer",
    })
    expect(body.transactions.payments[0]).not.toHaveProperty("payment_method.token")
    expect(body.processing_mode).toBe("automatic")

    const requestOptions = call[0].requestOptions
    expect(typeof requestOptions.idempotencyKey).toBe("string")
    expect(requestOptions.idempotencyKey.length).toBeGreaterThan(0)
  })

  // TESTE 3 — PIX PENDENTE
  it("pix: action_required + waiting_transfer maps to pending_authorization", async () => {
    mockCreatedOrder({
      status: "action_required",
      status_detail: "waiting_transfer",
      transactions: {
        payments: [
          {
            id: "PAY_PIX_2",
            status: "action_required",
            status_detail: "waiting_transfer",
          },
        ],
      },
    })
    const provider = buildProvider()

    const result = await provider.authorizePayment({
      data: {
        payment_method_id: "pix",
        transaction_amount: 50,
        cart_id: "cart_pix_2",
        payer: { email: "buyer@example.com" },
      },
    })

    expect(result.status).toBe("pending_authorization")
  })

  // TESTE 4 — DADOS PIX
  it("pix: persists qr_code/qr_code_base64/ticket_url/expiration/ids without destroying existing data", async () => {
    mockCreatedOrder({
      status: "action_required",
      status_detail: "waiting_transfer",
      transactions: {
        payments: [
          {
            id: "PAY_PIX_3",
            status: "action_required",
            status_detail: "waiting_transfer",
            date_of_expiration: "2026-09-22T12:00:00.000-03:00",
            payment_method: {
              qr_code: "00020126...pix-copia-e-cola",
              qr_code_base64: "",
              ticket_url: "https://www.mercadopago.com/payments/ticket",
            },
          },
        ],
      },
    })
    const provider = buildProvider()

    const result = await provider.authorizePayment({
      data: {
        payment_method_id: "pix",
        transaction_amount: 50,
        cart_id: "cart_pix_3",
        payer: { email: "buyer@example.com" },
        some_preexisting_field: "must-survive",
      },
    })

    expect(result.data.some_preexisting_field).toBe("must-survive")
    expect(result.data.mercadopago_order_id).toBe("ORD_TEST_1")
    expect(result.data.mercadopago_payment_id).toBe("PAY_PIX_3")
    expect(result.data.mercadopago_pix_qr_code).toBe("00020126...pix-copia-e-cola")
    // Empty string from the sandbox must be persisted as-is, not substituted.
    expect(result.data.mercadopago_pix_qr_code_base64).toBe("")
    expect(result.data.mercadopago_pix_ticket_url).toBe(
      "https://www.mercadopago.com/payments/ticket"
    )
    expect(result.data.mercadopago_pix_date_of_expiration).toBe(
      "2026-09-22T12:00:00.000-03:00"
    )
    // expiration_time was absent in the mocked response: must not be invented.
    expect(result.data).not.toHaveProperty("mercadopago_pix_expiration_time")
  })

  // TESTE 5 — SEGUNDA AUTORIZAÇÃO PIX
  it("pix: second authorization (mercadopago_order_id already present) calls Order.get, never Order.create", async () => {
    orderGetMock.mockResolvedValue({
      id: "ORD_TEST_1",
      status: "processed",
      status_detail: "accredited",
      transactions: {
        payments: [
          { id: "PAY_TEST_1", status: "processed", status_detail: "accredited" },
        ],
      },
    })
    const provider = buildProvider()

    await provider.authorizePayment({
      data: {
        payment_method_id: "pix",
        mercadopago_order_id: "ORD_TEST_1",
      },
    })

    expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_TEST_1" })
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  // TESTE 6 — PIX APROVADO/CAPTURADO
  it("pix: second authorization with an approved/processed Order returns captured", async () => {
    orderGetMock.mockResolvedValue({
      id: "ORD_TEST_1",
      status: "processed",
      status_detail: "accredited",
      transactions: {
        payments: [
          { id: "PAY_TEST_1", status: "processed", status_detail: "accredited" },
        ],
      },
    })
    const provider = buildProvider()

    const result = await provider.authorizePayment({
      data: {
        payment_method_id: "pix",
        mercadopago_order_id: "ORD_TEST_1",
      },
    })

    expect(result.status).toBe("captured")
  })

  // TESTE 7 — PIX SEM CAMPOS DE CARTÃO
  it("pix: a session explicitly identified as Pix, without card_token and without installments, does not throw", async () => {
    mockCreatedOrder()
    const provider = buildProvider()

    await expect(
      provider.authorizePayment({
        data: {
          payment_method_id: "pix",
          transaction_amount: 50,
          cart_id: "cart_pix_7",
          payer: { email: "buyer@example.com" },
        },
      })
    ).resolves.not.toThrow()
  })

  // TESTE 8 — RETRY
  it("pix: calling authorizePayment again with the same mercadopago_order_id never creates a second Order", async () => {
    orderGetMock.mockResolvedValue({
      id: "ORD_TEST_1",
      status: "action_required",
      status_detail: "waiting_transfer",
      transactions: {
        payments: [
          { id: "PAY_TEST_1", status: "action_required", status_detail: "waiting_transfer" },
        ],
      },
    })
    const provider = buildProvider()
    const sessionData = {
      payment_method_id: "pix",
      mercadopago_order_id: "ORD_TEST_1",
    }

    await provider.authorizePayment({ data: sessionData })
    await provider.authorizePayment({ data: sessionData })

    expect(orderGetMock).toHaveBeenCalledTimes(2)
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  // TESTE 9 — DISCRIMINADOR
  describe("Pix discriminator", () => {
    // TESTE 1 — Pix por paymentType (sozinho, sem card_token/installments)
    it("recognizes paymentType === 'bank_transfer' alone as Pix, without requiring card_token", async () => {
      mockCreatedOrder()
      const provider = buildProvider()

      await provider.authorizePayment({
        data: {
          paymentType: "bank_transfer",
          transaction_amount: 50,
          cart_id: "cart_disc_1",
          payer: { email: "buyer@example.com" },
        },
      })

      expect(orderCreateMock).toHaveBeenCalledTimes(1)
      const [call] = orderCreateMock.mock.calls
      expect(call[0].body.transactions.payments[0].payment_method).toEqual({
        id: "pix",
        type: "bank_transfer",
      })
    })

    // TESTE 2 — Pix por payment_method_id
    it("recognizes payment_method_id === 'pix' (flat shape)", async () => {
      mockCreatedOrder()
      const provider = buildProvider()

      await provider.authorizePayment({
        data: {
          payment_method_id: "pix",
          transaction_amount: 50,
          cart_id: "cart_disc_2",
          payer: { email: "buyer@example.com" },
        },
      })

      const [call] = orderCreateMock.mock.calls
      expect(call[0].body.transactions.payments[0].payment_method.id).toBe("pix")
    })

    // TESTE 3 — Pix por payment_method.id (forma aninhada)
    it("recognizes payment_method.id === 'pix' (nested shape)", async () => {
      mockCreatedOrder()
      const provider = buildProvider()

      await provider.authorizePayment({
        data: {
          payment_method: { id: "pix" },
          transaction_amount: 50,
          cart_id: "cart_disc_3",
          payer: { email: "buyer@example.com" },
        },
      })

      const [call] = orderCreateMock.mock.calls
      expect(call[0].body.transactions.payments[0].payment_method.id).toBe("pix")
    })

    // TESTE 4 — Conflito: paymentType (Pix) × payment_method_id (não-Pix)
    it("throws on paymentType='bank_transfer' + payment_method_id='credit_card' (illustrative non-Pix value), before any external call", async () => {
      const provider = buildProvider()

      await expect(
        provider.authorizePayment({
          data: {
            paymentType: "bank_transfer",
            payment_method_id: "credit_card",
            transaction_amount: 50,
            cart_id: "cart_conflict_1",
            payer: { email: "buyer@example.com" },
          },
        })
      ).rejects.toThrow("Inconsistent Mercado Pago payment method data")

      expect(orderCreateMock).not.toHaveBeenCalled()
      expect(orderGetMock).not.toHaveBeenCalled()
    })

    // Mesmo conflito, usando o valor REAL de payment_method_id já usado pelo
    // fluxo de cartão existente ("visa", ver o teste de cartão no topo deste
    // arquivo), não um valor hipotético.
    it("throws on paymentType='bank_transfer' + payment_method_id='visa' (real card value used by the existing card flow)", async () => {
      const provider = buildProvider()

      await expect(
        provider.authorizePayment({
          data: {
            paymentType: "bank_transfer",
            payment_method_id: "visa",
            card_token: "card_token_abc",
            transaction_amount: 50,
            cart_id: "cart_conflict_2",
            payer: { email: "buyer@example.com" },
          },
        })
      ).rejects.toThrow("Inconsistent Mercado Pago payment method data")

      expect(orderCreateMock).not.toHaveBeenCalled()
      expect(orderGetMock).not.toHaveBeenCalled()
    })

    // TESTE 5 — Conflito: payment_method_id='pix' × payment_method.id='credit_card'
    it("throws on payment_method_id='pix' + payment_method.id='credit_card', before any external call", async () => {
      const provider = buildProvider()

      await expect(
        provider.authorizePayment({
          data: {
            payment_method_id: "pix",
            payment_method: { id: "credit_card" },
            transaction_amount: 50,
            cart_id: "cart_conflict_3",
            payer: { email: "buyer@example.com" },
          },
        })
      ).rejects.toThrow("Inconsistent Mercado Pago payment method data")

      expect(orderCreateMock).not.toHaveBeenCalled()
      expect(orderGetMock).not.toHaveBeenCalled()
    })

    // TESTE 6 — Sinais Pix consistentes entre si (todos concordam): sem erro
    it("does not throw when all three Pix signals are present and agree (paymentType + payment_method_id + payment_method.id, all pix)", async () => {
      mockCreatedOrder()
      const provider = buildProvider()

      await provider.authorizePayment({
        data: {
          paymentType: "bank_transfer",
          payment_method_id: "pix",
          payment_method: { id: "pix" },
          transaction_amount: 50,
          cart_id: "cart_disc_6",
          payer: { email: "buyer@example.com" },
        },
      })

      expect(orderCreateMock).toHaveBeenCalledTimes(1)
      const [call] = orderCreateMock.mock.calls
      expect(call[0].body.transactions.payments[0].payment_method).toEqual({
        id: "pix",
        type: "bank_transfer",
      })
    })

    // TESTE 7 — Ausência de todos os discriminadores: preserva cartão/débito
    it("treats total absence of paymentType/payment_method_id/payment_method as NOT Pix and preserves the current card path", async () => {
      const provider = buildProvider()

      await expect(
        provider.authorizePayment({
          data: {
            transaction_amount: 50,
            cart_id: "cart_disc_7",
            payer: { email: "buyer@example.com" },
            // paymentType, payment_method_id, payment_method, card_token: all absent
          },
        })
      ).rejects.toThrow(/card payment data is missing/)

      expect(orderCreateMock).not.toHaveBeenCalled()
      expect(orderGetMock).not.toHaveBeenCalled()
    })

    // TESTE 8 — paymentType sozinho, sem payment_method_id/payment_method:
    // ausência desses dois campos NÃO é sinal não-Pix, então não há conflito.
    it("does not throw when paymentType='bank_transfer' is present alone, without payment_method_id or payment_method (their absence is not a non-Pix signal)", async () => {
      mockCreatedOrder()
      const provider = buildProvider()

      await expect(
        provider.authorizePayment({
          data: {
            paymentType: "bank_transfer",
            transaction_amount: 50,
            cart_id: "cart_disc_8",
            payer: { email: "buyer@example.com" },
          },
        })
      ).resolves.not.toThrow()

      expect(orderCreateMock).toHaveBeenCalledTimes(1)
    })
  })
})

describe("MercadoPagoPaymentProviderService — Pix charge lifecycle (Review)", () => {
  function buildProvider() {
    const ProviderClass = MercadoPagoPaymentProviderService as any
    return new ProviderClass({}, { access_token: "test-access-token" })
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  const PIX_SESSION_DATA = {
    payment_method_id: "pix",
    cart_id: "cart_pix_review",
    payer: { email: "buyer@example.com" },
    mercadopago_idempotency_key: "payses_base_key",
  }

  function pixOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: "ORD_PIX_A",
      status: "action_required",
      status_detail: "waiting_transfer",
      total_amount: "50.00",
      transactions: {
        payments: [
          {
            id: "PAY_PIX_A",
            status: "action_required",
            status_detail: "waiting_transfer",
            date_of_expiration: "2026-09-26T12:00:00.000-03:00",
            payment_method: {
              qr_code: "000201-pix-copia-e-cola",
              qr_code_base64: "iVBORw0KGgo=",
              ticket_url: "https://www.mercadopago.com.br/payments/ticket",
            },
          },
        ],
      },
      ...overrides,
    }
  }

  function withStatus(status: string, overrides: Record<string, unknown> = {}) {
    const base = pixOrder(overrides)
    return {
      ...base,
      status,
      status_detail: status,
      transactions: {
        payments: [{ ...base.transactions.payments[0], status, status_detail: status }],
      },
    }
  }

  async function prepare(provider: any, data: Record<string, unknown>, action = "prepare", amount = 50) {
    return provider.updatePayment({
      amount,
      currency_code: "brl",
      data: { ...data, mercadopago_pix_action: action },
    })
  }

  it("prepare: creates the Pix Order when the session has none and keeps the session 'pending'", async () => {
    orderCreateMock.mockResolvedValue(pixOrder())
    const provider = buildProvider()

    const result = await prepare(provider, PIX_SESSION_DATA)

    expect(orderCreateMock).toHaveBeenCalledTimes(1)
    expect(orderGetMock).not.toHaveBeenCalled()
    expect(result.status).toBe("pending")
    expect(result.data.mercadopago_order_id).toBe("ORD_PIX_A")
    expect(result.data.mercadopago_order_payment_method).toBe("pix")
    expect(result.data.mercadopago_pix_qr_code).toBe("000201-pix-copia-e-cola")
    expect(result.data.mercadopago_pix_generation).toBe(0)
    // The transient instruction is never persisted.
    expect(result.data).not.toHaveProperty("mercadopago_pix_action")
  })

  describe("payment window (expiration_time)", () => {
    const NOW = Date.parse("2026-09-27T12:00:00.000Z")

    beforeEach(() => {
      jest.spyOn(Date, "now").mockReturnValue(NOW)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it("sends expiration_time PT1H on the Pix payment and stores the conservative deadline", async () => {
      const order = pixOrder()
      delete (order.transactions.payments[0] as Record<string, unknown>).date_of_expiration
      orderCreateMock.mockResolvedValue(order)
      const provider = buildProvider()

      const result = await prepare(provider, PIX_SESSION_DATA)

      const body = orderCreateMock.mock.calls[0][0].body
      expect(PIX_EXPIRATION_TIME).toBe("PT1H")
      expect(body.transactions.payments[0].expiration_time).toBe("PT1H")
      expect(body).not.toHaveProperty("expiration_time")
      expect(result.data.mercadopago_pix_expires_at).toBe("2026-09-27T13:00:00.000Z")
    })

    it("keeps an earlier absolute date returned by Mercado Pago as the deadline", async () => {
      orderCreateMock.mockResolvedValue(
        pixOrder({
          transactions: {
            payments: [
              {
                id: "PAY_PIX_A",
                status: "action_required",
                status_detail: "waiting_transfer",
                date_of_expiration: "2026-09-27T12:45:00.000Z",
                payment_method: { qr_code: "000201", ticket_url: "https://ticket" },
              },
            ],
          },
        })
      )
      const provider = buildProvider()

      const result = await prepare(provider, PIX_SESSION_DATA)

      expect(result.data.mercadopago_pix_expires_at).toBe("2026-09-27T12:45:00.000Z")
    })

    it("keeps the same request body, and so the same idempotency key, on a retried create", async () => {
      orderCreateMock.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()

      await expect(prepare(provider, PIX_SESSION_DATA)).rejects.toThrow("network")
      await prepare(provider, PIX_SESSION_DATA)

      const [first, second] = orderCreateMock.mock.calls
      expect(second[0].body).toEqual(first[0].body)
      expect(second[0].requestOptions.idempotencyKey).toBe(first[0].requestOptions.idempotencyKey)
    })

    it("reusing the attached charge keeps its stored deadline", async () => {
      orderGetMock.mockResolvedValue(pixOrder())
      const provider = buildProvider()

      const result = await prepare(provider, {
        ...PIX_SESSION_DATA,
        amount: 50,
        mercadopago_order_id: "ORD_PIX_A",
        mercadopago_order_payment_method: "pix",
        mercadopago_pix_qr_code: "000201-pix-copia-e-cola",
        mercadopago_pix_expires_at: "2026-09-27T12:30:00.000Z",
      })

      expect(orderCreateMock).not.toHaveBeenCalled()
      expect(result.data.mercadopago_pix_expires_at).toBe("2026-09-27T12:30:00.000Z")
    })
  })

  it("prepare: preserves the base idempotency key and uses a derived, distinct key for the Pix Order", async () => {
    orderCreateMock.mockResolvedValue(pixOrder())
    const provider = buildProvider()

    const result = await prepare(provider, PIX_SESSION_DATA)
    const [{ requestOptions }] = orderCreateMock.mock.calls[0]

    expect(result.data.mercadopago_idempotency_key).toBe("payses_base_key")
    expect(requestOptions.idempotencyKey).toBe(result.data.mercadopago_pix_idempotency_key)
    expect(requestOptions.idempotencyKey).not.toBe("payses_base_key")
    expect(requestOptions.idempotencyKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it("prepare: the same session, amount and generation always produce the same Pix key", async () => {
    orderCreateMock.mockResolvedValue(pixOrder())
    const provider = buildProvider()

    await prepare(provider, PIX_SESSION_DATA)
    await prepare(provider, PIX_SESSION_DATA)

    expect(orderCreateMock.mock.calls[0][0].requestOptions.idempotencyKey).toBe(
      orderCreateMock.mock.calls[1][0].requestOptions.idempotencyKey
    )
  })

  it("prepare: reuses the attached Pix Order while it is still payable for the same amount", async () => {
    orderCreateMock.mockResolvedValue(pixOrder())
    orderGetMock.mockResolvedValue(pixOrder())
    const provider = buildProvider()

    const first = await prepare(provider, PIX_SESSION_DATA)
    const second = await prepare(provider, first.data)

    expect(orderCreateMock).toHaveBeenCalledTimes(1)
    expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_PIX_A" })
    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(second.status).toBe("pending")
    expect(second.data.mercadopago_order_id).toBe("ORD_PIX_A")
  })

  it("prepare: when the amount changed, cancels the old charge and creates a new one with a new key", async () => {
    orderCreateMock.mockResolvedValueOnce(pixOrder())
    const provider = buildProvider()
    const first = await prepare(provider, PIX_SESSION_DATA)

    orderGetMock.mockResolvedValue(pixOrder())
    orderCancelMock.mockResolvedValue({ id: "ORD_PIX_A", status: "canceled" })
    orderCreateMock.mockResolvedValueOnce(pixOrder({ id: "ORD_PIX_B", total_amount: "60.00" }))

    const second = await prepare(provider, first.data, "prepare", 60)

    expect(orderCancelMock).toHaveBeenCalledWith(expect.objectContaining({ id: "ORD_PIX_A" }))
    expect(orderCreateMock).toHaveBeenCalledTimes(2)
    expect(second.data.mercadopago_order_id).toBe("ORD_PIX_B")
    expect(second.data.mercadopago_pix_generation).toBe(1)
    expect(second.data.mercadopago_pix_idempotency_key).not.toBe(
      first.data.mercadopago_pix_idempotency_key
    )
    expect(orderCreateMock.mock.calls[1][0].body.total_amount).toBe("60.00")
  })

  it("regenerate: cancels a still-pending charge and creates a new one", async () => {
    orderCreateMock.mockResolvedValueOnce(pixOrder())
    const provider = buildProvider()
    const first = await prepare(provider, PIX_SESSION_DATA)

    orderGetMock.mockResolvedValue(pixOrder())
    orderCancelMock.mockResolvedValue({})
    orderCreateMock.mockResolvedValueOnce(pixOrder({ id: "ORD_PIX_B" }))

    const second = await prepare(provider, first.data, "regenerate")

    expect(orderCancelMock).toHaveBeenCalledTimes(1)
    expect(second.data.mercadopago_order_id).toBe("ORD_PIX_B")
    expect(second.status).toBe("pending")
  })

  it("prepare: an expired charge is not reused, not cancelled again, and is replaced", async () => {
    orderCreateMock.mockResolvedValueOnce(pixOrder())
    const provider = buildProvider()
    const first = await prepare(provider, PIX_SESSION_DATA)

    orderGetMock.mockResolvedValue(withStatus("expired"))
    orderCreateMock.mockResolvedValueOnce(pixOrder({ id: "ORD_PIX_B" }))

    const second = await prepare(provider, first.data)

    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(second.data.mercadopago_order_id).toBe("ORD_PIX_B")
    expect(second.data.mercadopago_pix_qr_code).toBe("000201-pix-copia-e-cola")
  })

  it("prepare/regenerate: a paid charge is never replaced", async () => {
    orderCreateMock.mockResolvedValueOnce(pixOrder())
    const provider = buildProvider()
    const first = await prepare(provider, PIX_SESSION_DATA)

    orderGetMock.mockResolvedValue(withStatus("processed"))

    const second = await prepare(provider, first.data, "regenerate")

    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
    expect(second.status).toBeUndefined()
    expect(second.data.mercadopago_order_id).toBe("ORD_PIX_A")
  })

  it("prepare: rejects a non-Pix session and an unknown action, before any external call", async () => {
    const provider = buildProvider()

    await expect(
      prepare(provider, { ...PIX_SESSION_DATA, payment_method_id: "visa", card_token: "tok" })
    ).rejects.toThrow("not a Pix payment")
    await expect(prepare(provider, PIX_SESSION_DATA, "pay-now")).rejects.toThrow(
      "unsupported Pix action"
    )
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("updatePayment without an action keeps the previous behavior for card data (no Mercado Pago call)", async () => {
    const provider = buildProvider()

    const result = await provider.updatePayment({
      amount: 100,
      currency_code: "brl",
      data: { payment_method_id: "visa", card_token: "tok", cart_id: "cart_1" },
    })

    expect(result).toEqual({
      data: {
        payment_method_id: "visa",
        card_token: "tok",
        cart_id: "cart_1",
        amount: "100.00",
        currency_code: "BRL",
        mercadopago_idempotency_key: expect.any(String),
      },
    })
    expect(orderGetMock).not.toHaveBeenCalled()
    expect(orderCancelMock).not.toHaveBeenCalled()
  })

  it("switching the session from Pix to card cancels the open Pix charge and detaches it", async () => {
    orderCreateMock.mockResolvedValueOnce(pixOrder())
    const provider = buildProvider()
    const prepared = await prepare(provider, PIX_SESSION_DATA)

    orderGetMock.mockResolvedValue(pixOrder())
    orderCancelMock.mockResolvedValue({})

    const result = await provider.updatePayment({
      amount: 50,
      currency_code: "brl",
      data: { ...prepared.data, payment_method_id: "visa", card_token: "tok" },
    })

    expect(orderCancelMock).toHaveBeenCalledWith(expect.objectContaining({ id: "ORD_PIX_A" }))
    expect(result.data).not.toHaveProperty("mercadopago_order_id")
    expect(result.data).not.toHaveProperty("mercadopago_pix_qr_code")
    expect(result.data.payment_method_id).toBe("visa")
    // The base key the card Order will use is untouched.
    expect(result.data.mercadopago_idempotency_key).toBe("payses_base_key")
  })

  it("resubmitting the Pix data keeps the attached charge (no cancel, no create)", async () => {
    orderCreateMock.mockResolvedValueOnce(pixOrder())
    const provider = buildProvider()
    const prepared = await prepare(provider, PIX_SESSION_DATA)

    const result = await provider.updatePayment({
      amount: 50,
      currency_code: "brl",
      data: { ...prepared.data, payer: { email: "buyer@example.com" } },
    })

    expect(result.data.mercadopago_order_id).toBe("ORD_PIX_A")
    expect(orderCancelMock).not.toHaveBeenCalled()
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
  })

  describe("deletePayment", () => {
    it("cancels a pending Pix charge when the session is deleted", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(pixOrder())
      orderCancelMock.mockResolvedValue({})

      const result = await provider.deletePayment({ data: prepared.data })

      expect(orderCancelMock).toHaveBeenCalledWith(expect.objectContaining({ id: "ORD_PIX_A" }))
      expect(result.data).not.toHaveProperty("mercadopago_order_id")
    })

    it("does nothing for an already expired Pix charge", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(withStatus("expired"))

      await provider.deletePayment({ data: prepared.data })

      expect(orderCancelMock).not.toHaveBeenCalled()
    })

    it("refuses to discard a paid Pix charge", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(withStatus("processed"))

      await expect(provider.deletePayment({ data: prepared.data })).rejects.toThrow(
        "already been paid"
      )
      expect(orderCancelMock).not.toHaveBeenCalled()
    })

    it("does not touch card Orders (no Pix marker)", async () => {
      const provider = buildProvider()

      const data = { payment_method_id: "visa", mercadopago_order_id: "ORD_CARD" }
      const result = await provider.deletePayment({ data })

      expect(result.data).toEqual(data)
      expect(orderGetMock).not.toHaveBeenCalled()
      expect(orderCancelMock).not.toHaveBeenCalled()
    })
  })

  describe("authorizePayment after the Review preparation", () => {
    it("reuses the prepared Pix Order (never creates a second one) and returns pending_authorization", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(pixOrder())

      const result = await provider.authorizePayment({ data: prepared.data })

      expect(orderCreateMock).toHaveBeenCalledTimes(1)
      expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_PIX_A" })
      expect(result.status).toBe("pending_authorization")
    })

    it("returns captured when the prepared Pix was already paid", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(withStatus("processed"))

      const result = await provider.authorizePayment({ data: prepared.data })

      expect(result.status).toBe("captured")
      expect(orderCreateMock).toHaveBeenCalledTimes(1)
    })

    it("refuses a Pix Order whose amount differs from the session amount", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(pixOrder({ total_amount: "10.00" }))

      await expect(provider.authorizePayment({ data: prepared.data })).rejects.toThrow(
        "does not match"
      )
    })

    it.each([
      ["expired", "canceled"],
      ["canceled", "canceled"],
      ["failed", "error"],
      ["rejected", "error"],
    ])("maps a %s Pix Order to Medusa session status %s", async (mpStatus, medusaStatus) => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(withStatus(mpStatus))

      const result = await provider.authorizePayment({ data: prepared.data })

      expect(result.status).toBe(medusaStatus)
    })

    it("throws on an unrecognized Pix Order status instead of treating it as pending", async () => {
      orderCreateMock.mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const prepared = await prepare(provider, PIX_SESSION_DATA)
      orderGetMock.mockResolvedValue(withStatus("something_new"))

      await expect(provider.authorizePayment({ data: prepared.data })).rejects.toThrow(
        "unrecognized Pix order status"
      )
    })
  })

  describe("payer name and idempotency (ADR-010)", () => {
    const NAMED_PAYER = { email: "buyer@example.com", first_name: "João", last_name: "Silva" }

    const pixKey = (generation: number) =>
      createHash("sha256").update(`payses_base_key:pix:50.00:${generation}`).digest("hex")

    // session.data as the update route persists it (update without a Pix
    // action), i.e. what every later prepare, retry or authorizePix reads.
    async function persisted(provider: any, payer: Record<string, unknown>) {
      const updated = await provider.updatePayment({
        amount: 50,
        currency_code: "brl",
        data: { ...PIX_SESSION_DATA, payer },
      })
      return updated.data
    }

    it("S1: sends the first/last name persisted in session.data.payer", async () => {
      orderCreateMock.mockResolvedValue(pixOrder())
      const provider = buildProvider()

      await prepare(provider, await persisted(provider, NAMED_PAYER))

      const [[createInput]] = orderCreateMock.mock.calls
      expect(createInput.body.payer).toEqual(NAMED_PAYER)
    })

    it("S2: does not invent a first/last name when the payer has none", async () => {
      orderCreateMock.mockResolvedValue(pixOrder())
      const provider = buildProvider()

      await prepare(provider, await persisted(provider, { email: "buyer@example.com" }))

      const [[createInput]] = orderCreateMock.mock.calls
      expect(createInput.body.payer).toEqual({ email: "buyer@example.com" })
      expect(createInput.body.payer).not.toHaveProperty("first_name")
      expect(createInput.body.payer).not.toHaveProperty("last_name")
    })

    it("S3: a retry after a failed create sends the same key and a deeply equal body, same generation", async () => {
      orderCreateMock.mockRejectedValueOnce(new Error("network timeout")).mockResolvedValueOnce(pixOrder())
      const provider = buildProvider()
      const data = await persisted(provider, NAMED_PAYER)

      // The failed prepare persists nothing (the Payment Module only writes the
      // session after the provider returns), so the retry reads the same data.
      await expect(prepare(provider, data)).rejects.toThrow("network timeout")
      const result = await prepare(provider, data)

      expect(orderCreateMock).toHaveBeenCalledTimes(2)
      const [[first], [second]] = orderCreateMock.mock.calls
      expect(second).toEqual(first)
      expect(first.requestOptions.idempotencyKey).toBe(pixKey(0))
      expect(second.body.payer).toEqual(NAMED_PAYER)
      expect(result.data.mercadopago_pix_generation).toBe(0)
      expect(result.data.mercadopago_pix_idempotency_key).toBe(pixKey(0))
    })

    it("S4: the authorizePix fallback sends the same key and body as the prepare for the same persisted data", async () => {
      orderCreateMock.mockResolvedValue(pixOrder())
      const provider = buildProvider()
      const data = await persisted(provider, NAMED_PAYER)

      await prepare(provider, data)
      await provider.authorizePayment({ data })

      expect(orderCreateMock).toHaveBeenCalledTimes(2)
      const [[fromPrepare], [fromFallback]] = orderCreateMock.mock.calls
      expect(fromFallback).toEqual(fromPrepare)
      expect(fromFallback.requestOptions.idempotencyKey).toBe(pixKey(0))
    })

    it("S5: regenerate moves to the next generation and key and keeps the payer", async () => {
      orderCreateMock
        .mockResolvedValueOnce(pixOrder())
        .mockResolvedValueOnce(pixOrder({ id: "ORD_PIX_B" }))
      orderGetMock.mockResolvedValue(pixOrder())
      orderCancelMock.mockResolvedValue({})
      const provider = buildProvider()

      const first = await prepare(provider, await persisted(provider, NAMED_PAYER))
      const regenerated = await prepare(provider, first.data, "regenerate")

      expect(orderCreateMock).toHaveBeenCalledTimes(2)
      const [[firstCreate], [secondCreate]] = orderCreateMock.mock.calls
      expect(firstCreate.requestOptions.idempotencyKey).toBe(pixKey(0))
      expect(secondCreate.requestOptions.idempotencyKey).toBe(pixKey(1))
      expect(secondCreate.body.payer).toEqual(NAMED_PAYER)
      expect(regenerated.data.mercadopago_pix_generation).toBe(1)
      expect(regenerated.data.payer).toEqual(NAMED_PAYER)
      // Cancellation of the replaced charge keeps its own key, derived from the
      // replaced charge's key.
      expect(orderCancelMock).toHaveBeenCalledWith({
        id: "ORD_PIX_A",
        requestOptions: { idempotencyKey: createHash("sha256").update(`${pixKey(0)}:cancel`).digest("hex") },
      })
    })
  })

  describe("unexpected Mercado Pago responses", () => {
    it("throws when the created Order has no id", async () => {
      orderCreateMock.mockResolvedValue(pixOrder({ id: undefined }))
      const provider = buildProvider()

      await expect(prepare(provider, PIX_SESSION_DATA)).rejects.toThrow("order ID was not returned")
    })

    it("throws when the created Order has no payment", async () => {
      orderCreateMock.mockResolvedValue(pixOrder({ transactions: { payments: [] } }))
      const provider = buildProvider()

      await expect(prepare(provider, PIX_SESSION_DATA)).rejects.toThrow("payment was not returned")
    })
  })
})

describe("normalizePixStatus", () => {
  it.each([
    ["action_required", "pending"],
    ["processed", "approved"],
    ["created", "processing"],
    ["processing", "processing"],
    ["expired", "expired"],
    ["canceled", "canceled"],
    ["failed", "failed"],
    ["rejected", "rejected"],
    ["refunded", "refunded"],
    ["charged_back", "charged_back"],
    ["whatever", "unknown"],
  ])("maps order status %s to %s", (orderStatus, expected) => {
    expect(normalizePixStatus({ orderStatus })).toBe(expected)
  })
})

describe("computePixDeadline", () => {
  const START = Date.parse("2026-09-27T12:00:00.000Z")

  it("is the request start plus one hour when Mercado Pago returns no dates", () => {
    expect(computePixDeadline({ requestStartedAt: START })).toBe("2026-09-27T13:00:00.000Z")
  })

  it("uses the Order creation time when it is earlier (idempotent replay)", () => {
    expect(
      computePixDeadline({ requestStartedAt: START, orderCreatedDate: "2026-09-27T11:40:00.000Z" })
    ).toBe("2026-09-27T12:40:00.000Z")
  })

  it("uses a returned absolute date only when it is earlier", () => {
    expect(
      computePixDeadline({ requestStartedAt: START, dateOfExpiration: "2026-09-27T12:50:00.000Z" })
    ).toBe("2026-09-27T12:50:00.000Z")
    expect(
      computePixDeadline({ requestStartedAt: START, dateOfExpiration: "2026-09-28T12:00:00.000Z" })
    ).toBe("2026-09-27T13:00:00.000Z")
  })

  it("ignores durations and invalid values", () => {
    expect(
      computePixDeadline({
        requestStartedAt: START,
        expirationTime: "PT1H",
        dateOfExpiration: "not-a-date",
        orderCreatedDate: "",
      })
    ).toBe("2026-09-27T13:00:00.000Z")
  })
})

describe("toPixPaymentDto", () => {
  const data = {
    payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    card_token: "tok_secret",
    mercadopago_idempotency_key: "key",
    mercadopago_pix_idempotency_key: "pix-key",
    mercadopago_order_id: "ORD_PIX_A",
    mercadopago_order_status: "action_required",
    mercadopago_order_status_detail: "waiting_transfer",
    mercadopago_payment_status: "action_required",
    mercadopago_status_detail: "waiting_transfer",
    mercadopago_pix_qr_code: "000201",
    mercadopago_pix_qr_code_base64: "iVBOR",
    mercadopago_pix_ticket_url: "https://ticket",
    mercadopago_pix_date_of_expiration: "2026-09-26T12:00:00.000-03:00",
  }

  it("returns only the display status and payable data — no payer, card, key, Mercado Pago id or native status", () => {
    const dto = toPixPaymentDto({ status: "pending", data })

    expect(Object.keys(dto).sort()).toEqual(
      ["charge_ref", "expires_at", "qr_code", "qr_code_base64", "status", "ticket_url"].sort()
    )
    expect(dto).toEqual(
      expect.objectContaining({
        status: "pending",
        qr_code: "000201",
        qr_code_base64: "iVBOR",
        ticket_url: "https://ticket",
        expires_at: "2026-09-26T12:00:00.000-03:00",
      })
    )
    expect(JSON.stringify(dto)).not.toMatch(
      /buyer@example|12345678909|tok_secret|pix-key|ORD_PIX_A|action_required|waiting_transfer/
    )
  })

  it("derives an opaque charge_ref that changes when the charge changes", () => {
    const first = toPixPaymentDto({ status: "pending", data })
    const again = toPixPaymentDto({ status: "pending", data })
    const replaced = toPixPaymentDto({ status: "pending", data: { ...data, mercadopago_order_id: "ORD_PIX_B" } })

    expect(first.charge_ref).toMatch(/^[0-9a-f]{16}$/)
    expect(again.charge_ref).toBe(first.charge_ref)
    expect(replaced.charge_ref).not.toBe(first.charge_ref)
    expect(toPixPaymentDto({ status: "pending", data: { payment_method_id: "pix" } }).charge_ref).toBeUndefined()
  })

  describe("payment window (application policy, not a Mercado Pago status)", () => {
    const withDeadline = { ...data, mercadopago_pix_expires_at: "2026-09-27T13:00:00.000Z" }

    it("before the deadline: payable data, no window flag", () => {
      const dto = toPixPaymentDto({ status: "pending", data: withDeadline }, new Date("2026-09-27T12:59:59.000Z"))

      expect(dto.qr_code).toBe("000201")
      expect(dto.ticket_url).toBe("https://ticket")
      expect(dto).not.toHaveProperty("payment_window_closed")
    })

    it("from the deadline on: no QR/copy-paste/ticket, status stays the real one (pending), window flagged", () => {
      const dto = toPixPaymentDto({ status: "pending", data: withDeadline }, new Date("2026-09-27T13:00:00.000Z"))

      expect(dto.status).toBe("pending")
      expect(dto.payment_window_closed).toBe(true)
      expect(dto.qr_code).toBeUndefined()
      expect(dto.qr_code_base64).toBeUndefined()
      expect(dto.ticket_url).toBeUndefined()
      expect(dto.expires_at).toBe("2026-09-27T13:00:00.000Z")
      expect(dto.charge_ref).toEqual(expect.any(String))
    })

    it("never turns the provider status into expired or canceled", () => {
      const after = new Date("2026-09-27T14:00:00.000Z")

      expect(toPixPaymentDto({ status: "pending", data: withDeadline }, after).status).toBe("pending")
      expect(
        toPixPaymentDto(
          { status: "pending", data: { ...withDeadline, mercadopago_order_status: "canceled" } },
          after
        ).status
      ).toBe("canceled")
      expect(toPixPaymentDto({ status: "authorized", data: withDeadline }, after).status).toBe("approved")
    })

    it("charges without a stored deadline keep their payable data", () => {
      const dto = toPixPaymentDto({ status: "pending", data }, new Date("2030-01-01T00:00:00.000Z"))

      expect(dto.qr_code).toBe("000201")
      expect(dto).not.toHaveProperty("payment_window_closed")
    })
  })

  it("prefers the stored conservative deadline as expires_at", () => {
    const dto = toPixPaymentDto({
      status: "pending",
      data: { ...data, mercadopago_pix_expires_at: "2026-09-26T11:00:00.000Z" },
    })

    expect(dto.expires_at).toBe("2026-09-26T11:00:00.000Z")
  })

  it("reports approved once Medusa has authorized the session, even with a stale stored MP status", () => {
    expect(toPixPaymentDto({ status: "authorized", data }).status).toBe("approved")
  })
})

// ADR-014: the card Order idempotency key is derived from the session's base
// key and the canonical body sent, so a retry of the same attempt reuses it
// and any new attempt (the E2E of INV-008: 402, then a new card → 409) gets a
// new one.
describe("MercadoPagoPaymentProviderService — card Order idempotency key (ADR-014)", () => {
  let attempts: FakeCardAttempts

  function buildProvider() {
    const ProviderClass = MercadoPagoPaymentProviderService as any
    return new ProviderClass({ mercadopagoCardAttempt: attempts }, { access_token: "test-access-token" })
  }

  const CARD_SESSION_DATA = {
    payment_method_id: "visa",
    payment_type_id: "credit_card",
    card_token: "card_token_attempt_1",
    installments: 1,
    amount: "110.00",
    cart_id: "cart_card_key",
    payer: { email: "buyer@example.com", identification: { type: "CPF", number: "12345678909" } },
    mercadopago_idempotency_key: "payses_card_base",
  }

  function mockApproved() {
    orderCreateMock.mockResolvedValue({
      id: "ORD_CARD_1",
      status: "processed",
      status_detail: "accredited",
      external_reference: "unused",
      transactions: { payments: [{ id: "PAY_CARD_1", status: "processed", status_detail: "accredited" }] },
    })
  }

  function mercadoPagoApiError(status: number, code: string) {
    return Object.assign(new Error("MercadoPago API error"), { status, errors: [{ code }] })
  }

  const lastCreate = () => {
    const calls = orderCreateMock.mock.calls
    return calls[calls.length - 1][0]
  }

  async function sentKey(provider: any, data: Record<string, unknown>) {
    await provider.authorizePayment(cardInput(attempts, data))
    return lastCreate().requestOptions.idempotencyKey as string
  }

  beforeEach(() => {
    jest.clearAllMocks()
    attempts = createFakeCardAttempts()
    mockApproved()
  })

  it("a replay of the same attempt after an ambiguous result sends the same key and a deeply equal body", async () => {
    orderCreateMock.mockReset()
    orderCreateMock.mockRejectedValueOnce(mercadoPagoApiError(504, "gateway_timeout"))
    mockApproved()
    const provider = buildProvider()
    const input = cardInput(attempts, CARD_SESSION_DATA)

    await expect(provider.authorizePayment(input)).rejects.toThrow()
    await provider.authorizePayment({ ...input, data: { ...input.data } })

    const [first, second] = orderCreateMock.mock.calls.map((call) => call[0])
    expect(second.requestOptions.idempotencyKey).toBe(first.requestOptions.idempotencyKey)
    expect(second.body).toEqual(first.body)
  })

  it("the key is sha256(<base>:card:<sha256(canonical body)>), within the 128-character limit", async () => {
    const provider = buildProvider()

    const key = await sentKey(provider, CARD_SESSION_DATA)
    const { body } = orderCreateMock.mock.calls[0][0]
    const canonical = (value: any): string =>
      Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : value && typeof value === "object"
          ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
          : JSON.stringify(value)
    const bodyHash = createHash("sha256").update(canonical(body)).digest("hex")

    expect(key).toBe(createHash("sha256").update(`payses_card_base:card:${bodyHash}`).digest("hex"))
    expect(key.length).toBeLessThanOrEqual(128)
  })

  it("keeps the base key in session data and never sends it as the Order key", async () => {
    const provider = buildProvider()

    const result = await provider.authorizePayment(cardInput(attempts, CARD_SESSION_DATA))
    const key = orderCreateMock.mock.calls[0][0].requestOptions.idempotencyKey

    expect(result.data.mercadopago_idempotency_key).toBe("payses_card_base")
    expect(key).not.toBe("payses_card_base")
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    // The derived key is not persisted as session state.
    expect(Object.values(result.data)).not.toContain(key)
  })

  it("a new card token (new attempt in the same session) sends a different key", async () => {
    const provider = buildProvider()

    const first = await sentKey(provider, CARD_SESSION_DATA)
    const second = await sentKey(provider, {
      ...CARD_SESSION_DATA,
      card_token: "card_token_attempt_2",
      payment_method_id: "master",
    })

    expect(second).not.toBe(first)
  })

  it.each([
    ["installments", { installments: 3 }],
    ["payer", { payer: { email: "other@example.com", identification: { type: "CPF", number: "12345678909" } } }],
    ["card type", { payment_type_id: "debit_card", payment_method_id: "debelo" }],
    ["amount", { amount: "120.00" }],
  ])("a new attempt with a different %s sends a different key", async (_label, change) => {
    const provider = buildProvider()

    const first = await sentKey(provider, CARD_SESSION_DATA)
    const second = await sentKey(provider, { ...CARD_SESSION_DATA, ...change })

    expect(second).not.toBe(first)
  })

  it("the key does not depend on the key order of the persisted data (jsonb): a replay with reordered data matches", async () => {
    orderCreateMock.mockReset()
    orderCreateMock.mockRejectedValueOnce(mercadoPagoApiError(500, "internal_error"))
    mockApproved()
    const provider = buildProvider()
    const input = cardInput(attempts, CARD_SESSION_DATA)

    await expect(provider.authorizePayment(input)).rejects.toThrow()
    await provider.authorizePayment({
      ...input,
      data: {
        ...input.data,
        payer: { identification: { number: "12345678909", type: "CPF" }, email: "buyer@example.com" },
      },
    })

    const [first, second] = orderCreateMock.mock.calls.map((call) => call[0])
    expect(second.requestOptions.idempotencyKey).toBe(first.requestOptions.idempotencyKey)
  })

  it("another session (another base key) with the same card data sends a different key", async () => {
    const provider = buildProvider()

    const first = await sentKey(provider, CARD_SESSION_DATA)
    const second = await sentKey(provider, { ...CARD_SESSION_DATA, mercadopago_idempotency_key: "payses_card_other" })

    expect(second).not.toBe(first)
  })

  it.each([
    [402, "failed", "failed"],
    [409, "idempotency_key_already_used", "unknown"],
  ])("an HTTP %s from the Orders API is propagated, returns nothing to persist and leaves the attempt %s", async (status, code, state) => {
    const error = mercadoPagoApiError(status, code)
    orderCreateMock.mockReset()
    orderCreateMock.mockRejectedValue(error)
    const provider = buildProvider()
    const input = cardInput(attempts, CARD_SESSION_DATA)
    const snapshot = JSON.parse(JSON.stringify(input))

    await expect(provider.authorizePayment(input)).rejects.toBe(error)

    expect(orderCreateMock).toHaveBeenCalledTimes(1)
    // The Payment Module only writes what the provider returns: after a throw
    // the session keeps its data, and the input was not mutated either.
    expect(input).toEqual(snapshot)
    expect(attempts.rows.get(input.data.card_attempt_id)?.state).toBe(state)
  })

  it("Pix keeps its previous key: sha256(<base>:pix:<amount>:<generation>), unaffected by the card derivation", async () => {
    orderCreateMock.mockReset()
    orderCreateMock.mockResolvedValue({
      id: "ORD_PIX_KEY",
      status: "action_required",
      status_detail: "waiting_transfer",
      total_amount: "50.00",
      transactions: {
        payments: [
          {
            id: "PAY_PIX_KEY",
            status: "action_required",
            status_detail: "waiting_transfer",
            payment_method: { qr_code: "000201", qr_code_base64: "iVBO", ticket_url: "https://example.com/t" },
          },
        ],
      },
    })
    const provider = buildProvider()

    await provider.updatePayment({
      amount: 50,
      currency_code: "brl",
      data: {
        payment_method_id: "pix",
        cart_id: "cart_pix_key",
        payer: { email: "buyer@example.com" },
        mercadopago_idempotency_key: "payses_card_base",
        mercadopago_pix_action: "prepare",
      },
    })

    expect(orderCreateMock.mock.calls[0][0].requestOptions.idempotencyKey).toBe(
      createHash("sha256").update("payses_card_base:pix:50.00:0").digest("hex")
    )
  })
})

// INV-009 / ADR-015 (option B): the card token comes only from the card
// attempt; the provider owns rules 3, 4 and 5 (begin, replay, resume) and
// records every Orders API outcome on the attempt.
describe("MercadoPagoPaymentProviderService — card attempt (INV-009)", () => {
  let attempts: FakeCardAttempts

  function buildProvider() {
    const ProviderClass = MercadoPagoPaymentProviderService as any
    return new ProviderClass({ mercadopagoCardAttempt: attempts }, { access_token: "test-access-token" })
  }

  const TOKEN = "FAKE_card_token_inv009"
  const DATA = {
    payment_method_id: "visa",
    payment_type_id: "credit_card",
    card_token: TOKEN,
    installments: 1,
    amount: "110.00",
    cart_id: "cart_inv009",
    payer: { email: "buyer@example.com" },
    mercadopago_idempotency_key: "payses_inv009",
  }

  const approvedOrder = (overrides: Record<string, unknown> = {}) => ({
    id: "ORD_INV009",
    status: "processed",
    status_detail: "accredited",
    transactions: { payments: [{ id: "PAY_INV009", status: "processed", status_detail: "accredited" }] },
    ...overrides,
  })

  const apiError = (status: number, name = "Error") => Object.assign(new Error("MercadoPago API error"), { status, name })
  const row = (input: { data: { card_attempt_id: string } }) => attempts.rows.get(input.data.card_attempt_id)!

  beforeEach(() => {
    jest.clearAllMocks()
    orderCreateMock.mockReset()
    orderGetMock.mockReset()
    attempts = createFakeCardAttempts()
  })

  it("submitted: decrypts via the attempt, begins (rule 3) with the body hash, POSTs, resolves; no token in the result", async () => {
    orderCreateMock.mockResolvedValue(approvedOrder())
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    const result = await provider.authorizePayment(input)

    const { body } = orderCreateMock.mock.calls[0][0]
    expect(body.transactions.payments[0].payment_method.token).toBe(TOKEN)
    expect(body.external_reference).toBe(row(input).external_reference)
    expect(body.description).toBe("Medusa cart cart_inv009")
    expect(attempts.readCardToken).toHaveBeenCalledWith(input.data.card_attempt_id, "payses_inv009")
    expect(attempts.beginAuthorization.mock.invocationCallOrder[0]).toBeLessThan(orderCreateMock.mock.invocationCallOrder[0])
    expect(attempts.beginAuthorization.mock.calls[0][1]).toMatch(/^[0-9a-f]{64}$/)
    expect(row(input).state).toBe("resolved")
    expect(row(input).mercadopago_order_id).toBe("ORD_INV009")
    expect(result.status).toBe("captured")
    expect(result.data.card_attempt_id).toBe(input.data.card_attempt_id)
    expect(result.data.mercadopago_external_reference).toBe(row(input).external_reference)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it("never uses nor carries forward a legacy card_token left in PaymentSession.data", async () => {
    orderCreateMock.mockResolvedValue(approvedOrder())
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    const result = await provider.authorizePayment({ ...input, data: { ...input.data, card_token: "legacy_token" } })

    expect(orderCreateMock.mock.calls[0][0].body.transactions.payments[0].payment_method.token).toBe(TOKEN)
    expect(result.data).not.toHaveProperty("card_token")
  })

  it("refuses a card session without card_attempt_id (legacy or never submitted), before any external call", async () => {
    const provider = buildProvider()
    const { card_token: _t, ...legacy } = DATA

    await expect(provider.authorizePayment({ data: { ...legacy, card_token: TOKEN } })).rejects.toThrow(
      /card payment data is missing/
    )
    expect(attempts.retrieveAttemptView).not.toHaveBeenCalled()
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("refuses an attempt bound to another payment session (card_attempt_not_found)", async () => {
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    await expect(provider.authorizePayment({ ...input, context: { idempotency_key: "payses_other" } })).rejects.toMatchObject({
      code: "card_attempt_not_found",
    })
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("ambiguous result (connection error): rule 8 → unknown with the error class, token kept, error rethrown", async () => {
    const error = apiError(0, "MPConnectionError")
    orderCreateMock.mockRejectedValue(error)
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    await expect(provider.authorizePayment(input)).rejects.toBe(error)
    expect(row(input).state).toBe("unknown")
    expect(row(input).last_error_class).toBe("MPConnectionError")
    expect(row(input).token).toBe(TOKEN)
  })

  it("definitive refusal (402): rule 7 → failed; a later Place order never POSTs again", async () => {
    orderCreateMock.mockRejectedValue(apiError(402, "MPPaymentError"))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    await expect(provider.authorizePayment(input)).rejects.toThrow("MercadoPago API error")
    expect(row(input).state).toBe("failed")
    expect(row(input).token).toBeNull()

    await expect(provider.authorizePayment(input)).rejects.toThrow(/attempt has ended/)
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
  })

  it("replay (rule 4): an unknown attempt is resumed and re-sent with the same key and body", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504)).mockResolvedValueOnce(approvedOrder())
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    await expect(provider.authorizePayment(input)).rejects.toThrow()
    await provider.authorizePayment(input)

    const [first, second] = orderCreateMock.mock.calls.map((call) => call[0])
    expect(attempts.resumeAuthorization).toHaveBeenCalledWith(input.data.card_attempt_id)
    expect(second.requestOptions.idempotencyKey).toBe(first.requestOptions.idempotencyKey)
    expect(second.body).toEqual(first.body)
    expect(row(input).state).toBe("resolved")
  })

  it("resumption (rule 5): a stale authorizing attempt is resumed with the same key", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504)).mockResolvedValueOnce(approvedOrder())
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    Object.assign(row(input), { state: "authorizing", stale: true })

    await provider.authorizePayment(input)

    const [first, second] = orderCreateMock.mock.calls.map((call) => call[0])
    expect(second.requestOptions.idempotencyKey).toBe(first.requestOptions.idempotencyKey)
  })

  it("a recent authorizing attempt (concurrent Place order) is refused with card_attempt_in_progress, no POST", async () => {
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    row(input).state = "authorizing"

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_attempt_in_progress" })
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("replay past the deadline → card_attempt_manual_review and expired, no POST", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    row(input).past_deadline = true

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_attempt_manual_review" })
    expect(row(input).state).toBe("expired")
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
  })

  it("an expired attempt → card_attempt_manual_review, no POST", async () => {
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    row(input).state = "expired"

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_attempt_manual_review" })
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("a submitted attempt whose token is unavailable (deadline) → card_token_unavailable, no POST", async () => {
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    row(input).past_deadline = true

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_token_unavailable" })
    expect(orderCreateMock).not.toHaveBeenCalled()
  })

  it("an unknown attempt whose token cannot be read (decrypt failure) → manual review, never failed, no POST", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    row(input).token = null

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_attempt_manual_review" })
    expect(row(input).state).not.toBe("failed")
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
  })

  it("a resumed (stale) authorizing attempt whose token cannot be read goes back to unknown → manual review, no POST", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    Object.assign(row(input), { state: "authorizing", stale: true, token: null })

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_attempt_manual_review" })
    expect(row(input).state).toBe("unknown")
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
  })

  it("a replay whose body differs from the recorded one is never sent: unknown + manual review", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()

    await expect(provider.authorizePayment({ ...input, data: { ...input.data, installments: 3 } })).rejects.toMatchObject({
      code: "card_attempt_manual_review",
    })
    expect(row(input).state).toBe("unknown")
    expect(row(input).last_error_class).toBe("body_mismatch")
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
  })

  it("rule 12: an unknown attempt with its Order recorded is read (GET, no POST) and resolved when paid", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    await attempts.recordOrder(input.data.card_attempt_id, "ORD_INV009")
    orderGetMock.mockResolvedValue(approvedOrder({ external_reference: row(input).external_reference }))

    const result = await provider.authorizePayment(input)

    expect(orderGetMock).toHaveBeenCalledWith({ id: "ORD_INV009" })
    expect(orderCreateMock).toHaveBeenCalledTimes(1)
    expect(attempts.resolveUnknown).toHaveBeenCalledWith(input.data.card_attempt_id, "ORD_INV009")
    expect(row(input).state).toBe("resolved")
    expect(result.status).toBe("captured")
  })

  it("rule 9 via GET: an unknown attempt whose recorded Order was declined ends failed", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    await attempts.recordOrder(input.data.card_attempt_id, "ORD_INV009")
    orderGetMock.mockResolvedValue(
      approvedOrder({
        status: "failed",
        external_reference: row(input).external_reference,
        transactions: { payments: [{ id: "PAY_INV009", status: "failed", status_detail: "rejected_by_issuer" }] },
      })
    )

    const result = await provider.authorizePayment(input)

    expect(row(input).state).toBe("failed")
    expect(result.status).toBe("error")
  })

  it("a recorded Order whose external_reference is not the attempt's is never settled (manual review)", async () => {
    orderCreateMock.mockRejectedValueOnce(apiError(504))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    await expect(provider.authorizePayment(input)).rejects.toThrow()
    await attempts.recordOrder(input.data.card_attempt_id, "ORD_INV009")
    orderGetMock.mockResolvedValue(approvedOrder({ external_reference: "cart_inv009" }))

    await expect(provider.authorizePayment(input)).rejects.toMatchObject({ code: "card_attempt_manual_review" })
    expect(row(input).state).toBe("unknown")
  })

  it("a 2xx still pending records the Order and keeps the attempt open", async () => {
    orderCreateMock.mockResolvedValue(
      approvedOrder({ status: "processing", transactions: { payments: [{ id: "PAY_INV009", status: "in_process" }] } })
    )
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    const result = await provider.authorizePayment(input)

    expect(result.status).toBe("pending")
    expect(row(input).state).toBe("authorizing")
    expect(row(input).mercadopago_order_id).toBe("ORD_INV009")
  })

  it("a 2xx with a declined payment ends the attempt failed with the Order recorded", async () => {
    orderCreateMock.mockResolvedValue(
      approvedOrder({ status: "failed", transactions: { payments: [{ id: "PAY_INV009", status: "rejected" }] } })
    )
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    const result = await provider.authorizePayment(input)

    expect(result.status).toBe("error")
    expect(row(input).state).toBe("failed")
    expect(row(input).mercadopago_order_id).toBe("ORD_INV009")
  })

  it("a 2xx without the Order id leaves the attempt unknown (the Order may exist)", async () => {
    orderCreateMock.mockResolvedValue(approvedOrder({ id: undefined }))
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)

    await expect(provider.authorizePayment(input)).rejects.toThrow(/order ID was not returned/)
    expect(row(input).state).toBe("unknown")
    expect(row(input).last_error_class).toBe("incomplete_order_response")
  })

  it("accepts a concurrent settlement to the same state (e.g. the webhook path resolved it first)", async () => {
    const provider = buildProvider()
    const input = cardInput(attempts, DATA)
    orderCreateMock.mockImplementation(async () => {
      Object.assign(row(input), { state: "resolved", mercadopago_order_id: "ORD_INV009", token: null })
      return approvedOrder()
    })

    const result = await provider.authorizePayment(input)

    expect(result.status).toBe("captured")
    expect(row(input).state).toBe("resolved")
  })

  describe("deletePayment", () => {
    it("replaces a submitted attempt (rule 2, token destroyed)", async () => {
      const provider = buildProvider()
      const input = cardInput(attempts, DATA)

      await provider.deletePayment({ data: input.data })

      expect(row(input).state).toBe("replaced")
      expect(row(input).token).toBeNull()
    })

    it.each([
      ["authorizing", "card_attempt_pending"],
      ["unknown", "card_attempt_pending"],
      ["expired", "card_attempt_manual_review"],
    ])("refuses while the attempt is %s (%s): the session is frozen", async (state, code) => {
      const provider = buildProvider()
      const input = cardInput(attempts, DATA)
      row(input).state = state as any

      await expect(provider.deletePayment({ data: input.data })).rejects.toMatchObject({ code })
    })

    it("ignores an attempt that no longer exists, and sessions without an attempt", async () => {
      const provider = buildProvider()

      await expect(provider.deletePayment({ data: { card_attempt_id: "mpca_missing" } })).resolves.toBeDefined()
      await expect(provider.deletePayment({ data: { payment_method_id: "visa" } })).resolves.toBeDefined()
    })
  })

  it("classifyCardOrderError: 400/401/402/403/422 are definitive; everything else is ambiguous", () => {
    for (const status of [400, 401, 402, 403, 422]) {
      expect(classifyCardOrderError(apiError(status, "MPPaymentError")).definitive).toBe(true)
    }
    for (const status of [0, 409, 423, 429, 500, 502, 503, 504]) {
      expect(classifyCardOrderError(apiError(status)).definitive).toBe(false)
    }
    expect(classifyCardOrderError(new Error("x")).definitive).toBe(false)
    expect(classifyCardOrderError(apiError(402)).errorClass).toBe("http_402")
    expect(classifyCardOrderError({ name: "bad name!", status: 500 }).errorClass).toBe("UnknownError")
  })
})
