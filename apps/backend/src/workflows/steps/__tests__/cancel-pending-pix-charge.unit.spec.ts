import { MedusaError } from "@medusajs/framework/utils"

import {
  cancelPendingPixChargeForOrder,
  cancelPendingPixChargeInvoke,
  cancelPendingPixChargeStep,
} from "../cancel-pending-pix-charge"

type Session = {
  id: string
  provider_id: string
  status: string
  amount: number
  currency_code: string
  data: Record<string, unknown>
}

const pendingPix = (overrides: Partial<Session> = {}): Session => ({
  id: "payses_pix",
  provider_id: "pp_mercadopago",
  status: "pending_authorization",
  amount: 110,
  currency_code: "brl",
  data: { payment_method_id: "pix", mercadopago_order_id: "ORD_PIX_1", amount: "110.00" },
  ...overrides,
})

function buildContainer(
  sessions: Session[],
  updatePaymentSession: jest.Mock = jest.fn(async ({ id }: { id: string }) => ({ id, status: "canceled" }))
) {
  const graph = jest.fn(async () => ({
    data: [{ id: "order_1", payment_collections: [{ payment_sessions: sessions }] }],
  }))
  const container = {
    resolve: (key: string) => {
      if (key === "query") return { graph }
      if (key === "payment") return { updatePaymentSession }
      throw new Error(`unexpected resolve ${key}`)
    },
  }
  return { container: container as any, graph, updatePaymentSession }
}

describe("cancel-pending-pix-charge step", () => {
  it("is a workflow step named cancel-pending-pix-charge", () => {
    expect(typeof cancelPendingPixChargeStep).toBe("function")
    expect((cancelPendingPixChargeStep as unknown as { __step__: string }).__step__).toBe("cancel-pending-pix-charge")
  })

  it("cancels only the pending Pix, through the provider's 'cancel' action, once", async () => {
    const { container, graph, updatePaymentSession } = buildContainer([
      pendingPix(),
      pendingPix({ id: "payses_card", status: "authorized", data: { payment_method_id: "visa", mercadopago_order_id: "ORD_CARD" } }),
    ])

    const response = await cancelPendingPixChargeInvoke({ order_id: "order_1" }, { container })

    expect(graph).toHaveBeenCalledWith(expect.objectContaining({ entity: "order", filters: { id: "order_1" } }))
    expect(updatePaymentSession).toHaveBeenCalledTimes(1)
    expect(updatePaymentSession).toHaveBeenCalledWith({
      id: "payses_pix",
      amount: 110,
      currency_code: "brl",
      data: expect.objectContaining({ mercadopago_order_id: "ORD_PIX_1", mercadopago_pix_action: "cancel" }),
    })
    expect(response.output).toEqual({ payment_session_id: "payses_pix", status: "canceled" })
  })

  it.each([
    ["no payment session", []],
    ["a card session", [pendingPix({ data: { payment_method_id: "visa", mercadopago_order_id: "ORD_CARD" } })]],
    ["a card with a captured Payment", [pendingPix({ status: "authorized", data: { payment_method_id: "visa", mercadopago_order_id: "ORD_CARD" } })]],
    ["a paid Pix already processed by Medusa (authorized)", [pendingPix({ status: "authorized" })]],
    ["a Pix cancelled earlier (retry)", [pendingPix({ status: "canceled" })]],
  ])("does nothing for %s", async (_label, sessions) => {
    const { container, updatePaymentSession } = buildContainer(sessions as Session[])

    await expect(cancelPendingPixChargeForOrder("order_1", container)).resolves.toBeUndefined()
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it.each([
    [
      "a paid Pix not yet processed (provider NOT_ALLOWED, the #95 race)",
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Mercado Pago: this Pix charge has already been paid and cannot be discarded."),
      MedusaError.Types.NOT_ALLOWED,
    ],
    [
      "an unknown Mercado Pago status (provider UNEXPECTED_STATE)",
      new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Mercado Pago: unrecognized Pix order status "weird".'),
      MedusaError.Types.UNEXPECTED_STATE,
    ],
    ["a failed GET of the Mercado Pago Order", Object.assign(new Error("At least one policy returned UNAUTHORIZED."), { status: 403 }), MedusaError.Types.UNEXPECTED_STATE],
    ["a Mercado Pago cancel refusal (409)", Object.assign(new Error("cannot_cancel_order"), { status: 409 }), MedusaError.Types.UNEXPECTED_STATE],
  ])("rethrows %s with the reason", async (_label, providerError, type) => {
    const updatePaymentSession = jest.fn(async () => {
      throw providerError
    })
    const { container } = buildContainer([pendingPix()], updatePaymentSession)

    await expect(cancelPendingPixChargeForOrder("order_1", container)).rejects.toMatchObject({
      type,
      message: `Mercado Pago: order order_1 was not canceled because its pending Pix charge could not be canceled (${providerError.message}).`,
    })
    expect(updatePaymentSession).toHaveBeenCalledTimes(1)
  })

  it("refuses to choose between two pending Pix charges", async () => {
    const { container, updatePaymentSession } = buildContainer([
      pendingPix({ id: "payses_a" }),
      pendingPix({ id: "payses_b", data: { payment_method_id: "pix", mercadopago_order_id: "ORD_PIX_2" } }),
    ])

    await expect(cancelPendingPixChargeForOrder("order_1", container)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    })
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })
})
