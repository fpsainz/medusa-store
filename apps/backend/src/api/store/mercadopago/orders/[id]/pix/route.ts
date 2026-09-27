import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

// Same identity as the other Mercado Pago routes (see the webhook route's
// own comment): medusa-config.ts has no `id` for this provider, and
// service.ts identifier is "mercadopago", so the registered token is
// pp_mercadopago.
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

type MercadoPagoPaymentSession = {
  id?: string
  provider_id?: string
  status?: string
  data?: Record<string, unknown> | null
}

type MercadoPagoPaymentCollection = {
  payment_sessions?: MercadoPagoPaymentSession[] | null
}

type PixDto = {
  status: string
  ticket_url?: string
}

function getStringField(data: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = data?.[key]
  return typeof value === "string" ? value : undefined
}

// The order page (PaymentDetails) is the only consumer, and it only reports
// the outcome: it needs the session's status (awaiting vs `authorized`) and
// the ticket link it offers while awaiting. The route is reachable with the
// order id alone (guest orders), so nothing else is returned: no QR code or
// copy-paste payload (shown only on the Review, via carts/:id/pix), no
// expiration, no `session.data`, payer, identification, idempotency key or
// Mercado Pago internal id.
function toPixDto(session: MercadoPagoPaymentSession): PixDto {
  return {
    status: session.status ?? "pending",
    ticket_url: getStringField(session.data, "mercadopago_pix_ticket_url"),
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph(
    {
      entity: "order",
      fields: [
        "id",
        "payment_collections.payment_sessions.id",
        "payment_collections.payment_sessions.provider_id",
        "payment_collections.payment_sessions.status",
        "payment_collections.payment_sessions.data",
      ],
      filters: { id: orderId },
    },
    { throwIfKeyNotFound: false }
  )

  const order = data?.[0] as
    | { payment_collections?: MercadoPagoPaymentCollection[] | null }
    | undefined

  const mercadoPagoSession = order?.payment_collections
    ?.flatMap((collection) => collection.payment_sessions ?? [])
    .find(
      (session) =>
        session.provider_id === MERCADOPAGO_PROVIDER_ID &&
        session.data?.payment_method_id === "pix"
    )

  if (!mercadoPagoSession) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "Mercado Pago: no Pix payment session found for this order."
    )
  }

  // The Pix status changes asynchronously via webhook, independent of any
  // page render, so this response must never be cached by an intermediary
  // or the browser.
  res.setHeader("Cache-Control", "no-store")
  res.json(toPixDto(mercadoPagoSession))
}
