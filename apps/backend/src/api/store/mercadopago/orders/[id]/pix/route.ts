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
  qr_code?: string
  qr_code_base64?: string
  ticket_url?: string
  expires_at?: string
}

function getStringField(data: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = data?.[key]
  return typeof value === "string" ? value : undefined
}

// This is the only surface the storefront's Pix UI is allowed to read. It
// intentionally does not return the payment session itself, `session.data`
// wholesale, the payer, any document/identification, the idempotency key,
// or any other Mercado Pago internal id: only the four Pix-specific fields
// the client needs to render the QR/copy-paste/ticket link, plus the
// session's own status (so the client knows when it flips to `authorized`).
function toPixDto(session: MercadoPagoPaymentSession): PixDto {
  const data = session.data ?? undefined

  return {
    status: session.status ?? "pending",
    qr_code: getStringField(data, "mercadopago_pix_qr_code"),
    qr_code_base64: getStringField(data, "mercadopago_pix_qr_code_base64"),
    ticket_url: getStringField(data, "mercadopago_pix_ticket_url"),
    expires_at:
      getStringField(data, "mercadopago_pix_date_of_expiration") ??
      getStringField(data, "mercadopago_pix_expiration_time"),
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
    .find((session) => session.provider_id === MERCADOPAGO_PROVIDER_ID)

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
