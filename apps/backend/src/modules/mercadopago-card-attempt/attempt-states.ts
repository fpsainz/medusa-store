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
// the validity and destruction of the card token, decryption and expiry.
// A retry never extends it.
export const CARD_ATTEMPT_TTL_HOURS = 24

// An attempt left in `authorizing` longer than this (the SDK gives up after
// ~247 s) is taken as interrupted and may be resumed.
export const CARD_ATTEMPT_STALE_AUTHORIZING_MINUTES = 5

export function getCardAttemptDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CARD_ATTEMPT_TTL_HOURS * 60 * 60 * 1000)
}

// The same deadline, evaluated by PostgreSQL against its own clock (the
// clock that set created_at), for every conditional statement.
export const BEFORE_DEADLINE_SQL = `created_at > now() - interval '${CARD_ATTEMPT_TTL_HOURS} hours'`
export const PAST_DEADLINE_SQL = `created_at <= now() - interval '${CARD_ATTEMPT_TTL_HOURS} hours'`

const sqlList = (states: readonly string[]) => states.map((state) => `'${state}'`).join(", ")

// SQL predicate of the partial unique index. Medusa appends
// `AND deleted_at IS NULL` to an index `where` given as a string.
export const LIVE_CARD_ATTEMPT_STATES_SQL = `state IN (${sqlList(LIVE_CARD_ATTEMPT_STATES)})`
