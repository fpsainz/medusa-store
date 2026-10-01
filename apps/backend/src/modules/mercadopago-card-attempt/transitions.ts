import {
  BEFORE_DEADLINE_SQL,
  CARD_ATTEMPT_STALE_AUTHORIZING_MINUTES,
  type CardAttemptState,
  PAST_DEADLINE_SQL,
  QUIET_PERIOD_ELAPSED_SQL,
} from "./attempt-states"

// The state transitions of a card attempt, exactly as approved in INV-009
// (rule numbers of its transition table). Rule 1 (∅ → submitted) is the
// insert of submitAttempt and is not an UPDATE. No other transition exists:
// in particular a blocking attempt (authorizing/unknown) is never replaced.
//
// Every transition is one conditional statement:
//   UPDATE … SET state = <to>, updated_at = now(), …
//   WHERE <target> = ? AND deleted_at IS NULL AND state IN (<from>) AND …
//   RETURNING id
// Zero returned rows means the precondition did not hold (another request
// won, or the attempt is not in an expected state); a database failure is an
// exception. Nothing is decided from a previous read.

export type TransitionName =
  | "replace_submitted"
  | "begin_authorization"
  | "resume_unknown"
  | "resume_stale_authorizing"
  | "resolve_from_authorizing"
  | "fail_from_authorizing"
  | "mark_unknown"
  | "fail_from_unknown"
  | "expire"
  | "resolve_expired_manually"
  | "fail_expired_manually"
  | "resolve_from_unknown"
  | "fail_unknown_without_order"

export type TransitionDefinition = {
  rule: string
  from: readonly CardAttemptState[]
  to: CardAttemptState
  // Extra SET assignments, with `?` placeholders.
  set?: string
  // Extra WHERE conditions, with `?` placeholders.
  where?: string
  // Nulls the ciphertext and records when (only from token-holding states).
  destroysToken: boolean
  // Sets ended_at (entry into a final or expired state).
  endsAttempt: boolean
}

const ORDER_ID_FREE_OR_SAME = `(mercadopago_order_id IS NULL OR mercadopago_order_id = ?)`
export const STALE_AUTHORIZING_SQL = `authorizing_at < now() - interval '${CARD_ATTEMPT_STALE_AUTHORIZING_MINUTES} minutes'`

export const CARD_ATTEMPT_TRANSITIONS: Record<TransitionName, TransitionDefinition> = {
  // Rule 2: a new submission, a removed session or the deadline replaces a
  // submitted (never confirmed) attempt.
  replace_submitted: {
    rule: "2", from: ["submitted"], to: "replaced", destroysToken: true, endsAttempt: true,
  },
  // Rule 3: Place order starts the authorization.
  begin_authorization: {
    rule: "3", from: ["submitted"], to: "authorizing",
    set: `body_sha256 = ?, authorization_started_at = now(), authorizing_at = now()`,
    where: BEFORE_DEADLINE_SQL,
    destroysToken: false, endsAttempt: false,
  },
  // Rule 4: replay of an ambiguous attempt, same body and key.
  resume_unknown: {
    rule: "4", from: ["unknown"], to: "authorizing",
    set: `authorizing_at = now()`, where: BEFORE_DEADLINE_SQL,
    destroysToken: false, endsAttempt: false,
  },
  // Rule 5: an authorization interrupted (crash) is resumed.
  resume_stale_authorizing: {
    rule: "5", from: ["authorizing"], to: "authorizing",
    set: `authorizing_at = now()`, where: `${STALE_AUTHORIZING_SQL} AND ${BEFORE_DEADLINE_SQL}`,
    destroysToken: false, endsAttempt: false,
  },
  // Rule 6: the Orders API answered with the Order (or a GET found it paid).
  resolve_from_authorizing: {
    rule: "6", from: ["authorizing"], to: "resolved",
    set: `mercadopago_order_id = ?`, where: ORDER_ID_FREE_OR_SAME,
    destroysToken: true, endsAttempt: true,
  },
  // Rule 7: definitive error (or a GET found the Order failed/canceled).
  fail_from_authorizing: {
    rule: "7", from: ["authorizing"], to: "failed",
    set: `last_error_class = ?`, destroysToken: true, endsAttempt: true,
  },
  // Rule 8: ambiguous result (provider) or hook compensation.
  mark_unknown: {
    rule: "8", from: ["authorizing"], to: "unknown",
    set: `last_error_class = COALESCE(?, last_error_class)`,
    destroysToken: false, endsAttempt: false,
  },
  // Rule 9: the Order of the attempt is failed/canceled (webhook).
  fail_from_unknown: {
    rule: "9", from: ["unknown"], to: "failed",
    set: `mercadopago_order_id = ?`, where: ORDER_ID_FREE_OR_SAME,
    destroysToken: true, endsAttempt: true,
  },
  // Rule 10: kept for the table of INV-009, but no longer triggered by the
  // deadline (ADR-016); nothing in the application calls it.
  expire: {
    rule: "10", from: ["authorizing", "unknown"], to: "expired",
    where: PAST_DEADLINE_SQL, destroysToken: true, endsAttempt: true,
  },
  // Rule 11: operator decision on an expired attempt (token already gone).
  resolve_expired_manually: {
    rule: "11", from: ["expired"], to: "resolved",
    set: `mercadopago_order_id = ?`, where: ORDER_ID_FREE_OR_SAME,
    destroysToken: false, endsAttempt: true,
  },
  fail_expired_manually: {
    rule: "11", from: ["expired"], to: "failed",
    set: `last_error_class = COALESCE(?, last_error_class)`,
    destroysToken: false, endsAttempt: true,
  },
  // Rule 12: the webhook path (no validate hook) finds the recorded Order paid.
  resolve_from_unknown: {
    rule: "12", from: ["unknown"], to: "resolved",
    where: `mercadopago_order_id = ?`, destroysToken: true, endsAttempt: true,
  },
  // Rule 13 (ADR-016): past the deadline and the quiet period Q, a search
  // found no Order for the attempt. Never when an Order is recorded: a
  // webhook that recorded one first makes this affect 0 rows. The search
  // horizon H is appended by the service.
  fail_unknown_without_order: {
    rule: "13", from: ["unknown"], to: "failed",
    set: `last_error_class = ?`,
    where: `mercadopago_order_id IS NULL AND ${PAST_DEADLINE_SQL} AND ${QUIET_PERIOD_ELAPSED_SQL}`,
    destroysToken: true, endsAttempt: true,
  },
}

