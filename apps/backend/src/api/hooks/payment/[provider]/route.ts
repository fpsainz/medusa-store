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

const MERCADOPAGO_PROVIDER_PARAM = "mercadopago_mercadopago"
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago_mercadopago"

type ResolvedSession = {
  sessionId: string
  paymentCollectionId: string
  providerId: string
  status: string
}

// cart_id -> PaymentCollection -> PaymentSession, using req.scope (root container),
// never the provider's own container (confirmed isolated in prior investigation).
// Does not filter by PaymentSession status by design.
async function resolveSessionId(
  cartId: string,
  req: MedusaRequest
): Promise<ResolvedSession | null> {
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
    return null
  }

  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)

  const sessions = await paymentModuleService.listPaymentSessions({
    payment_collection_id: paymentCollectionId,
    provider_id: MERCADOPAGO_PROVIDER_ID,
  })

  if (sessions.length === 0 || sessions.length > 1) {
    return null
  }

  const session = sessions[0]

  if (!session.id || session.provider_id !== MERCADOPAGO_PROVIDER_ID) {
    return null
  }

  return {
    sessionId: session.id,
    paymentCollectionId,
    providerId: session.provider_id,
    status: session.status,
  }
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
    WebhookSignatureValidator.validate({ xSignature, xRequestId, dataId, secret })
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

  let resolved: ResolvedSession | null
  try {
    resolved = await resolveSessionId(cartId, req)
  } catch (err) {
    res.sendStatus(503)
    return
  }

  if (!resolved) {
    // external_reference present but no matching Cart/PaymentCollection/PaymentSession:
    // possible race with the synchronous checkout flow, or a local inconsistency.
    res.sendStatus(503)
    return
  }

  const payment = order.transactions?.payments?.[0]
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
