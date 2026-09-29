// Runs the real workflow engine with the real useQueryGraphStep and
// cancelValidateOrder. cancelOrderWorkflow is replaced by a step that records
// when the core would run and, like the core, invokes the handler registered
// on hooks.orderCanceled (the project's safety-net hook).
type HookHandler = (input: { order: { id: string } }, ctx: { container: unknown }) => Promise<unknown>

// Shared state lives in the mocked module: imports are hoisted above this file's constants.
jest.mock("@medusajs/medusa/core-flows", () => {
  const calls: string[] = []
  const hookHandlers: HookHandler[] = []
  const actual = jest.requireActual("@medusajs/medusa/core-flows")
  const { createStep, StepResponse } = jest.requireActual("@medusajs/framework/workflows-sdk")

  const fakeCoreStep = createStep(
    "cancel-order-as-step",
    async (input: { order_id: string }, { container }: { container: unknown }) => {
      calls.push(`core:${input.order_id}`)
      for (const handler of hookHandlers) {
        await handler({ order: { id: input.order_id } }, { container })
      }
      return new StepResponse(undefined)
    }
  )

  return {
    ...actual,
    __calls: calls,
    cancelOrderWorkflow: {
      runAsStep: ({ input }: { input: unknown }) => fakeCoreStep(input),
      hooks: {
        orderCanceled: (handler: HookHandler) => {
          hookHandlers.push(handler)
        },
      },
    },
  }
})

import { asValue } from "@medusajs/framework/awilix"
import { MedusaError, createMedusaContainer } from "@medusajs/framework/utils"

import "../hooks/order-canceled"
import { cancelOrderWithPendingPixWorkflow } from "../cancel-order-with-pending-pix"

const calls: string[] = jest.requireMock("@medusajs/medusa/core-flows").__calls

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

const cardCaptured = (): Session => ({
  id: "payses_card",
  provider_id: "pp_mercadopago",
  status: "authorized",
  amount: 110,
  currency_code: "brl",
  data: { payment_method_id: "visa", payment_type_id: "credit_card", mercadopago_order_id: "ORD_CARD" },
})

type Order = { id: string; status: string; fulfillments: Array<{ canceled_at: string | null }> }

// Stateful doubles: updatePaymentSession behaves like the provider's 'cancel'
// action (session ends 'canceled'), unless a failure is injected.
function setup({
  sessions,
  order = { id: "order_1", status: "pending", fulfillments: [] },
  providerError,
}: {
  sessions: Session[]
  order?: Order
  providerError?: Error
}) {
  const state = { sessions: sessions.map((s) => ({ ...s })) }

  const graph = jest.fn(async ({ fields }: { fields: string[] }) => {
    if (fields.some((f) => f.startsWith("payment_collections."))) {
      return { data: [{ id: order.id, payment_collections: [{ payment_sessions: state.sessions }] }], metadata: {} }
    }
    return { data: [order], metadata: {} }
  })

  const updatePaymentSession = jest.fn(async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
    calls.push(`pix-cancel:${id}:${data.mercadopago_pix_action}`)
    if (providerError) {
      throw providerError
    }
    const session = state.sessions.find((s) => s.id === id)!
    session.status = "canceled"
    return { id, status: "canceled" }
  })

  const container = createMedusaContainer()
  container.register({
    query: asValue({ graph }),
    payment: asValue({ updatePaymentSession }),
  })

  const run = () =>
    cancelOrderWithPendingPixWorkflow(container).run({
      input: { order_id: order.id, canceled_by: "user_1" },
      throwOnError: false,
    })

  return { run, graph, updatePaymentSession, state }
}

beforeEach(() => {
  calls.length = 0
})

describe("cancelOrderWithPendingPixWorkflow", () => {
  it("without a pending Pix, runs only the core cancellation", async () => {
    const { run, updatePaymentSession } = setup({ sessions: [] })

    const { errors } = await run()

    expect(errors).toEqual([])
    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(calls).toEqual(["core:order_1"])
  })

  it("cancels the pending Pix before the core, and the safety-net hook does not cancel it again", async () => {
    const { run, updatePaymentSession, state } = setup({ sessions: [pendingPix()] })

    const { errors } = await run()

    expect(errors).toEqual([])
    expect(calls).toEqual(["pix-cancel:payses_pix:cancel", "core:order_1"])
    // One provider 'cancel' action in total: the hook found the session already canceled.
    expect(updatePaymentSession).toHaveBeenCalledTimes(1)
    expect(state.sessions[0].status).toBe("canceled")
  })

  it.each([
    [
      "the Pix is already paid (provider NOT_ALLOWED)",
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Mercado Pago: this Pix charge has already been paid and cannot be discarded."),
      MedusaError.Types.NOT_ALLOWED,
    ],
    [
      "reading the Mercado Pago Order fails",
      Object.assign(new Error("At least one policy returned UNAUTHORIZED."), { status: 403 }),
      MedusaError.Types.UNEXPECTED_STATE,
    ],
    [
      "the Mercado Pago Order status is unknown (provider UNEXPECTED_STATE)",
      new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Mercado Pago: unrecognized Pix order status "weird".'),
      MedusaError.Types.UNEXPECTED_STATE,
    ],
  ])("refuses before the core when %s (the collection is never touched)", async (_label, providerError, type) => {
    const { run } = setup({ sessions: [pendingPix()], providerError })

    const { errors } = await run()

    expect(calls).toEqual(["pix-cancel:payses_pix:cancel"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ action: "cancel-pending-pix-charge", handlerType: "invoke" })
    expect(errors[0].error).toMatchObject({
      type,
      message: expect.stringContaining("Mercado Pago: order order_1 was not canceled because its pending Pix charge could not be canceled"),
    })
  })

  it("refuses two pending Pix charges without choosing one, before the core", async () => {
    const { run, updatePaymentSession } = setup({
      sessions: [pendingPix({ id: "payses_a" }), pendingPix({ id: "payses_b", data: { payment_method_id: "pix", mercadopago_order_id: "ORD_PIX_2" } })],
    })

    const { errors } = await run()

    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(errors[0].error).toMatchObject({ type: MedusaError.Types.NOT_ALLOWED })
  })

  it.each([
    ["already canceled", { id: "order_1", status: "canceled", fulfillments: [] }, "Order with id order_1 has been canceled."],
    ["completed", { id: "order_1", status: "completed", fulfillments: [] }, "Cannot cancel a completed order."],
    ["with an active fulfillment", { id: "order_1", status: "pending", fulfillments: [{ canceled_at: null }] }, "All fulfillments must be canceled"],
  ])("does not cancel the Pix when the order cannot be canceled (%s)", async (_label, order, message) => {
    const { run, updatePaymentSession } = setup({ sessions: [pendingPix()], order: order as Order })

    const { errors } = await run()

    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(errors[0]).toMatchObject({ action: "cancel-validate-order" })
    expect(errors[0].error.message).toContain(message)
  })

  it("leaves a card order with a captured Payment to the core (refund), without any Pix action", async () => {
    const { run, updatePaymentSession } = setup({ sessions: [cardCaptured()] })

    const { errors } = await run()

    expect(errors).toEqual([])
    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(calls).toEqual(["core:order_1"])
  })

  it("runs the core again on a retry after the Pix was already cancelled (idempotent)", async () => {
    const { run, updatePaymentSession } = setup({ sessions: [pendingPix({ status: "canceled" })] })

    const { errors } = await run()

    expect(errors).toEqual([])
    expect(updatePaymentSession).not.toHaveBeenCalled()
    expect(calls).toEqual(["core:order_1"])
  })
})
