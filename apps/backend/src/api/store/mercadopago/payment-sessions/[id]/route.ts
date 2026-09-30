import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

import { isCardPaymentType } from "../../../../../modules/mercadopago/service"
import { BLOCKING_CARD_ATTEMPT_STATES } from "../../../../../modules/mercadopago-card-attempt/attempt-states"
import { CARD_ATTEMPT_ERROR_CODES, cardAttemptError } from "../../../../../modules/mercadopago-card-attempt/errors"
import type MercadopagoCardAttemptModuleService from "../../../../../modules/mercadopago-card-attempt/service"
import { revokePaymentSessionAccessWorkflow } from "../../../../../workflows/payment-access/revoke-payment-session-access"

// Same identity as apps/backend/src/api/hooks/payment/[provider]/route.ts (see
// that file's comment): medusa-config.ts has no `id` for this provider, and
// service.ts identifier is "mercadopago", so the registered token is
// pp_mercadopago. Duplicated here (not imported) to keep the two routes
// independently readable and because the webhook route does not export it.
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

// Card attempts of the session (ADR-015, INV-009). The card token received
// here goes only to this module, encrypted; PaymentSession.data keeps only
// card_attempt_id.
const CARD_ATTEMPT_MODULE = "mercadopagoCardAttempt"

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

  // Extracted for the card attempt (ADR-015) and never persisted in the
  // session data.
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

  // Card type from the Payment Brick (additionalData.paymentTypeId), in the
  // Orders API's own vocabulary. Unlike the other keys, an invalid value is
  // rejected rather than dropped: silently losing it would only surface later
  // as a failed authorization.
  if ("payment_type_id" in body) {
    if (!isCardPaymentType(body.payment_type_id)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Mercado Pago: payment_type_id must be credit_card or debit_card."
      )
    }

    allowed.payment_type_id = body.payment_type_id
  }

  const payer = sanitizePayer(body.payer)
  if (payer && Object.keys(payer).length > 0) {
    allowed.payer = payer
  }

  return allowed
}

type BillingName = {
  first_name?: string
  last_name?: string
}

function getBillingName(billingAddress: { first_name?: unknown; last_name?: unknown } | null | undefined): BillingName {
  const name: BillingName = {}

  for (const key of ["first_name", "last_name"] as const) {
    const value = billingAddress?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      name[key] = value.trim()
    }
  }

  return name
}

// The payer's name on a Pix charge comes only from the cart's billing address,
// read here on the server, never from the client (sanitizePayer drops it).
// It is persisted in session.data.payer, so createPixOrder keeps building its
// body from persisted session data only: the same idempotency key always
// carries the same body, whether it is sent by the prepare route, a retry or
// authorizePix (ADR-010). Any name left in the payer of a non-Pix session is
// removed, so it never reaches a card Order.
function withPayerName(data: Record<string, unknown>, billingName: BillingName): Record<string, unknown> {
  const payer = data.payer
  if (!payer || typeof payer !== "object") {
    return data
  }

  const { first_name: _firstName, last_name: _lastName, ...rest } = payer as Record<string, unknown>

  return {
    ...data,
    payer: data.payment_method_id === "pix" ? { ...rest, ...billingName } : rest,
  }
}

async function releaseSubmittedCardAttempt(
  attempts: MercadopagoCardAttemptModuleService,
  attemptId: string
): Promise<void> {
  try {
    await attempts.replaceSubmitted(attemptId)
  } catch (error) {
    const code = (error as { code?: string })?.code
    // Not found or no longer submitted (already final): nothing to release.
    // A blocking attempt was refused above.
    if (code !== CARD_ATTEMPT_ERROR_CODES.notFound && code !== CARD_ATTEMPT_ERROR_CODES.conflict) {
      throw error
    }
  }
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
      fields: ["id", "payment_collection.id", "billing_address.first_name", "billing_address.last_name"],
      filters: { id: cartId },
    },
    { throwIfKeyNotFound: false }
  )
  const cart = data?.[0] as
    | {
        payment_collection?: { id?: string }
        billing_address?: { first_name?: unknown; last_name?: unknown } | null
      }
    | undefined
  const cartPaymentCollectionId = cart?.payment_collection?.id

  if (!cartPaymentCollectionId || cartPaymentCollectionId !== paymentSession.payment_collection_id) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Mercado Pago: payment session does not belong to the given cart."
    )
  }

  const { card_token: cardToken, ...allowedData } = buildAllowedSessionData(body)
  const attempts = req.scope.resolve<MercadopagoCardAttemptModuleService>(CARD_ATTEMPT_MODULE)

  // While a card authorization is in progress, unknown or expired, the
  // session is frozen (INV-009): no new card, no change of method or data.
  const [blocking] = (await attempts.listMercadopagoCardAttempts(
    { payment_session_id: paymentSessionId, state: [...BLOCKING_CARD_ATTEMPT_STATES] },
    { select: ["id", "state"], take: 1 }
  )) as { id: string; state: string }[]

  if (blocking) {
    throw cardAttemptError(
      blocking.state === "expired" ? CARD_ATTEMPT_ERROR_CODES.manualReview : CARD_ATTEMPT_ERROR_CODES.pending
    )
  }

  // A card_token persisted by an older version of this route never stays in
  // the session data.
  const previousData: Record<string, unknown> = { ...(paymentSession.data ?? {}) }
  delete previousData.card_token

  const becomesPix = (allowedData.payment_method_id ?? previousData.payment_method_id) === "pix"

  if (typeof cardToken === "string" && !becomesPix) {
    // A new card submission carries its own card type; a type left over from
    // an earlier card must never be reused for it (the provider then refuses
    // to authorize instead of charging with a stale type).
    if (!("payment_type_id" in allowedData)) {
      delete previousData.payment_type_id
    }

    // Rules 2 + 1: replaces a submitted attempt of the session and creates
    // the new one, the token encrypted in the attempt module only.
    const attempt = await attempts.submitAttempt({
      payment_session_id: paymentSessionId,
      cart_id: cartId,
      card_token: cardToken,
    })
    allowedData.card_attempt_id = attempt.id
  }

  const nextData = withPayerName({ ...previousData, ...allowedData }, getBillingName(cart?.billing_address))

  if (becomesPix && typeof nextData.card_attempt_id === "string") {
    // Switching to Pix releases the submitted card attempt (rule 2, token
    // destroyed). An attempt already final needs nothing.
    await releaseSubmittedCardAttempt(attempts, nextData.card_attempt_id)
    delete nextData.card_attempt_id
  }

  const updatedPaymentSession = await paymentModuleService.updatePaymentSession({
    id: paymentSessionId,
    currency_code: paymentSession.currency_code,
    amount: paymentSession.amount,
    data: nextData,
  })

  // Leaving Pix revokes the session's Pix payment capabilities (ADR-007). The
  // read route also rejects a non-Pix session, so a failed revocation is
  // logged instead of failing the update.
  const wasPix = (paymentSession.data ?? {}).payment_method_id === "pix"
  const isPix = (updatedPaymentSession.data ?? {}).payment_method_id === "pix"
  if (wasPix && !isPix) {
    try {
      await revokePaymentSessionAccessWorkflow(req.scope).run({
        input: { payment_session_id: paymentSessionId, reason: "payment_method_changed" },
      })
    } catch (error) {
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `Mercado Pago: could not revoke Pix payment capabilities of payment session ${paymentSessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
    }
  }

  res.json({
    payment_session: updatedPaymentSession,
  })
}
