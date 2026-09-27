import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

import { PAYMENT_ACCESS_MODULE } from "../../../modules/payment-access"
import { PIX_PAYMENT_VIEW_POLICY } from "../../../modules/payment-access/policies"
import type PaymentAccessModuleService from "../../../modules/payment-access/service"
import type { PixAccessBinding } from "../pix-access-binding"

export type IssuedPixPaymentAccess = {
  // Plaintext token, handed to the caller once. Only its hash is stored.
  token: string
  expires_at: string
}

export const issuePaymentAccessGrantStep = createStep(
  "issue-payment-access-grant",
  async (binding: PixAccessBinding | null, { container }) => {
    if (!binding) {
      return new StepResponse<IssuedPixPaymentAccess | null, string | null>(null, null)
    }

    const paymentAccess: PaymentAccessModuleService = container.resolve(PAYMENT_ACCESS_MODULE)
    const issued = await paymentAccess.issueGrant({
      purpose: PIX_PAYMENT_VIEW_POLICY.purpose,
      provider_id: PIX_PAYMENT_VIEW_POLICY.provider_id,
      payment_method: PIX_PAYMENT_VIEW_POLICY.payment_method,
      payment_session_id: binding.payment_session_id,
      payment_collection_id: binding.payment_collection_id,
      cart_id: binding.cart_id,
      expires_at: new Date(binding.expires_at),
      max_active_per_session: PIX_PAYMENT_VIEW_POLICY.max_active_per_session,
    })

    return new StepResponse<IssuedPixPaymentAccess | null, string | null>(
      { token: issued.token, expires_at: issued.expires_at.toISOString() },
      issued.grant_id
    )
  },
  // If a later step fails, the capability that was issued must not stay usable.
  async (grantId, { container }) => {
    if (!grantId) {
      return
    }

    const paymentAccess: PaymentAccessModuleService = container.resolve(PAYMENT_ACCESS_MODULE)
    await paymentAccess.updatePaymentAccessGrants({
      id: grantId,
      revoked_at: new Date(),
      revoked_reason: "compensated",
    })
  }
)
