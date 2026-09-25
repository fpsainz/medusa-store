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

type ResolvedSession = {
  sessionId: string
  paymentCollectionId: string
  providerId: string
  status: string
}

type SessionResolution =
  | { kind: "matched"; session: ResolvedSession }
  | { kind: "not_found" }
  | { kind: "ambiguous" }

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
    return { kind: "not_found" }
  }

  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)

  const sessions = await paymentModuleService.listPaymentSessions(
    {
      payment_collection_id: paymentCollectionId,
      provider_id: MERCADOPAGO_PROVIDER_ID,
    },
    { select: ["id", "provider_id", "status", "data"] }
  )

  const matches = sessions.filter(
    (session) =>
      Boolean(session.id) &&
      session.provider_id === MERCADOPAGO_PROVIDER_ID &&
      (session.data as Record<string, unknown> | null | undefined)?.mercadopago_order_id ===
        mercadoPagoOrderId
  )

  if (matches.length === 0) {
    return { kind: "not_found" }
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

  const cartId = order.external_reference
  if (!cartId) {
    // Order not tied to a cart from this flow's checkout: ack, do not process.
    res.sendStatus(200)
    return
  }

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

  if (resolution.kind === "not_found") {
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

  const resolved = resolution.session
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
