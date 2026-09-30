// In-memory stand-in for the mercadopagoCardAttempt module in provider unit
// tests. It mirrors the approved transitions and error codes of the real
// module (INV-009); the real one is covered by its own unit and integration
// tests. Tokens here are fake.
import { CARD_ATTEMPT_ERROR_CODES, cardAttemptError } from "../../mercadopago-card-attempt/errors"

type State = "submitted" | "authorizing" | "unknown" | "resolved" | "failed" | "replaced" | "expired"

type FakeRow = {
  id: string
  payment_session_id: string
  cart_id: string
  state: State
  external_reference: string
  body_sha256: string | null
  mercadopago_order_id: string | null
  last_error_class: string | null
  token: string | null
  past_deadline: boolean
  stale: boolean
}

const HOLDING: State[] = ["submitted", "authorizing", "unknown"]

export function createFakeCardAttempts() {
  const rows = new Map<string, FakeRow>()
  let sequence = 0

  const view = (row: FakeRow) => {
    const { token, stale: _stale, ...rest } = row
    return { ...rest, has_card_token: token !== null }
  }

  const get = (id: string) => {
    const row = rows.get(id)
    if (!row) {
      throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.notFound)
    }
    return row
  }

  const errorFor = (row: FakeRow) =>
    cardAttemptError(
      row.state === "expired"
        ? CARD_ATTEMPT_ERROR_CODES.manualReview
        : row.state === "authorizing" && !row.past_deadline
          ? CARD_ATTEMPT_ERROR_CODES.inProgress
          : CARD_ATTEMPT_ERROR_CODES.conflict
    )

  const move = (id: string, from: State[], to: State, patch: Partial<FakeRow> = {}) => {
    const row = get(id)
    if (!from.includes(row.state)) {
      throw errorFor(row)
    }
    Object.assign(row, patch, { state: to })
    if (!HOLDING.includes(to)) {
      row.token = null
    }
    return view(row)
  }

  const fake = {
    rows,

    register(input: {
      token: string
      paymentSessionId: string
      cartId: string
      state?: State
      mercadopago_order_id?: string | null
      body_sha256?: string | null
      past_deadline?: boolean
      stale?: boolean
    }): string {
      sequence += 1
      const id = `mpca_FAKE${sequence}`
      rows.set(id, {
        id,
        payment_session_id: input.paymentSessionId,
        cart_id: input.cartId,
        state: input.state ?? "submitted",
        external_reference: `${input.cartId}-FAKE${sequence}`,
        body_sha256: input.body_sha256 ?? null,
        mercadopago_order_id: input.mercadopago_order_id ?? null,
        last_error_class: null,
        token: input.token,
        past_deadline: input.past_deadline ?? false,
        stale: input.stale ?? false,
      })
      return id
    },

    retrieveAttemptView: jest.fn(async (id: string) => view(get(id))),

    readCardToken: jest.fn(async (id: string, paymentSessionId: string) => {
      const row = get(id)
      if (row.payment_session_id !== paymentSessionId) {
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.notFound)
      }
      // Like the real module: past the deadline an open attempt is expired
      // and a submitted one replaced before refusing.
      if (row.past_deadline && HOLDING.includes(row.state)) {
        const wasSubmitted = row.state === "submitted"
        row.state = wasSubmitted ? "replaced" : "expired"
        row.token = null
        throw cardAttemptError(
          wasSubmitted ? CARD_ATTEMPT_ERROR_CODES.tokenUnavailable : CARD_ATTEMPT_ERROR_CODES.manualReview
        )
      }
      if (row.state === "expired" || (row.state === "unknown" && row.token === null)) {
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.manualReview)
      }
      if (!HOLDING.includes(row.state) || row.token === null) {
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.tokenUnavailable)
      }
      return row.token
    }),

    beginAuthorization: jest.fn(async (id: string, bodySha256: string) =>
      move(id, ["submitted"], "authorizing", { body_sha256: bodySha256 })
    ),

    resumeAuthorization: jest.fn(async (id: string) => {
      const row = get(id)
      if (row.past_deadline && (row.state === "authorizing" || row.state === "unknown")) {
        row.state = "expired"
        row.token = null
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.manualReview)
      }
      if (row.state === "unknown" || (row.state === "authorizing" && row.stale)) {
        row.state = "authorizing"
        row.stale = false
        return view(row)
      }
      throw errorFor(row)
    }),

    markUnknown: jest.fn(async (id: string, lastErrorClass?: string | null) =>
      move(id, ["authorizing"], "unknown", { last_error_class: lastErrorClass ?? get(id).last_error_class })
    ),

    failAuthorization: jest.fn(async (id: string, lastErrorClass: string) =>
      move(id, ["authorizing"], "failed", { last_error_class: lastErrorClass })
    ),

    resolveAuthorization: jest.fn(async (id: string, orderId: string) => {
      const row = get(id)
      if (row.mercadopago_order_id && row.mercadopago_order_id !== orderId) {
        throw errorFor(row)
      }
      return move(id, ["authorizing"], "resolved", { mercadopago_order_id: orderId })
    }),

    resolveUnknown: jest.fn(async (id: string, orderId: string) => {
      const row = get(id)
      if (row.mercadopago_order_id !== orderId) {
        throw cardAttemptError(CARD_ATTEMPT_ERROR_CODES.conflict)
      }
      return move(id, ["unknown"], "resolved")
    }),

    failUnknown: jest.fn(async (id: string, orderId: string) =>
      move(id, ["unknown"], "failed", { mercadopago_order_id: orderId })
    ),

    recordOrder: jest.fn(async (id: string, orderId: string) => {
      const row = get(id)
      if ((row.state === "authorizing" || row.state === "unknown") && !row.mercadopago_order_id) {
        row.mercadopago_order_id = orderId
        return true
      }
      return false
    }),

    replaceSubmitted: jest.fn(async (id: string) => move(id, ["submitted"], "replaced")),
  }

  return fake
}

export type FakeCardAttempts = ReturnType<typeof createFakeCardAttempts>

// Turns the card data the tests used to put in PaymentSession.data (with a
// card_token) into the current shape: the token registered in a fake
// attempt, the session data carrying only card_attempt_id, and the session
// id in context.idempotency_key (as the Payment Module passes it).
export function cardInput(fake: FakeCardAttempts, data: Record<string, unknown>) {
  const { card_token: token, ...rest } = data
  const paymentSessionId =
    typeof rest.mercadopago_idempotency_key === "string" ? rest.mercadopago_idempotency_key : "payses_fake"
  const cardAttemptId = fake.register({
    token: String(token),
    paymentSessionId,
    cartId: typeof rest.cart_id === "string" ? rest.cart_id : "cart_fake",
  })

  return { data: { ...rest, card_attempt_id: cardAttemptId }, context: { idempotency_key: paymentSessionId } }
}
