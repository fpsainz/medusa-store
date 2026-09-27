import { StepResponse, WorkflowResponse, createStep, createWorkflow } from "@medusajs/framework/workflows-sdk"

import { PAYMENT_ACCESS_MODULE } from "../../modules/payment-access"
import { PAYMENT_ACCESS_RETENTION_MS } from "../../modules/payment-access/policies"
import type PaymentAccessModuleService from "../../modules/payment-access/service"

export type PurgeExpiredPaymentAccessInput = {
  batch_size?: number
}

// Deleting is not compensated: a purged grant was already unusable for the
// whole retention period.
export const purgeExpiredPaymentAccessStep = createStep(
  "purge-expired-payment-access",
  async (input: PurgeExpiredPaymentAccessInput, { container }) => {
    const paymentAccess: PaymentAccessModuleService = container.resolve(PAYMENT_ACCESS_MODULE)
    const deleted = await paymentAccess.purgeExpiredGrants({
      retention_ms: PAYMENT_ACCESS_RETENTION_MS,
      batch_size: input.batch_size,
    })

    return new StepResponse(deleted)
  }
)

// Removes payment capabilities expired or revoked more than 7 days ago
// (ADR-007). Returns how many were removed.
export const purgeExpiredPaymentAccessWorkflow = createWorkflow(
  "purge-expired-payment-access",
  (input: PurgeExpiredPaymentAccessInput) => {
    const deleted = purgeExpiredPaymentAccessStep(input)

    return new WorkflowResponse(deleted)
  }
)
