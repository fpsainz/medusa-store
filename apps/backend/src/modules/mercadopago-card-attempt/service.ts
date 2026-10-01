import type { DAL, Logger } from "@medusajs/framework/types"
import { generateEntityId, MedusaError, MedusaService } from "@medusajs/framework/utils"

import {
  BLOCKING_CARD_ATTEMPT_STATES,
  type CardAttemptState,
  getCardAttemptDeadline,
  PAST_DEADLINE_SQL,
  TOKEN_HOLDING_CARD_ATTEMPT_STATES,
  withinSearchHorizonSql,
} from "./attempt-states"
import {
  type CardTokenKeyRing,
  CardTokenCryptoError,
  decryptCardToken,
  encryptCardToken,
  parseCardTokenKeyRing,
} from "./card-token-crypto"
import { cardAttemptError, CARD_ATTEMPT_ERROR_CODES } from "./errors"
import MercadopagoCardAttempt from "./models/mercadopago-card-attempt"
import {
  buildDestroyTokenStatement,
  buildRecordOrderStatement,
  buildRetentionDestroyTokenStatement,
  buildTransitionStatement,
  CARD_ATTEMPT_TRANSITIONS,
  STALE_AUTHORIZING_SQL,
  type TransitionName,
  type TransitionStatement,
} from "./transitions"

export type MercadopagoCardAttemptModuleOptions = {
  card_token_keys?: string
  card_token_current_kid?: string
}

type InjectedDependencies = {
  baseRepository: DAL.RepositoryService
  logger?: Logger
}

// Domain view of an attempt. Never carries the ciphertext.
export type CardAttemptView = {
  id: string
  payment_session_id: string
  cart_id: string
  state: CardAttemptState
  external_reference: string
  body_sha256: string | null
  mercadopago_order_id: string | null
  last_error_class: string | null
  has_card_token: boolean
  created_at: Date
  deadline: Date
  authorization_started_at: Date | null
  authorizing_at: Date | null
  ended_at: Date | null
  token_destroyed_at: Date | null
  past_deadline: boolean
  // PostgreSQL's now() when the view was read: the clock of every deadline
  // and window condition, so callers never compare against the app clock.
  checked_at: Date
}

type AttemptRow = Omit<CardAttemptView, "deadline"> & { encrypted_card_token?: string | null }

type SqlExecutor = {
  execute<T = Record<string, unknown>[]>(sql: string, params?: unknown[], method?: "all" | "get" | "run"): Promise<T>
}

const TABLE = `"mercadopago_card_attempt"`
const CART_ID_PATTERN = /^[A-Za-z0-9_]{1,37}$/
const INSERT_RETRIES = 2

const VIEW_COLUMNS = [
  "id", "payment_session_id", "cart_id", "state", "external_reference", "body_sha256",
  "mercadopago_order_id", "last_error_class", "created_at", "authorization_started_at",
  "authorizing_at", "ended_at", "token_destroyed_at",
  `(encrypted_card_token IS NOT NULL) AS has_card_token`,
  `(${PAST_DEADLINE_SQL}) AS past_deadline`,
  `now() AS checked_at`,
].join(", ")

const sqlList = (states: readonly string[]) => states.map((state) => `'${state}'`).join(", ")

class LostInsertRace extends Error {}

