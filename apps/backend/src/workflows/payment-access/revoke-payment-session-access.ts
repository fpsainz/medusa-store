import { StepResponse, WorkflowResponse, createStep, createWorkflow } from "@medusajs/framework/workflows-sdk"

import { PAYMENT_ACCESS_MODULE } from "../../modules/payment-access"
import type PaymentAccessModuleService from "../../modules/payment-access/service"

export type RevokePaymentSessionAccessInput = {
  payment_session_id: string
  reason: string
}

// Revocation is not compensated: a revoked capability must stay revoked.
export const revokePaymentSessionAccessStep = createStep(
  "revoke-payment-session-access",
  async (input: RevokePaymentSessionAccessInput, { container }) => {
    const paymentAccess: PaymentAccessModuleService = container.resolve(PAYMENT_ACCESS_MODULE)
    const revoked = await paymentAccess.revokeSessionGrants(input.payment_session_id, input.reason)

    return new StepResponse(revoked)
  }
)

export const revokePaymentSessionAccessWorkflow = createWorkflow(
  "revoke-payment-session-access",
  (input: RevokePaymentSessionAccessInput) => {
    const revoked = revokePaymentSessionAccessStep(input)

    return new WorkflowResponse(revoked)
  }
)
