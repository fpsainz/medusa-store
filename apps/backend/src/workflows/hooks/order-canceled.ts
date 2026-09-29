import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"

import { cancelPendingPixChargeForOrder } from "../steps/cancel-pending-pix-charge"

export { selectPendingPixSessions } from "../steps/cancel-pending-pix-charge"

// Safety net for callers that run cancelOrderWorkflow directly (ADR-012).
// The Admin route runs cancel-order-with-pending-pix instead, which cancels
// the pending Pix before the core touches the payment collection (ADR-013);
// by the time this hook runs there, the session is 'canceled' and this is a
// no-op. When it does act, it runs after updatePaymentCollectionStep:
// throwing here rolls the order cancellation back, but Medusa 2.20.1 leaves
// the payment collection 'canceled' (INV-006).
export async function cancelPendingPixCharge(
  { order }: { order: { id: string } },
  { container }: { container: MedusaContainer }
) {
  return new StepResponse(await cancelPendingPixChargeForOrder(order.id, container))
}

cancelOrderWorkflow.hooks.orderCanceled(cancelPendingPixCharge)