// Card authorization attempts (ADR-015, INV-009).
//
// Every public method runs in its own module transaction and never accepts
// another operation's transaction context: an attempt write must survive a
// failed Medusa workflow. Every state change is one conditional statement
// (see transitions.ts); a read after a statement that changed nothing only
// picks the error code, it never decides a write.
class MercadopagoCardAttemptModuleService extends MedusaService({
  MercadopagoCardAttempt,
}) {
  protected readonly baseRepository_: DAL.RepositoryService
  protected readonly logger_?: Logger
  protected readonly keyRing_: CardTokenKeyRing | null

  constructor(container: InjectedDependencies, options?: MercadopagoCardAttemptModuleOptions) {
    super(...arguments)
    this.baseRepository_ = container.baseRepository
    this.logger_ = container.logger
    // Malformed configuration throws (the module loader already stops the
    // boot on it); absent configuration leaves card token operations
    // failing closed.
    this.keyRing_ = parseCardTokenKeyRing(options?.card_token_keys, options?.card_token_current_kid)
  }

  // ---------------------------------------------------------------- reads

  async retrieveAttemptView(attemptId: string): Promise<CardAttemptView> {
    const row = await this.inTransaction((em) => this.selectRow(em, attemptId, false))
    if (!row) {
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.notFound)
    }
    return toView(row)
  }

  // Returns the plaintext card token for an open attempt of this payment
  // session, before the deadline. Past the deadline the ciphertext is
  // destroyed (retention, ADR-016) and the state is left as it is: a
  // submitted attempt answers card_token_unavailable; an authorizing/unknown
  // one card_attempt_pending (its Order is resolved by the search, not by a
  // replay). A token that cannot be obtained for an `unknown` attempt before
  // the deadline means manual review, never failure: its Order may exist.
  async readCardToken(attemptId: string, paymentSessionId: string): Promise<string> {
    const row = await this.inTransaction((em) => this.selectRow(em, attemptId, true))

    if (!row || row.payment_session_id !== paymentSessionId) {
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.notFound)
    }

    if (row.state === "expired") {
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.manualReview)
    }

    if (!(TOKEN_HOLDING_CARD_ATTEMPT_STATES as readonly string[]).includes(row.state)) {
      this.warnTokenUnavailable(attemptId, "destroyed")
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.tokenUnavailable)
    }

    if (row.past_deadline) {
      await this.destroyCardTokenForRetention(attemptId)
      this.warnTokenUnavailable(attemptId, "expired")
      throw cardAttemptError(
        row.state === "submitted" ? CARD_ATTEMPT_ERROR_CODES.tokenUnavailable : CARD_ATTEMPT_ERROR_CODES.pending
      )
    }

    const unavailable = (reason: string) => {
      this.warnTokenUnavailable(attemptId, reason)
      return cardAttemptError(
        row.state === "unknown" ? CARD_ATTEMPT_ERROR_CODES.manualReview : CARD_ATTEMPT_ERROR_CODES.tokenUnavailable
      )
    }

    if (!row.encrypted_card_token) {
      throw unavailable("destroyed")
    }

    try {
      return decryptCardToken(this.keyRing_, row.encrypted_card_token, {
        attemptId: row.id,
        paymentSessionId: row.payment_session_id,
      })
    } catch (error) {
      if (error instanceof CardTokenCryptoError) {
        throw unavailable(error.reason)
      }
      throw error
    }
  }

  // ------------------------------------------------------------- rule 1 + 2

  // A card submission from the Brick: replaces a submitted attempt of the
  // session (rule 2) and inserts the new one (rule 1), in one module
  // transaction. Refused while the session has a blocking attempt. At most
  // one live attempt per session holds under concurrency: the insert uses
  // ON CONFLICT DO NOTHING against the partial unique index, and a lost race
  // retries once (the latest submission wins), then fails with a conflict.
  async submitAttempt(input: {
    payment_session_id: string
    cart_id: string
    card_token: string
  }): Promise<CardAttemptView> {
    if (typeof input.payment_session_id !== "string" || !input.payment_session_id) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Mercado Pago: payment_session_id is required.")
    }

    // cart_id-attemptULID must fit the Orders API external_reference
    // (≤ 64 chars, letters, digits, `-`, `_`), and `-` separates the parts.
    if (typeof input.cart_id !== "string" || !CART_ID_PATTERN.test(input.cart_id)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Mercado Pago: invalid cart id for a card attempt.")
    }

    for (let attempt = 1; attempt <= INSERT_RETRIES; attempt++) {
      try {
        const id = await this.inTransaction((em) => this.replaceAndInsert(em, input))
        return await this.retrieveAttemptView(id)
      } catch (error) {
        if (!(error instanceof LostInsertRace)) {
          throw error
        }
      }
    }

    throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.conflict)
  }

  // ----------------------------------------------------------- transitions

  // Rule 3: Place order starts the first authorization of a submitted attempt.
  async beginAuthorization(attemptId: string, bodySha256: string): Promise<CardAttemptView> {
    if (await this.transition(attemptId, "begin_authorization", [bodySha256])) {
      return this.retrieveAttemptView(attemptId)
    }

    const row = await this.requireRow(attemptId)
    if (row.state === "submitted" && row.past_deadline) {
      // The deadline never replaces it (ADR-016): only a new submission does.
      await this.destroyCardTokenForRetention(attemptId)
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.tokenUnavailable)
    }
    throw this.errorForUnexpectedState(row)
  }

  // Rules 4 and 5: replay of an unknown attempt, or resumption of an
  // authorization interrupted for longer than the stale window. Same body
  // and key; the deadline is never extended.
  async resumeAuthorization(attemptId: string): Promise<CardAttemptView> {
    if (
      (await this.transition(attemptId, "resume_unknown")) ||
      (await this.transition(attemptId, "resume_stale_authorizing"))
    ) {
      return this.retrieveAttemptView(attemptId)
    }

    const row = await this.requireRow(attemptId)
    if ((row.state === "authorizing" || row.state === "unknown") && row.past_deadline) {
      // No replay past the deadline and no expiry (ADR-016): the attempt is
      // resolved by searching its Order on the next Place order.
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.pending)
    }
    throw this.errorForUnexpectedState(row)
  }

  // Rule 8: ambiguous Orders API result, or compensation of the hook.
  async markUnknown(attemptId: string, lastErrorClass?: string | null): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "mark_unknown", [lastErrorClass ?? null])
  }

  // Rule 6: the Orders API returned the Order (or a GET found it paid).
  async resolveAuthorization(attemptId: string, mercadopagoOrderId: string): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "resolve_from_authorizing", [mercadopagoOrderId], [mercadopagoOrderId])
  }

  // Rule 7: definitive Orders API error.
  async failAuthorization(attemptId: string, lastErrorClass: string): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "fail_from_authorizing", [lastErrorClass])
  }

  // Association without a state change (webhook): records the Order of an
  // open attempt that has none. Returns false if nothing was recorded.
  async recordOrder(attemptId: string, mercadopagoOrderId: string): Promise<boolean> {
    try {
      return (await this.run(buildRecordOrderStatement(attemptId, mercadopagoOrderId))) > 0
    } catch (error) {
      // The unique index refused an Order already attached to another attempt.
      if (isUniqueViolation(error)) {
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.conflict)
      }
      throw error
    }
  }

  // Rule 12: the webhook path, without the validate hook, finds the recorded
  // Order paid while the attempt is unknown.
  async resolveUnknown(attemptId: string, mercadopagoOrderId: string): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "resolve_from_unknown", [], [mercadopagoOrderId])
  }

  // Rule 9: the Order of an unknown attempt is failed/canceled (webhook).
  async failUnknown(attemptId: string, mercadopagoOrderId: string): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "fail_from_unknown", [mercadopagoOrderId], [mercadopagoOrderId])
  }

  // Rule 8 only for an authorization interrupted longer than the stale
  // window (ADR-016: a recent authorizing attempt is never probed). Returns
  // false when nothing changed.
  async markUnknownIfStale(attemptId: string, lastErrorClass?: string | null): Promise<boolean> {
    return (
      (await this.run(
        buildTransitionStatement(
          { ...CARD_ATTEMPT_TRANSITIONS.mark_unknown, where: STALE_AUTHORIZING_SQL },
          { column: "id", value: attemptId },
          [lastErrorClass ?? null]
        )
      )) > 0
    )
  }

  // Rule 13 (ADR-016): an unknown attempt without a recorded Order, past the
  // deadline and the quiet period, whose Order search found nothing while
  // its last POST is younger than the search horizon, ends failed with the
  // token destroyed, in one conditional statement. 0 rows (another path won,
  // or a condition no longer holds) → card_attempt_conflict.
  async failUnknownWithoutOrder(
    attemptId: string,
    horizonHours: number,
    lastErrorClass = "order_not_found_after_deadline"
  ): Promise<CardAttemptView> {
    const definition = CARD_ATTEMPT_TRANSITIONS.fail_unknown_without_order
    const statement = buildTransitionStatement(
      { ...definition, where: `${definition.where} AND ${withinSearchHorizonSql(horizonHours)}` },
      { column: "id", value: attemptId },
      [lastErrorClass]
    )
    if ((await this.run(statement)) > 0) {
      return this.retrieveAttemptView(attemptId)
    }
    throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.conflict)
  }

  // Retention (ADR-016): past the deadline the ciphertext is destroyed
  // without changing the state, the Order or ended_at. Idempotent; returns
  // how many rows changed.
  async destroyCardTokenForRetention(attemptId: string): Promise<number> {
    return this.run(buildRetentionDestroyTokenStatement(attemptId))
  }

  // Rule 2: a submitted attempt is discarded (e.g. its session was removed).
  async replaceSubmitted(attemptId: string): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "replace_submitted")
  }

  // Rule 11: operator decision on an expired attempt.
  async resolveExpiredManually(attemptId: string, mercadopagoOrderId: string): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "resolve_expired_manually", [mercadopagoOrderId], [mercadopagoOrderId])
  }

  async failExpiredManually(attemptId: string, lastErrorClass?: string | null): Promise<CardAttemptView> {
    return this.transitionOrThrow(attemptId, "fail_expired_manually", [lastErrorClass ?? null])
  }

  // Idempotent: nulls a ciphertext left on an attempt that no longer holds a
  // token. Returns how many rows changed (0 on a repeated call).
  async destroyCardToken(attemptId: string): Promise<number> {
    return this.run(buildDestroyTokenStatement(attemptId))
  }

  // -------------------------------------------------------------- internals

  protected async inTransaction<T>(task: (em: SqlExecutor) => Promise<T>): Promise<T> {
    return this.baseRepository_.transaction<SqlExecutor>((em) => task(em))
  }

  protected async run(statement: TransitionStatement): Promise<number> {
    const rows = await this.inTransaction((em) =>
      em.execute<{ id: string }[]>(statement.sql, statement.bindings, "all")
    )
    return rows.length
  }

  protected async transition(
    attemptId: string,
    name: TransitionName,
    setBindings: unknown[] = [],
    whereBindings: unknown[] = []
  ): Promise<boolean> {
    const statement = buildTransitionStatement(
      CARD_ATTEMPT_TRANSITIONS[name],
      { column: "id", value: attemptId },
      setBindings,
      whereBindings
    )
    return (await this.run(statement)) > 0
  }

  protected async transitionOrThrow(
    attemptId: string,
    name: TransitionName,
    setBindings: unknown[] = [],
    whereBindings: unknown[] = []
  ): Promise<CardAttemptView> {
    if (await this.transition(attemptId, name, setBindings, whereBindings)) {
      return this.retrieveAttemptView(attemptId)
    }
    throw this.errorForUnexpectedState(await this.requireRow(attemptId))
  }

  protected async requireRow(attemptId: string): Promise<AttemptRow> {
    const row = await this.inTransaction((em) => this.selectRow(em, attemptId, false))
    if (!row) {
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.notFound)
    }
    return row
  }

  // Only chooses the error after a statement changed nothing.
  protected errorForUnexpectedState(row: AttemptRow): MedusaError {
    if (row.state === "expired") {
      return cardAttemptError(CARD_ATTEMPT_ERROR_CODES.manualReview)
    }
    if (row.state === "authorizing" && !row.past_deadline) {
      return cardAttemptError(CARD_ATTEMPT_ERROR_CODES.inProgress)
    }
    return cardAttemptError(CARD_ATTEMPT_ERROR_CODES.conflict)
  }

  protected async selectRow(em: SqlExecutor, attemptId: string, withCiphertext: boolean): Promise<AttemptRow | null> {
    const columns = withCiphertext ? `${VIEW_COLUMNS}, encrypted_card_token` : VIEW_COLUMNS
    const rows = await em.execute<AttemptRow[]>(
      `SELECT ${columns} FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`,
      [attemptId],
      "all"
    )
    return rows[0] ?? null
  }

  protected async replaceAndInsert(
    em: SqlExecutor,
    input: { payment_session_id: string; cart_id: string; card_token: string }
  ): Promise<string> {
    const replace = buildTransitionStatement(CARD_ATTEMPT_TRANSITIONS.replace_submitted, {
      column: "payment_session_id",
      value: input.payment_session_id,
    })
    await em.execute(replace.sql, replace.bindings, "all")

    const blocking = await em.execute<{ state: CardAttemptState }[]>(
      `SELECT state FROM ${TABLE} WHERE payment_session_id = ? AND deleted_at IS NULL ` +
        `AND state IN (${sqlList(BLOCKING_CARD_ATTEMPT_STATES)}) LIMIT 1`,
      [input.payment_session_id],
      "all"
    )

    if (blocking.length) {
      throw cardAttemptError(
        blocking[0].state === "expired"
          ? CARD_ATTEMPT_ERROR_CODES.manualReview
          : CARD_ATTEMPT_ERROR_CODES.pending
      )
    }

    // The id exists before encryption: it is part of the AAD.
    const id = generateEntityId(undefined, "mpca")
    const externalReference = `${input.cart_id}-${id.slice(id.indexOf("_") + 1)}`

    let envelope: string
    try {
      envelope = encryptCardToken(this.keyRing_, input.card_token, {
        attemptId: id,
        paymentSessionId: input.payment_session_id,
      })
    } catch (error) {
      if (error instanceof CardTokenCryptoError) {
        this.warnTokenUnavailable(id, error.reason)
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.tokenUnavailable)
      }
      throw error
    }

    const inserted = await em.execute<{ id: string }[]>(
      `INSERT INTO ${TABLE} (id, payment_session_id, cart_id, state, external_reference, ` +
        `encrypted_card_token, created_at, updated_at) VALUES (?, ?, ?, 'submitted', ?, ?, now(), now()) ` +
        `ON CONFLICT DO NOTHING RETURNING id`,
      [id, input.payment_session_id, input.cart_id, externalReference, envelope],
      "all"
    )

    if (!inserted.length) {
      // Another submission holds the live slot: roll back this transaction
      // (including the replace) and try again.
      throw new LostInsertRace()
    }

    return id
  }

  protected warnTokenUnavailable(attemptId: string, reason: string): void {
    this.logger_?.warn(`Mercado Pago: card token unavailable for attempt ${attemptId} (${reason})`)
  }
}

function toView(row: AttemptRow): CardAttemptView {
  const createdAt = new Date(row.created_at)
  return {
    id: row.id,
    payment_session_id: row.payment_session_id,
    cart_id: row.cart_id,
    state: row.state,
    external_reference: row.external_reference,
    body_sha256: row.body_sha256,
    mercadopago_order_id: row.mercadopago_order_id,
    last_error_class: row.last_error_class,
    has_card_token: Boolean(row.has_card_token),
    created_at: createdAt,
    deadline: getCardAttemptDeadline(createdAt),
    authorization_started_at: row.authorization_started_at,
    authorizing_at: row.authorizing_at,
    ended_at: row.ended_at,
    token_destroyed_at: row.token_destroyed_at,
    past_deadline: Boolean(row.past_deadline),
    checked_at: new Date(row.checked_at),
  }
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  return candidate?.code === "23505" || /already exists|duplicate key/i.test(String(candidate?.message ?? ""))
}

export default MercadopagoCardAttemptModuleService