export type TransitionTarget = { column: "id" | "payment_session_id"; value: string }

export type TransitionStatement = { sql: string; bindings: unknown[] }

const TABLE = `"mercadopago_card_attempt"`

export function buildTransitionStatement(
  definition: TransitionDefinition,
  target: TransitionTarget,
  setBindings: unknown[] = [],
  whereBindings: unknown[] = []
): TransitionStatement {
  const assignments = [`state = '${definition.to}'`, `updated_at = now()`]

  if (definition.endsAttempt) {
    assignments.push(`ended_at = now()`)
  }

  if (definition.destroysToken) {
    assignments.push(
      `encrypted_card_token = NULL`,
      `token_destroyed_at = COALESCE(token_destroyed_at, now())`
    )
  }

  if (definition.set) {
    assignments.push(definition.set)
  }

  const conditions = [
    `${target.column} = ?`,
    `deleted_at IS NULL`,
    `state IN (${definition.from.map((state) => `'${state}'`).join(", ")})`,
  ]

  if (definition.where) {
    conditions.push(definition.where)
  }

  return {
    sql: `UPDATE ${TABLE} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")} RETURNING id`,
    bindings: [...setBindings, target.value, ...whereBindings],
  }
}

// Association without a state change: records the Order found by the
// webhook on an open attempt that has none yet. The unique index on
// mercadopago_order_id keeps one Order from belonging to two attempts.
export function buildRecordOrderStatement(attemptId: string, orderId: string): TransitionStatement {
  return {
    sql:
      `UPDATE ${TABLE} SET mercadopago_order_id = ?, updated_at = now() ` +
      `WHERE id = ? AND deleted_at IS NULL AND state IN ('authorizing', 'unknown') ` +
      `AND mercadopago_order_id IS NULL RETURNING id`,
    bindings: [orderId, attemptId],
  }
}

// Retention (ADR-016): past the deadline the ciphertext is destroyed whatever
// the state, without a transition. Touches only the ciphertext and its
// destruction fields; idempotent (a second call affects no row).
export function buildRetentionDestroyTokenStatement(attemptId: string): TransitionStatement {
  return {
    sql:
      `UPDATE ${TABLE} SET encrypted_card_token = NULL, ` +
      `token_destroyed_at = COALESCE(token_destroyed_at, now()), updated_at = now() ` +
      `WHERE id = ? AND deleted_at IS NULL AND encrypted_card_token IS NOT NULL ` +
      `AND ${PAST_DEADLINE_SQL} RETURNING id`,
    bindings: [attemptId],
  }
}

// Idempotent destruction of a ciphertext left on an attempt that no longer
// holds a token. A second call affects no row.
export function buildDestroyTokenStatement(attemptId: string): TransitionStatement {
  return {
    sql:
      `UPDATE ${TABLE} SET encrypted_card_token = NULL, ` +
      `token_destroyed_at = COALESCE(token_destroyed_at, now()), updated_at = now() ` +
      `WHERE id = ? AND deleted_at IS NULL AND encrypted_card_token IS NOT NULL ` +
      `AND state NOT IN ('submitted', 'authorizing', 'unknown') RETURNING id`,
    bindings: [attemptId],
  }
}
