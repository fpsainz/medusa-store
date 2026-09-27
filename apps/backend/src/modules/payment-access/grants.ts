import { createHash, randomBytes } from "crypto"

// Purposes a payment capability can be issued for. Each one is read-only and
// scoped to a single payment; none authorizes any mutation.
export const PAYMENT_ACCESS_PURPOSES = ["pix_payment_view"] as const
export type PaymentAccessPurpose = (typeof PAYMENT_ACCESS_PURPOSES)[number]

// Opaque token: a recognizable prefix (so it can be spotted and filtered in
// logs) + 256 random bits as base64url. Never a JWT: nothing is encoded in it.
export const PAYMENT_ACCESS_TOKEN_PREFIX = "pat_"
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^pat_[A-Za-z0-9_-]{43}$/

export function generatePaymentAccessToken(): string {
  return `${PAYMENT_ACCESS_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`
}

// A fast hash is enough: the token carries 256 bits of entropy, so there is
// nothing to brute-force. Only this hash is ever persisted.
export function hashPaymentAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function isWellFormedPaymentAccessToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value)
}

export type PaymentAccessGrantRecord = {
  id: string
  token_hash: string
  purpose: string
  provider_id: string
  payment_method: string
  payment_session_id: string
  payment_collection_id: string
  cart_id: string
  expires_at: Date | string
  revoked_at?: Date | string | null
  revoked_reason?: string | null
  created_at?: Date | string
}

function toTime(value: Date | string | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

// A grant is usable only for its own purpose, while not revoked and strictly
// before expires_at. Anything unparsable is treated as unusable.
export function isGrantUsable(
  grant: PaymentAccessGrantRecord,
  purpose: PaymentAccessPurpose,
  now: Date
): boolean {
  if (grant.purpose !== purpose) {
    return false
  }

  if (grant.revoked_at !== null && grant.revoked_at !== undefined) {
    return false
  }

  const expiresAt = toTime(grant.expires_at)
  return expiresAt !== undefined && now.getTime() < expiresAt
}

// Active grants beyond the newest `maxActive` (newest first by created_at,
// then id as a stable tie-breaker). Revoking these after every issuance keeps
// the count bounded even when issuances race: each call trims to the same
// newest set, so the result converges without a lock.
export function selectGrantsToSupersede(
  activeGrants: PaymentAccessGrantRecord[],
  maxActive: number
): PaymentAccessGrantRecord[] {
  const newestFirst = [...activeGrants].sort((a, b) => {
    const byCreated = (toTime(b.created_at) ?? 0) - (toTime(a.created_at) ?? 0)
    return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id)
  })

  return newestFirst.slice(Math.max(maxActive, 1))
}
