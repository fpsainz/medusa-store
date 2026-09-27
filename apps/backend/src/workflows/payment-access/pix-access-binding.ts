import { hasPixOrderData } from "../../modules/mercadopago/service"
import { PIX_PAYMENT_VIEW_POLICY, type PaymentAccessPolicy } from "../../modules/payment-access/policies"

export type PixAccessCart = {
  id: string
  completed_at?: string | Date | null
  payment_collection?: { id?: string } | null
}

export type PixAccessSession = {
  id: string
  provider_id?: string
  payment_collection_id?: string
  data?: Record<string, unknown> | null
}

export type PixAccessBinding = {
  payment_session_id: string
  payment_collection_id: string
  cart_id: string
  expires_at: string
}

// Decides whether a Pix payment capability may be issued and what it is bound
// to. Issuance is authorized by holding the cart id while the cart is open
// (the same rule as the prepare route); the backend cannot tell the
// storefront server from any other caller, so nothing else is assumed.
// Returns null (no capability) whenever any condition fails:
//   - the cart exists and has no completed_at;
//   - the session belongs to the cart's own payment collection;
//   - the session is Mercado Pago and Pix, with a Pix charge attached;
//   - the charge has a stored deadline (charges created before the explicit
//     expiration_time have none, so no expiry could be derived);
//   - deadline + grace is still in the future.
// The capability expires at deadline + grace, with no other cap (ADR-007).
export function resolvePixAccessBinding(input: {
  cart?: PixAccessCart | null
  session?: PixAccessSession | null
  now: Date
  policy?: PaymentAccessPolicy
}): PixAccessBinding | null {
  const { cart, session, now } = input
  const policy = input.policy ?? PIX_PAYMENT_VIEW_POLICY

  if (!cart || cart.completed_at || !session) {
    return null
  }

  const collectionId = cart.payment_collection?.id
  if (!collectionId || collectionId !== session.payment_collection_id) {
    return null
  }

  const data = session.data ?? {}
  if (
    session.provider_id !== policy.provider_id ||
    data.payment_method_id !== policy.payment_method ||
    !hasPixOrderData(data)
  ) {
    return null
  }

  const deadline =
    typeof data.mercadopago_pix_expires_at === "string"
      ? Date.parse(data.mercadopago_pix_expires_at)
      : NaN
  if (!Number.isFinite(deadline)) {
    return null
  }

  const expiresAt = deadline + policy.grace_ms
  if (expiresAt <= now.getTime()) {
    return null
  }

  return {
    payment_session_id: session.id,
    payment_collection_id: collectionId,
    cart_id: cart.id,
    expires_at: new Date(expiresAt).toISOString(),
  }
}
