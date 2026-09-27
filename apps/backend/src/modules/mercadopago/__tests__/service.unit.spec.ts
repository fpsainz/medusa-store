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

import MercadoPagoPaymentProviderService, { normalizePixStatus, toPixPaymentDto } from "../service"

describe("MercadoPagoPaymentProviderService.authorizePayment", () => {
  function buildProvider() {
    // Cast to `any`: the abstract base's constructor is `protected` in its
    // `.d.ts`, which trips TS's construct-signature inference for `new` here
    // even though the concrete subclass constructor is public at runtime.
    const ProviderClass = MercadoPagoPaymentProviderService as any
    return new ProviderClass({}, { access_token: "test-access-token" })
  }

  beforeEach(() => {
    jest.clearAllMocks()
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

    const result = await provider.authorizePayment({
      data: {
        payment_method_id: "visa",
        payment_type_id: "credit_card",
        card_token: "card_token_abc",
        issuer_id: "123",
        installments: 3,
        transaction_amount: 100,
        cart_id: "cart_123",
        payer: { email: "buyer@example.com" },
      },
    })

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

      await provider.authorizePayment({ data: { ...CARD_DATA, payment_type_id: "debit_card" } })

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

      await expect(provider.authorizePayment({ data: { ...CARD_DATA } })).rejects.toThrow(
        /missing the card type\. Please re-enter your payment information/
      )

      expect(orderCreateMock).not.toHaveBeenCalled()
    })

    it.each(["prepaid_card", "creditCard", "debitCard", "", "foo"])(
      "refuses payment_type_id=%p and creates no Order",
      async (paymentTypeId) => {
        const provider = buildProvider()

        await expect(
          provider.authorizePayment({ data: { ...CARD_DATA, payment_type_id: paymentTypeId } })
        ).rejects.toThrow(/unsupported card payment type/)

        expect(orderCreateMock).not.toHaveBeenCalled()
      }
    )

    it("treats payment_type_id=null like a missing card type", async () => {
      const provider = buildProvider()

      await expect(
        provider.authorizePayment({ data: { ...CARD_DATA, payment_type_id: null } })
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
      ).rejects.toThrow(/card_token and payment_method_id/)

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

  it("returns only display fields and native statuses — no payer, card or key", () => {
    const dto = toPixPaymentDto({ status: "pending", data })

    expect(dto).toEqual({
      status: "pending",
      session_status: "pending",
      mercadopago_order_id: "ORD_PIX_A",
      order_status: "action_required",
      order_status_detail: "waiting_transfer",
      payment_status: "action_required",
      payment_status_detail: "waiting_transfer",
      qr_code: "000201",
      qr_code_base64: "iVBOR",
      ticket_url: "https://ticket",
      expires_at: "2026-09-26T12:00:00.000-03:00",
    })
    expect(JSON.stringify(dto)).not.toMatch(/buyer@example|12345678909|tok_secret|pix-key/)
  })

  it("reports approved once Medusa has authorized the session, even with a stale stored MP status", () => {
    expect(toPixPaymentDto({ status: "authorized", data }).status).toBe("approved")
  })
})
