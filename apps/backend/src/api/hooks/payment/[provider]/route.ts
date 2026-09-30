import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"
import {
  InvalidWebhookSignatureError,
  MercadoPagoConfig,
  Order,
  WebhookSignatureValidator,
} from "mercadopago"

// Public URL segment (/hooks/payment/mercadopago). Also the internal provider
// identifier emitted on the event — the two are the same value by design, so
// there is no public/internal translation to keep in sync. The registered
// provider token (medusa-config.ts has no `id`, service.ts identifier is
// "mercadopago") is pp_mercadopago.
const MERCADOPAGO_PROVIDER_PARAM = "mercadopago"
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

// Card attempts (ADR-015, INV-009): only reached when no session holds the
// notified Order.
const CARD_ATTEMPT_MODULE = "mercadopagoCardAttempt"

type ResolvedSession = {
  sessionId: string
  paymentCollectionId: string
  providerId: string
  status: string
}

type CartSession = {
  id: string
  provider_id: string
  amount?: unknown
  data?: Record<string, unknown> | null
}

type SessionResolution =
  | { kind: "matched"; session: ResolvedSession }
  | { kind: "not_found"; sessions: CartSession[] }
  | { kind: "ambiguous" }

type OrderReference = { cartId: string; attemptReference?: string }

// external_reference is either the cart id (Pix, and card Orders created
// before ADR-015) or `<cart_id>-<attempt ULID>` (card attempts). Cart ids
// never contain "-". Anything else is taken as a plain cart id, which keeps
// the previous behavior (no session found → 503 if paid, 200 otherwise).
function parseOrderReference(externalReference: string): OrderReference {
  const match = /^([A-Za-z0-9_]{1,37})-([0-9A-Z]{26})$/.exec(externalReference)
  return match ? { cartId: match[1], attemptReference: externalReference } : { cartId: externalReference }
}

// Finds the Payment Session that owns this exact Mercado Pago Order.
//
// The Order's external_reference (written by the provider, returned by the
// authenticated GET /v1/orders/{id}) only narrows the search to that cart's
// payment collection. The session is then selected strictly by
// data.mercadopago_order_id === the notified Order id — never "the cart's
// Mercado Pago session" in general. So a notification for an old/replaced
// Order A can never reach the session that now holds Order B.
//
// Uses req.scope (root container), never the provider's own container.
// Does not filter by PaymentSession status by design.
async function resolveSessionForOrder(
  mercadoPagoOrderId: string,
  cartId: string,
  req: MedusaRequest
): Promise<SessionResolution> {
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

  const paymentCollectionId = cart?.payment_collection?.id
  if (!paymentCollectionId) {
    return { kind: "not_found", sessions: [] }
  }

  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)

  const sessions = await paymentModuleService.listPaymentSessions(
    {
      payment_collection_id: paymentCollectionId,
      provider_id: MERCADOPAGO_PROVIDER_ID,
    },
    { select: ["id", "provider_id", "status", "amount", "data"] }
  )

  const matches = sessions.filter(
    (session) =>
      Boolean(session.id) &&
      session.provider_id === MERCADOPAGO_PROVIDER_ID &&
      (session.data as Record<string, unknown> | null | undefined)?.mercadopago_order_id ===
        mercadoPagoOrderId
  )

  if (matches.length === 0) {
    return {
      kind: "not_found",
      sessions: sessions.filter((session) => session.provider_id === MERCADOPAGO_PROVIDER_ID) as CartSession[],
    }
  }

  if (matches.length > 1) {
    return { kind: "ambiguous" }
  }

  const session = matches[0]

  return {
    kind: "matched",
    session: {
      sessionId: session.id,
      paymentCollectionId,
      providerId: session.provider_id,
      status: session.status,
    },
  }
}

// Paid from Mercado Pago's point of view (same states the provider maps to
// captured/authorized).
function isPaidOrder(orderStatus?: string, paymentStatus?: string): boolean {
  const paid = new Set(["processed", "approved", "authorized"])
  return paid.has(orderStatus?.toLowerCase() ?? "") || paid.has(paymentStatus?.toLowerCase() ?? "")
}

