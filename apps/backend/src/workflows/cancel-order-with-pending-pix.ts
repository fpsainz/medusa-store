import { WorkflowResponse, createWorkflow, transform } from "@medusajs/framework/workflows-sdk"
import { cancelOrderWorkflow, cancelValidateOrder, useQueryGraphStep } from "@medusajs/medusa/core-flows"
import type { OrderDTO, OrderWorkflow } from "@medusajs/framework/types"

import { cancelPendingPixChargeStep } from "./steps/cancel-pending-pix-charge"

export const cancelOrderWithPendingPixWorkflowId = "cancel-order-with-pending-pix"

// Order cancellation used by POST /admin/orders/:id/cancel (ADR-013).
//
// cancelOrderWorkflow only reaches the orderCanceled hook after
// updatePaymentCollectionStep has set the collection to 'canceled', and in
// Medusa 2.20.1 that step's compensation fails, so a hook refusal leaves the
// order 'pending' with its collection 'canceled' (INV-006). The pending Pix
// is therefore cancelled first, and the core only runs once that succeeded:
// - the order cannot be cancelled (core validation) → nothing is touched;
// - reading or cancelling the Pix fails, or it is already paid → the error
//   reaches the caller and the core never runs;
// - no pending Pix (card, no payment, Pix already authorized) → core only;
// - Pix cancelled, then the core fails → the Pix stays cancelled (Mercado
//   Pago cannot undo it) and the order stays active; a new cancellation
//   finds no pending Pix and only runs the core.
// The orderCanceled hook still runs inside the core and finds nothing to do.
export const cancelOrderWithPendingPixWorkflow = createWorkflow(
  cancelOrderWithPendingPixWorkflowId,
  function (input: OrderWorkflow.CancelOrderWorkflowInput) {
    // Same validation input as the core; the core reads the order again
    // inside its own transaction.
    const orderQuery = useQueryGraphStep({
      entity: "order",
      fields: ["id", "status", "fulfillments.canceled_at"],
      filters: { id: input.order_id },
      options: { throwIfKeyNotFound: true },
    }).config({ name: "get-order-to-cancel" })

    // Partial order, as in the core (untyped there): cancelValidateOrder only
    // reads status and fulfillments, the fields queried above.
    const order = transform({ orderQuery }, ({ orderQuery }) => orderQuery.data[0] as unknown as OrderDTO)

    cancelValidateOrder({ order, input })

    const pixInput = transform({ input }, ({ input }) => ({ order_id: input.order_id }))
    cancelPendingPixChargeStep(pixInput)

    cancelOrderWorkflow.runAsStep({ input })

    return new WorkflowResponse(void 0)
  }
)
