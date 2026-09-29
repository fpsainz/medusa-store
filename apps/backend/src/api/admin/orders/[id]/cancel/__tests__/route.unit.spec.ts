jest.mock("../../../../../../workflows/cancel-order-with-pending-pix", () => {
  const run = jest.fn()
  return {
    __run: run,
    cancelOrderWithPendingPixWorkflow: jest.fn(() => ({ run })),
  }
})

import { MedusaError } from "@medusajs/framework/utils"

import * as routeModule from "../route"
import { cancelOrderWithPendingPixWorkflow } from "../../../../../../workflows/cancel-order-with-pending-pix"

const run: jest.Mock = jest.requireMock("../../../../../../workflows/cancel-order-with-pending-pix").__run
const workflowFactory = cancelOrderWithPendingPixWorkflow as unknown as jest.Mock

function buildReq(graph = jest.fn(async () => ({ data: [{ id: "order_1", status: "canceled" }] }))) {
  const scope = {
    resolve: (key: string) => {
      if (key === "query") return { graph }
      throw new Error(`unexpected resolve ${key}`)
    },
  }
  const req = {
    params: { id: "order_1" },
    auth_context: { actor_id: "user_1", actor_type: "user" },
    queryConfig: { fields: ["id", "status", "payment_status"] },
    scope,
  }
  return { req: req as any, graph, scope }
}

function buildRes() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

beforeEach(() => {
  run.mockReset()
  workflowFactory.mockClear()
})

describe("POST /admin/orders/:id/cancel (override)", () => {
  it("keeps the default /admin authentication: the route does not opt out", () => {
    expect(routeModule).not.toHaveProperty("AUTHENTICATE")
    expect(Object.keys(routeModule)).toEqual(["POST"])
  })

  it("runs the wrapper with the core route's input and answers { order } with the query config fields", async () => {
    run.mockResolvedValue({ result: undefined })
    const { req, graph, scope } = buildReq()
    const res = buildRes()

    await routeModule.POST(req, res)

    expect(workflowFactory).toHaveBeenCalledWith(scope)
    expect(run).toHaveBeenCalledWith({ input: { order_id: "order_1", canceled_by: "user_1" } })
    expect(graph).toHaveBeenCalledWith({
      entity: "order",
      fields: ["id", "status", "payment_status"],
      filters: { id: "order_1" },
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ order: { id: "order_1", status: "canceled" } })
  })

  it("lets a workflow error reach Medusa's error handler, without reading or answering the order", async () => {
    run.mockRejectedValue(
      new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Mercado Pago: order order_1 was not canceled because its pending Pix charge could not be canceled (paid)."
      )
    )
    const { req, graph } = buildReq()
    const res = buildRes()

    await expect(routeModule.POST(req, res)).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED })
    expect(graph).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})
