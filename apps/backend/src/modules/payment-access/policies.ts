import type { PaymentAccessPurpose } from "./grants"

export type PaymentAccessPolicy = {
  purpose: PaymentAccessPurpose
  provider_id: string
  payment_method: string
  // Active capabilities kept per Payment Session; older ones are revoked.
  max_active_per_session: number
  // How long after the payment deadline (or a final state) the capability
  // still answers, with the status only.
  grace_ms: number
}

// Pix policy (ADR-007; parameters are a human decision of 2026-09-27): the
// capability lives until the Pix deadline + 15 minutes, with no other cap,
// and at most 3 are active per session.
export const PIX_PAYMENT_VIEW_POLICY: PaymentAccessPolicy = {
  purpose: "pix_payment_view",
  provider_id: "pp_mercadopago",
  payment_method: "pix",
  max_active_per_session: 3,
  grace_ms: 15 * 60 * 1000,
}
