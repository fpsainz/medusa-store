import { Modules } from "@medusajs/framework/utils"

import { POST } from "../route"

describe("mercadopago payment session route", () => {
  it("updates the Medusa payment session without authorizing it", async () => {
    const paymentSession = {
      id: "payses_123",
      amount: 100,
      currency_code: "BRL",
      data: {
        existing: true,
      },
    }

    const updatePaymentSession = jest.fn(async (input) => ({
      ...input,
      id: input.id,
    }))
    const retrievePaymentSession = jest.fn(async () => paymentSession)
    const authorizePaymentSession = jest.fn(async () => ({ id: "pay_123" }))

    const req: any = {
      params: { id: "payses_123" },
      body: {
        card_token: "cardtoken_123",
        payment_method_id: "visa",
        installments: 1,
        transaction_amount: 100,
        payer: { email: "customer@example.com" },
      },
      scope: {
        resolve: (module: string) => {
          if (module === Modules.PAYMENT) {
            return {
              retrievePaymentSession,
              updatePaymentSession,
              authorizePaymentSession,
            }
          }

          throw new Error(`Unexpected module request: ${module}`)
        },
      },
    }

    const res: any = {
      json: jest.fn(),
    }

    await POST(req, res)

    expect(retrievePaymentSession).toHaveBeenCalledWith("payses_123")
    expect(updatePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "payses_123",
        amount: 100,
        currency_code: "BRL",
        data: expect.objectContaining({
          existing: true,
          card_token: "cardtoken_123",
          payment_method_id: "visa",
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
})
