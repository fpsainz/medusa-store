import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { issuePixPaymentAccessWorkflow } from "../../workflows/payment-access/issue-pix-payment-access"

// The capability travels to the storefront server in response headers, never
// in the JSON body: the body is what a Client Component may end up with, and
// the headers are not exposed to browser scripts (no
// Access-Control-Expose-Headers). See ADR-007.
export const PAYMENT_ACCESS_TOKEN_HEADER = "x-payment-access-token"
export const PAYMENT_ACCESS_EXPIRES_AT_HEADER = "x-payment-access-expires-at"

// Issues the Pix payment capability for this cart's Pix session and attaches
// it to the response. Failing to issue one (e.g. the payment_access table is
// not migrated yet) never fails the Pix preparation itself: the buyer simply
// gets no capability, which grants nothing.
export async function attachPixPaymentAccess(
  req: MedusaRequest,
  res: MedusaResponse,
  input: { cart_id: string; payment_session_id: string }
): Promise<void> {
  try {
    const { result } = await issuePixPaymentAccessWorkflow(req.scope).run({ input })

    if (result) {
      res.setHeader(PAYMENT_ACCESS_TOKEN_HEADER, result.token)
      res.setHeader(PAYMENT_ACCESS_EXPIRES_AT_HEADER, result.expires_at)
    }
  } catch (error) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    logger.warn(
      `Mercado Pago: no Pix payment capability issued for payment session ${input.payment_session_id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