// Declined or canceled from Mercado Pago's point of view: the card attempt
// holding this Order can end as failed (INV-009, rule 9).
function isFailedOrder(orderStatus?: string, paymentStatus?: string): boolean {
  const failedOrder = new Set(["failed", "canceled", "cancelled", "expired"])
  const failedPayment = new Set(["failed", "rejected", "canceled", "cancelled"])
  return failedOrder.has(orderStatus?.toLowerCase() ?? "") || failedPayment.has(paymentStatus?.toLowerCase() ?? "")
}

const sameAmount = (a: unknown, b: unknown) =>
  Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a).toFixed(2) === Number(b).toFixed(2)

type CardAttemptRow = {
  id: string
  state: string
  payment_session_id: string
  cart_id: string
  mercadopago_order_id: string | null
}

type CardAttemptService = {
  listMercadopagoCardAttempts(filters: Record<string, unknown>, config: Record<string, unknown>): Promise<unknown[]>
  recordOrder(attemptId: string, mercadopagoOrderId: string): Promise<boolean>
  failUnknown(attemptId: string, mercadopagoOrderId: string): Promise<unknown>
}

type AttemptFallback =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "rejected"; reason: string }
  | { kind: "matched"; attempt: CardAttemptRow; session: CartSession }

// Fallback of INV-009 (ADR-015, decision 7), only when no session holds the
// notified Order: the attempt whose external_reference is exactly the
// Order's (unique index), bound to a Mercado Pago session of the same cart
// that still points to it, open (authorizing/unknown), without another
// Order, and with the same amount. Never picks among candidates.
async function resolveCardAttemptFallback(
  dataId: string,
  cartId: string,
  attemptReference: string,
  sessions: CartSession[],
  orderAmount: unknown,
  cardAttempts: CardAttemptService
): Promise<AttemptFallback> {
  const found = (await cardAttempts.listMercadopagoCardAttempts(
    { external_reference: attemptReference },
    { select: ["id", "state", "payment_session_id", "cart_id", "mercadopago_order_id"], take: 2 }
  )) as CardAttemptRow[]

  if (found.length === 0) {
    return { kind: "none" }
  }

  if (found.length > 1) {
    return { kind: "ambiguous" }
  }

  const attempt = found[0]
  const session = sessions.find((candidate) => candidate.id === attempt.payment_session_id)
  const sessionOrderId = session?.data?.mercadopago_order_id

  if (attempt.cart_id !== cartId || !session || session.provider_id !== MERCADOPAGO_PROVIDER_ID) {
    return { kind: "rejected", reason: "attempt not bound to a Mercado Pago session of this cart" }
  }

  if (session.data?.card_attempt_id !== attempt.id) {
    return { kind: "rejected", reason: "session no longer points to the attempt" }
  }

  if (attempt.state !== "authorizing" && attempt.state !== "unknown") {
    return { kind: "rejected", reason: `attempt is ${attempt.state}` }
  }

  if ((attempt.mercadopago_order_id && attempt.mercadopago_order_id !== dataId) || (sessionOrderId && sessionOrderId !== dataId)) {
    return { kind: "rejected", reason: "attempt or session already holds another order" }
  }

  if (!sameAmount(orderAmount, session.amount)) {
    return { kind: "rejected", reason: "amount differs from the session" }
  }

  return { kind: "matched", attempt, session }
}

function getSingleQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 && typeof value[0] === "string" ? value[0] : undefined
  }
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function getSingleHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined
  }
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isValidDecimalAmount(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { provider } = req.params

  const options =
    // @ts-expect-error "Not sure if .options exists on a module"
    req.scope.resolve(Modules.PAYMENT).options || {}
  const delay = options.webhook_delay || 5000
  const attempts = options.webhook_retries || 3
  const eventBus = req.scope.resolve(Modules.EVENT_BUS)

  // Any provider other than Mercado Pago gets exactly the core behavior,
  // unmodified: no HMAC, no correlation, no extra payload fields.
  if (provider !== MERCADOPAGO_PROVIDER_PARAM) {
    try {
      await eventBus.emit(
        {
          name: PaymentWebhookEvents.WebhookReceived,
          data: {
            provider,
            payload: { data: req.body, rawData: req.rawBody, headers: req.headers },
          },
        },
        { delay, attempts }
      )
    } catch (err) {
      res.status(400).send(`Webhook Error: ${(err as Error).message}`)
      return
    }
    res.sendStatus(200)
    return
  }

  const dataId = getSingleQueryValue(
    (req.query as Record<string, unknown> | undefined)?.["data.id"]
  )
  if (!dataId) {
    res.sendStatus(400)
    return
  }

  const xSignature = getSingleHeaderValue(req.headers["x-signature"])
  const xRequestId = getSingleHeaderValue(req.headers["x-request-id"])
  if (!xSignature || !xRequestId) {
    res.sendStatus(400)
    return
  }

  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET
  if (!secret) {
    res.sendStatus(500)
    return
  }

  try {
    // The generic mercadopago/sdk-nodejs 3.6.1 validator no longer lowercases
    // dataId internally (it preserves whatever case the caller passes it).
    // That default is correct for traditional Payments notifications, but
    // the Orders API's own notifications documentation still explicitly
    // requires an alphanumeric data.id to be lowercased before it's used in
    // the HMAC manifest — confirmed by two real Orders webhooks from the
    // test application, whose received signature only matched the lowercase
    // variant of their data.id. So we lowercase only the value handed to the
    // validator; every other use of dataId below (Order.get(), correlation,
    // the event payload) keeps the original case as received.
    WebhookSignatureValidator.validate({
      xSignature,
      xRequestId,
      dataId: dataId.toLowerCase(),
      secret,
    })
  } catch (err) {
    if (err instanceof InvalidWebhookSignatureError) {
      res.sendStatus(401)
      return
    }
    res.sendStatus(500)
    return
  }

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!accessToken) {
    res.sendStatus(500)
    return
  }

  let order: Awaited<ReturnType<Order["get"]>>
  try {
    const mpClient = new MercadoPagoConfig({ accessToken })
    const orderClient = new Order(mpClient)
    order = await orderClient.get({ id: dataId })
  } catch (err) {
    res.sendStatus(502)
    return
  }

  if (!order.external_reference) {
    // Order not tied to a cart from this flow's checkout: ack, do not process.
    res.sendStatus(200)
    return
  }

  const { cartId, attemptReference } = parseOrderReference(order.external_reference)

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const payment = order.transactions?.payments?.[0]

  let resolution: SessionResolution
  try {
    resolution = await resolveSessionForOrder(dataId, cartId, req)
  } catch (err) {
    res.sendStatus(503)
    return
  }

  if (resolution.kind === "ambiguous") {
    // More than one session claims the same Mercado Pago Order: never guess.
    logger.error(
      `Mercado Pago webhook: order ${dataId} is attached to more than one payment session of cart ${cartId}; not processed`
    )
    res.sendStatus(503)
    return
  }

  let resolved: ResolvedSession | undefined =
    resolution.kind === "matched" ? resolution.session : undefined

  // No session holds this Order: a card attempt's Order whose POST response
  // was lost is found through its external_reference (INV-009). The current
  // correlation above always wins when it finds a session.
  if (resolution.kind === "not_found" && attemptReference) {
    let fallback: AttemptFallback
    let cardAttempts: CardAttemptService
    try {
      cardAttempts = req.scope.resolve(CARD_ATTEMPT_MODULE) as CardAttemptService
      fallback = await resolveCardAttemptFallback(
        dataId,
        cartId,
        attemptReference,
        resolution.sessions,
        order.total_amount ?? payment?.amount,
        cardAttempts
      )
    } catch (err) {
      res.sendStatus(503)
      return
    }

    if (fallback.kind === "ambiguous") {
      logger.error(
        `Mercado Pago webhook: order ${dataId} matches more than one card attempt of cart ${cartId}; not processed`
      )
      res.sendStatus(503)
      return
    }

    if (fallback.kind === "rejected") {
      if (isPaidOrder(order.status, payment?.status)) {
        // A paid Order that cannot be tied to its attempt safely (e.g. a
        // second Order of the same attempt): manual reconciliation.
        logger.error(
          `Mercado Pago webhook: paid order ${dataId} (cart ${cartId}) not associated with its card attempt (${fallback.reason}); responding 503`
        )
        res.sendStatus(503)
        return
      }

      logger.warn(
        `Mercado Pago webhook: order ${dataId} (cart ${cartId}) not associated with its card attempt (${fallback.reason}); acknowledged without processing`
      )
      res.sendStatus(200)
      return
    }

    if (fallback.kind === "matched") {
      const { attempt, session } = fallback

      try {
        if (!attempt.mercadopago_order_id) {
          await cardAttempts.recordOrder(attempt.id, dataId)
        }

        // Rule 9 belongs to the webhook: the Order of an unknown attempt was
        // declined or canceled. An attempt still authorizing is settled by
        // the provider call in flight.
        if (attempt.state === "unknown" && isFailedOrder(order.status, payment?.status)) {
          await cardAttempts.failUnknown(attempt.id, dataId)
        }
      } catch (err) {
        res.sendStatus(503)
        return
      }

      if (!isPaidOrder(order.status, payment?.status)) {
        logger.info(
          `Mercado Pago webhook: order ${dataId} (status ${order.status ?? "unknown"}) recorded on card attempt ${attempt.id}; nothing to process`
        )
        res.sendStatus(200)
        return
      }

      // Paid: the event reaches processPaymentWorkflow, whose provider call
      // reads this Order (GET, no POST) and applies rule 12 (unknown →
      // resolved) or rule 6 (authorizing → resolved).
      logger.info(
        `Mercado Pago webhook: paid order ${dataId} associated with card attempt ${attempt.id} of session ${session.id}`
      )
      resolved = {
        sessionId: session.id,
        paymentCollectionId: "",
        providerId: session.provider_id,
        status: "",
      }
    }
  }

  if (!resolved) {
    if (isPaidOrder(order.status, payment?.status)) {
      // A paid Order no session holds (yet): either the session has not
      // persisted this Order id (e.g. card authorization still inside
      // completeCart) — Mercado Pago retries — or a paid charge detached
      // from any session, which needs manual review.
      logger.warn(
        `Mercado Pago webhook: paid order ${dataId} (cart ${cartId}) has no payment session holding it; responding 503 for retry`
      )
      res.sendStatus(503)
      return
    }

    // Not paid (old/replaced/cancelled/expired charge, or one never attached):
    // nothing to process, and never attached to another session.
    logger.info(
      `Mercado Pago webhook: order ${dataId} (status ${order.status ?? "unknown"}) is not held by any payment session of cart ${cartId}; acknowledged without processing`
    )
    res.sendStatus(200)
    return
  }

  const rawAmount = payment?.paid_amount ?? payment?.amount

  try {
    await eventBus.emit(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider,
          payload: {
            data: req.body,
            rawData: req.rawBody,
            headers: req.headers,
            dataId,
            sessionId: resolved.sessionId,
            orderStatus: order.status,
            orderStatusDetail: order.status_detail,
            paymentStatus: payment?.status,
            paymentStatusDetail: payment?.status_detail,
            amount: isValidDecimalAmount(rawAmount) ? rawAmount : undefined,
          },
        },
      },
      { delay, attempts }
    )
  } catch (err) {
    res.status(400).send(`Webhook Error: ${(err as Error).message}`)
    return
  }

  res.sendStatus(200)
}
