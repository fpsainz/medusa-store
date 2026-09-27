// What may cross from the storefront server to the browser about a Pix
// payment, and how the storefront server reads the payment capability
// (ADR-007) issued by the backend. Pure and dependency-free so the boundary
// can be tested with `node --test` (see package.json "test").

export const PIX_CHARGE_STATUSES = [
  "processing",
  "pending",
  "approved",
  "expired",
  "canceled",
  "failed",
  "rejected",
  "refunded",
  "charged_back",
  "unknown",
] as const

export type PixChargeStatus = (typeof PIX_CHARGE_STATUSES)[number]

// charge_ref is an opaque reference of the current charge (changes when the
// charge is regenerated); it is not a Mercado Pago id.
export type PixCharge = {
  status: PixChargeStatus
  charge_ref?: string
  qr_code?: string
  qr_code_base64?: string
  ticket_url?: string
  expires_at?: string
}

const CLIENT_STRING_FIELDS = ["charge_ref", "qr_code", "qr_code_base64", "ticket_url", "expires_at"] as const

// Explicit allowlist of what a Client Component receives, whatever the
// backend body contains: anything else (a capability token, order_id, ids)
// is dropped here.
export function toClientPixCharge(body: unknown): PixCharge {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const status = PIX_CHARGE_STATUSES.includes(source.status as PixChargeStatus)
    ? (source.status as PixChargeStatus)
    : "unknown"

  const charge: PixCharge = { status }
  for (const field of CLIENT_STRING_FIELDS) {
    const value = source[field]
    if (typeof value === "string") {
      charge[field] = value
    }
  }

  return charge
}

export const PAYMENT_ACCESS_TOKEN_HEADER = "x-payment-access-token"
export const PAYMENT_ACCESS_EXPIRES_AT_HEADER = "x-payment-access-expires-at"

const PAYMENT_ACCESS_TOKEN_PATTERN = /^pat_[A-Za-z0-9_-]{43}$/

export type IssuedPaymentAccess = {
  token: string
  expiresAt: Date
}

// Reads the capability the backend returns in response headers on Pix
// preparation. Anything malformed or already expired is ignored.
export function readIssuedPaymentAccess(
  headers: Pick<Headers, "get">,
  now: Date = new Date()
): IssuedPaymentAccess | null {
  const token = headers.get(PAYMENT_ACCESS_TOKEN_HEADER)
  const expiresAt = new Date(headers.get(PAYMENT_ACCESS_EXPIRES_AT_HEADER) ?? "")

  if (
    !token ||
    !PAYMENT_ACCESS_TOKEN_PATTERN.test(token) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  ) {
    return null
  }

  return { token, expiresAt }
}

// The backend view read with the capability. order_id stays on the server:
// it is only compared with the order of the page.
export function splitPixAccessView(body: unknown): { orderId: string | null; charge: PixCharge } {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {}

  return {
    orderId: typeof source.order_id === "string" ? source.order_id : null,
    charge: toClientPixCharge(body),
  }
}
