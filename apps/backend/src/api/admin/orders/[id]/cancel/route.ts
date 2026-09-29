import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { HttpTypes } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { cancelOrderWithPendingPixWorkflow } from "../../../../../workflows/cancel-order-with-pending-pix"

// Overrides @medusajs/medusa's POST /admin/orders/:id/cancel: project routes
// are registered after the core's, and the later registration of the same
// path and method wins. Authentication (/admin), the core's query validation
// (req.queryConfig) and policies still apply: they are bound to the path, not
// to the route file. Same request and response as the core route; the only
// change is the workflow, which cancels a pending Mercado Pago Pix before
// cancelOrderWorkflow (ADR-013).
export const POST = async (
  req: AuthenticatedMedusaRequest<{}, HttpTypes.AdminGetOrderParams>,
  // Untyped like the core route's remoteQuery result: the order's fields
  // come from req.queryConfig, not from a static type.
  res: MedusaResponse
) => {
  await cancelOrderWithPendingPixWorkflow(req.scope).run({
    input: {
      order_id: req.params.id,
      canceled_by: req.auth_context.actor_id,
    },
  })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: req.queryConfig.fields,
    filters: { id: req.params.id },
  })

  res.status(200).json({ order })
}
