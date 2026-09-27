import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

// The only session.data field the storefront reads from the generic Store API:
// the Review step detects a Pix session by payment_method_id === "pix". Every
// other Pix field reaches the storefront through the dedicated DTO routes
// (/store/mercadopago/carts/:id/pix, the prepare route, and
// /store/mercadopago/payment-access/pix).
const PUBLIC_DATA_FIELDS = ["payment_method_id"] as const

// Relations whose rows carry the provider's raw data: a Payment Session, and
// the Payment Medusa creates from it (it stores a copy of the same data).
const PROVIDER_DATA_RELATIONS = new Set(["payment_sessions", "payments"])

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// A row belongs to Mercado Pago when its provider_id says so. A caller can
// request `data` without `provider_id` (?fields=...payment_sessions.data), so
// rows without provider_id are recognized by the provider's own keys, which
// initiatePayment writes on every Mercado Pago session.
function isMercadoPagoRow(row: PlainObject): boolean {
  if (typeof row.provider_id === "string") {
    return row.provider_id === MERCADOPAGO_PROVIDER_ID
  }
  return (
    isPlainObject(row.data) &&
    Object.keys(row.data).some((key) => key.startsWith("mercadopago_"))
  )
}

export function toPublicMercadoPagoData(data: unknown): PlainObject {
  const publicData: PlainObject = {}
  if (!isPlainObject(data)) {
    return publicData
  }
  for (const field of PUBLIC_DATA_FIELDS) {
    if (typeof data[field] === "string") {
      publicData[field] = data[field]
    }
  }
  return publicData
}

function redactRow(row: unknown): unknown {
  if (!isPlainObject(row) || !("data" in row) || !isMercadoPagoRow(row)) {
    return redactMercadoPagoProviderData(row)
  }
  return {
    ...(redactMercadoPagoProviderData(row) as PlainObject),
    data: toPublicMercadoPagoData(row.data),
  }
}

// Returns a copy of a Store API response body in which every Mercado Pago
// payment_sessions[].data / payments[].data, at any depth, is reduced to the
// public fields. Only plain objects and arrays are rebuilt; other values
// (dates, BigNumber, ...) are returned as they are. Other providers' rows are
// untouched. Nothing is written back: this only shapes the HTTP response.
export function redactMercadoPagoProviderData(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => redactMercadoPagoProviderData(item))
  }
  if (!isPlainObject(body)) {
    return body
  }

  const redacted: PlainObject = {}
  for (const [key, value] of Object.entries(body)) {
    redacted[key] =
      PROVIDER_DATA_RELATIONS.has(key) && Array.isArray(value)
        ? value.map(redactRow)
        : redactMercadoPagoProviderData(value)
  }
  return redacted
}

// Store API middleware: the core routes expand payment sessions with all their
// columns (`*payment_collection.payment_sessions`) and accept `?fields=`, so
// the provider's data cannot be excluded at query level. The response is
// shaped instead, keeping the same access model (guest checkout included).
export function redactMercadoPagoDataMiddleware(
  _req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const json = res.json.bind(res)
  res.json = ((body: unknown) =>
    json(redactMercadoPagoProviderData(body))) as MedusaResponse["json"]
  next()
}
