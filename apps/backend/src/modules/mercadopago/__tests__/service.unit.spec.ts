const orderCreateMock = jest.fn()
const orderGetMock = jest.fn()

jest.mock("mercadopago", () => {
  return {
    MercadoPagoConfig: jest.fn().mockImplementation((...args: unknown[]) => ({ args })),
    Order: jest.fn().mockImplementation(() => ({
      create: (...args: unknown[]) => orderCreateMock(...args),
      get: (...args: unknown[]) => orderGetMock(...args),
    })),
  }
})

import MercadoPagoPaymentProviderService from "../service"

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
