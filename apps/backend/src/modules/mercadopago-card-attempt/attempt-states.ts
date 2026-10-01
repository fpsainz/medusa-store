import { MedusaError } from "@medusajs/framework/utils"

// States of a Mercado Pago card authorization attempt (ADR-015, INV-009).
export const CARD_ATTEMPT_STATES = [
  "submitted",
  "authorizing",
  "unknown",
  "resolved",
  "failed",
  "replaced",
  "expired",
] as const

export type CardAttemptState = (typeof CARD_ATTEMPT_STATES)[number]

// At most one attempt per payment session may be in one of these states,
// enforced by a partial unique index.
export const LIVE_CARD_ATTEMPT_STATES = [
  "submitted",
  "authorizing",
  "unknown",
  "expired",
] as const satisfies readonly CardAttemptState[]

// A new card submission for the session is refused while an attempt is in
// one of these states (a submitted attempt is replaced instead).
export const BLOCKING_CARD_ATTEMPT_STATES = [
  "authorizing",
  "unknown",
  "expired",
] as const satisfies readonly CardAttemptState[]

// The encrypted card token exists only in these states, and only until the
// deadline. Every other state has destroyed it.
export const TOKEN_HOLDING_CARD_ATTEMPT_STATES = [
  "submitted",
  "authorizing",
  "unknown",
] as const satisfies readonly CardAttemptState[]

// The single deadline of an attempt: created_at + 24 h. It governs replay,
// decryption and the retention of the card token ciphertext (ADR-016). It
// never ends an attempt by itself. A retry never extends it.
export const CARD_ATTEMPT_TTL_HOURS = 24

// An attempt left in `authorizing` longer than this (the SDK gives up after
// ~247 s) is taken as interrupted and may be resumed.
export const CARD_ATTEMPT_STALE_AUTHORIZING_MINUTES = 5

// ADR-016, Q: past the deadline, the Order of an ambiguous attempt is only
// searched once its last POST (authorizing_at) is this old, so no POST can
// still be in flight and the search index had time to catch up.
export const CARD_ATTEMPT_QUIET_PERIOD_MINUTES = 30

// ADR-016: margin on both ends of the Order search window, for the clock
// difference between PostgreSQL and Mercado Pago and the SDK retries after
// the last POST started.
export const CARD_ATTEMPT_SEARCH_MARGIN_MINUTES = 60

// ADR-016, H: an empty search (total = 0) may end an attempt only while its
// last POST is younger than this. No value is approved yet, so an empty
// search never ends an attempt (card_attempt_manual_review). Setting it
// requires the evidence described in ADR-016, never an estimate.
export const CARD_ATTEMPT_SEARCH_HORIZON_HOURS: number | null = null

export function getCardAttemptDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CARD_ATTEMPT_TTL_HOURS * 60 * 60 * 1000)
}

// The same deadline, evaluated by PostgreSQL against its own clock (the
// clock that set created_at), for every conditional statement.
export const BEFORE_DEADLINE_SQL = `created_at > now() - interval '${CARD_ATTEMPT_TTL_HOURS} hours'`
export const PAST_DEADLINE_SQL = `created_at <= now() - interval '${CARD_ATTEMPT_TTL_HOURS} hours'`
export const QUIET_PERIOD_ELAPSED_SQL = `authorizing_at < now() - interval '${CARD_ATTEMPT_QUIET_PERIOD_MINUTES} minutes'`

// The last POST of the attempt is younger than the search horizon H.
export function withinSearchHorizonSql(horizonHours: number): string {
  if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Mercado Pago card attempt: invalid search horizon.")
  }
  return `authorizing_at > now() - interval '${horizonHours} hours'`
}

const sqlList = (states: readonly string[]) => states.map((state) => `'${state}'`).join(", ")

// SQL predicate of the partial unique index. Medusa appends
// `AND deleted_at IS NULL` to an index `where` given as a string.
export const LIVE_CARD_ATTEMPT_STATES_SQL = `state IN (${sqlList(LIVE_CARD_ATTEMPT_STATES)})`
