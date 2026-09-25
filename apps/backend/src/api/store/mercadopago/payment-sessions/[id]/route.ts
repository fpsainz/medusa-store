import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

// Same identity as apps/backend/src/api/hooks/payment/[provider]/route.ts (see
// that file's comment): medusa-config.ts has no `id` for this provider, and
// service.ts identifier is "mercadopago", so the registered token is
// pp_mercadopago. Duplicated here (not imported) to keep the two routes
// independently readable and because the webhook route does not export it.
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

type Identification = {
  type?: unknown
  number?: unknown
}

type SanitizedPayer = {
  email?: string
  identification?: {
    type?: string
    number?: string
  }
}

// Everything this route accepts from the client, and nothing else. In
// particular, no `mercadopago_*` field, no `status`, no `qr_code*`, no
// `ticket_url`, no expiration field and no idempotency key: those are all
// written exclusively by the provider (service.ts), from data the provider
// itself obtained from Mercado Pago. Accepting any of them from the client
// would let a request forge a session into pointing at an arbitrary Mercado
// Pago Order (see the audit's D4 finding).
function sanitizePayer(payer: unknown): SanitizedPayer | undefined {
  if (!payer || typeof payer !== "object") {
    return undefined
  }

  const candidate = payer as { email?: unknown; identification?: unknown }
  const identification = candidate.identification as Identification | undefined

  const sanitized: SanitizedPayer = {}

  if (typeof candidate.email === "string") {
    sanitized.email = candidate.email
  }

  if (identification && typeof identification === "object") {
    const sanitizedIdentification: SanitizedPayer["identification"] = {}

    if (typeof identification.type === "string") {
      sanitizedIdentification.type = identification.type
    }

    if (typeof identification.number === "string") {
      sanitizedIdentification.number = identification.number
    }

    if (Object.keys(sanitizedIdentification).length > 0) {
      sanitized.identification = sanitizedIdentification
    }
  }

  return sanitized
}

// Builds the data object actually merged into the Payment Session, keeping
// only fields the storefront legitimately needs to send: the Payment Brick's
// tokenized card data (card path) or the Pix method selection (Pix path),
// plus the amount/currency/cart_id the session update already carried before
// this fix. Any other key in `body` — most importantly anything the
// provider itself would otherwise write (`mercadopago_*`, `status`,
// `qr_code`, `qr_code_base64`, `ticket_url`, expiration fields, the
// idempotency key) — is dropped, never merged in.
function buildAllowedSessionData(body: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {}

  if (typeof body.card_token === "string") {
    allowed.card_token = body.card_token
  }

  if (typeof body.payment_method_id === "string") {
    allowed.payment_method_id = body.payment_method_id
  }

  if (typeof body.issuer_id === "string") {
    allowed.issuer_id = body.issuer_id
  }

  if (typeof body.installments === "number") {
    allowed.installments = body.installments
  }

  if (typeof body.transaction_amount === "number") {
    allowed.transaction_amount = body.transaction_amount
  }

  if (typeof body.amount === "number") {
    allowed.amount = body.amount
  }

  if (typeof body.currency_code === "string") {
    allowed.currency_code = body.currency_code
  }

  if (typeof body.cart_id === "string") {
    allowed.cart_id = body.cart_id
  }

  const payer = sanitizePayer(body.payer)
  if (payer && Object.keys(payer).length > 0) {
    allowed.payer = payer
  }

  return allowed
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const paymentSessionId = req.params.id
  const body = (req.body ?? {}) as Record<string, unknown>

  const cartId = typeof body.cart_id === "string" ? body.cart_id : undefined
  if (!cartId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Mercado Pago: cart_id is required to update the payment session."
    )
  }

  const paymentSession = await paymentModuleService.retrievePaymentSession(paymentSessionId, {
    select: ["id", "data", "provider_id", "amount", "currency_code", "payment_collection_id"],
  })

  if (paymentSession.provider_id !== MERCADOPAGO_PROVIDER_ID) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Mercado Pago: payment session does not belong to the Mercado Pago provider."
    )
  }

  // Ownership check: the payment session named in the URL must actually
  // belong to the cart the caller claims to be updating, via the cart's own
  // payment_collection. Without this, a caller could target any payment
  // session id it can guess/enumerate, regardless of which cart it owns.
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph(
    {
      entity: "cart",
      fields: ["id", "payment_collection.id"],
      filters: { id: cartId },
    },
    { throwIfKeyNotFound: false }
  )
  const cart = data?.[0] as { payment_collection?: { id?: string } } | undefined
  const cartPaymentCollectionId = cart?.payment_collection?.id

  if (!cartPaymentCollectionId || cartPaymentCollectionId !== paymentSession.payment_collection_id) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Mercado Pago: payment session does not belong to the given cart."
    )
  }

  const allowedData = buildAllowedSessionData(body)

  const updatedPaymentSession = await paymentModuleService.updatePaymentSession({
    id: paymentSessionId,
    currency_code: paymentSession.currency_code,
    amount: paymentSession.amount,
    data: {
      ...paymentSession.data,
      ...allowedData,
    },
  })

  res.json({
    payment_session: updatedPaymentSession,
  })
}
