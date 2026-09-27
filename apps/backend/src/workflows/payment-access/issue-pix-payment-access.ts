import { WorkflowResponse, createWorkflow } from "@medusajs/framework/workflows-sdk"

import { issuePaymentAccessGrantStep } from "./steps/issue-payment-access-grant"
import {
  type ResolvePixAccessBindingInput,
  resolvePixAccessBindingStep,
} from "./steps/resolve-pix-access-binding"

// Issues a read-only Pix payment capability for an open cart's Pix session
// (ADR-007). Resolves to null when no capability may be issued.
export const issuePixPaymentAccessWorkflow = createWorkflow(
  "issue-pix-payment-access",
  (input: ResolvePixAccessBindingInput) => {
    const binding = resolvePixAccessBindingStep(input)
    const issued = issuePaymentAccessGrantStep(binding)

    return new WorkflowResponse(issued)
  }
)
