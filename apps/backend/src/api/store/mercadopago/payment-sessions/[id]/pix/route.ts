import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

import { toPixPaymentDto } from "../../../../../../modules/mercadopago/service"
import { attachPixPaymentAccess } from "../../../../../utils/pix-payment-access"

// Same identity as the other Mercado Pago routes (see the webhook route's
// own comment): the registered provider token is pp_mercadopago.
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

type CartWithPaymentCollection = {
  id: string
  completed_at?: string | Date | null
  payment_collection?: { id?: string } | null
}

// Prepares (creates or reuses) the Mercado Pago Pix charge of a Payment
// Session while the buyer is on the checkout Review step, so the real QR
// exists before "Place order". The charge itself is created by the provider
// (service.ts updatePayment) through the Payment Module — this route never
// talks to Mercado Pago, never authorizes the session and never completes
// the cart. Calling it again for the same session is idempotent.
//
// Each call also issues a read-only Pix payment capability (ADR-007), sent in
// response headers for the storefront server only; the body never carries it.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const paymentSessionId = req.params.id
  const body = (req.body ?? {}) as Record<string, unknown>

  const cartId = typeof body.cart_id === "string" ? body.cart_id : undefined
  if (!cartId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Mercado Pago: cart_id is required to prepare the Pix payment."
    )
  }

  const regenerate = body.regenerate === true

  const paymentSession = await paymentModuleService.retrievePaymentSession(paymentSessionId, {
    select: ["id", "data", "provider_id", "amount", "currency_code", "payment_collection_id", "status"],
  })

  if (paymentSession.provider_id !== MERCADOPAGO_PROVIDER_ID) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Mercado Pago: payment session does not belong to the Mercado Pago provider."
    )
  }

  // Ownership: the session must belong to the cart the caller names, through
  // the cart's own payment collection (same rule as the session update route).
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph(
    {
      entity: "cart",
      fields: ["id", "completed_at", "payment_collection.id"],
      filters: { id: cartId },
    },
    { throwIfKeyNotFound: false }
  )
  const cart = data?.[0] as CartWithPaymentCollection | undefined
  const cartPaymentCollectionId = cart?.payment_collection?.id

  if (!cartPaymentCollectionId || cartPaymentCollectionId !== paymentSession.payment_collection_id) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Mercado Pago: payment session does not belong to the given cart."
    )
  }

  if (cart?.completed_at) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Mercado Pago: the cart is already completed."
    )
  }

  const sessionData = (paymentSession.data ?? {}) as Record<string, unknown>
  if (sessionData.payment_method_id !== "pix") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Mercado Pago: the payment session is not a Pix payment."
    )
  }

  res.setHeader("Cache-Control", "no-store")

  // Already authorized by Medusa (webhook arrived before "Place order"):
  // nothing to prepare, and a paid charge must never be replaced.
  if (paymentSession.status === "authorized") {
    await attachPixPaymentAccess(req, res, { cart_id: cartId, payment_session_id: paymentSessionId })
    res.json(toPixPaymentDto(paymentSession))
    return
  }

  const updatedPaymentSession = await paymentModuleService.updatePaymentSession({
    id: paymentSessionId,
    currency_code: paymentSession.currency_code,
    amount: paymentSession.amount,
    data: {
      ...sessionData,
      mercadopago_pix_action: regenerate ? "regenerate" : "prepare",
    },
  })

  await attachPixPaymentAccess(req, res, { cart_id: cartId, payment_session_id: paymentSessionId })
  res.json(toPixPaymentDto(updatedPaymentSession))
}
