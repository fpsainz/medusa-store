jest.mock("@medusajs/medusa/core-flows", () => ({
  cancelOrderWorkflow: { hooks: { orderCanceled: jest.fn() } },
}))

import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows"
import { MedusaError } from "@medusajs/framework/utils"
import { cancelPendingPixCharge, selectPendingPixSessions } from "../order-canceled"

const orderCanceledHook = cancelOrderWorkflow.hooks.orderCanceled as unknown as jest.Mock

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

function buildContainer(sessions: Session[], updatePaymentSession = jest.fn()) {
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

describe("orderCanceled hook: pending Pix charge", () => {
  it("is registered on cancelOrderWorkflow.hooks.orderCanceled", () => {
    expect(orderCanceledHook).toHaveBeenCalledWith(cancelPendingPixCharge)
  })

  it("cancels the pending Pix through the payment module with the transient 'cancel' action", async () => {
    const updatePaymentSession = jest.fn(async () => ({ id: "payses_pix", status: "canceled" }))
    const { container, graph } = buildContainer([pendingPix()], updatePaymentSession)

    const result = await cancelPendingPixCharge({ order: { id: "order_1" } }, { container })

    expect(graph).toHaveBeenCalledWith(expect.objectContaining({ entity: "order", filters: { id: "order_1" } }))
    expect(updatePaymentSession).toHaveBeenCalledTimes(1)
    expect(updatePaymentSession).toHaveBeenCalledWith({
      id: "payses_pix",
      amount: 110,
      currency_code: "brl",
      data: {
        payment_method_id: "pix",
        mercadopago_order_id: "ORD_PIX_1",
        amount: "110.00",
        mercadopago_pix_action: "cancel",
      },
    })
    expect(result.output).toEqual({ payment_session_id: "payses_pix", status: "canceled" })
  })

  it.each([
    ["no payment session at all", []],
    ["a card session", [pendingPix({ id: "payses_card", data: { payment_method_id: "visa", mercadopago_order_id: "ORD_CARD" } })]],
    ["an authorized (paid) Pix: the core refunds its captured Payment", [pendingPix({ status: "authorized" })]],
    ["a Pix already canceled", [pendingPix({ status: "canceled" })]],
    ["a Pix session without a Mercado Pago Order", [pendingPix({ data: { payment_method_id: "pix" } })]],
    ["another provider", [pendingPix({ provider_id: "pp_system_default" })]],
    ["a pending session that is not Pix", [pendingPix({ data: { payment_method_id: "visa", mercadopago_order_id: "ORD_X" } })]],
  ])("does nothing for %s", async (_label, sessions) => {
    const { container, updatePaymentSession } = buildContainer(sessions as Session[])

    const result = await cancelPendingPixCharge({ order: { id: "order_1" } }, { container })

    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(result.output).toBeUndefined()
  })

  it("refuses to choose between two pending Pix charges (the order is not canceled)", async () => {
    const { container, updatePaymentSession } = buildContainer([
      pendingPix({ id: "payses_a" }),
      pendingPix({ id: "payses_b", data: { payment_method_id: "pix", mercadopago_order_id: "ORD_PIX_2" } }),
    ])

    await expect(cancelPendingPixCharge({ order: { id: "order_1" } }, { container })).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: "Mercado Pago: order order_1 has more than one pending Pix charge; it was not canceled.",
    })
    expect(updatePaymentSession).not.toHaveBeenCalled()
  })

  it("a paid charge (provider NOT_ALLOWED) makes the hook throw, so the cancellation is rolled back", async () => {
    const updatePaymentSession = jest.fn(async () => {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Mercado Pago: this Pix charge has already been paid and cannot be discarded."
      )
    })
    const { container } = buildContainer([pendingPix()], updatePaymentSession)

    await expect(cancelPendingPixCharge({ order: { id: "order_1" } }, { container })).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message:
        "Mercado Pago: order order_1 was not canceled because its pending Pix charge could not be canceled (Mercado Pago: this Pix charge has already been paid and cannot be discarded.).",
    })
  })

  it("a Mercado Pago API error (409 cannot_cancel_order) makes the hook throw", async () => {
    const updatePaymentSession = jest.fn(async () => {
      throw Object.assign(new Error("cannot_cancel_order"), { status: 409 })
    })
    const { container } = buildContainer([pendingPix()], updatePaymentSession)

    await expect(cancelPendingPixCharge({ order: { id: "order_1" } }, { container })).rejects.toMatchObject({
      type: MedusaError.Types.UNEXPECTED_STATE,
      message:
        "Mercado Pago: order order_1 was not canceled because its pending Pix charge could not be canceled (cannot_cancel_order).",
    })
  })
})

describe("selectPendingPixSessions", () => {
  it("keeps only Mercado Pago Pix sessions pending authorization with a Mercado Pago Order", () => {
    const keep = pendingPix()
    expect(
      selectPendingPixSessions([
        keep,
        pendingPix({ id: "a", status: "authorized" }),
        pendingPix({ id: "b", provider_id: "pp_other" }),
        pendingPix({ id: "c", data: { payment_method_id: "pix", mercadopago_order_id: "" } }),
      ])
    ).toEqual([keep])
  })
})
