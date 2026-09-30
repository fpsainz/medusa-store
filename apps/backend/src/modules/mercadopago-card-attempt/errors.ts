import { MedusaError } from "@medusajs/framework/utils"

// Public error codes of the card attempt module (INV-009). NOT_ALLOWED keeps
// `message` and `code` in the HTTP error response; CONFLICT would replace
// the message with a generic one (Medusa 2.20.1 error handler).
export const CARD_ATTEMPT_ERROR_CODES = {
  pending: "card_attempt_pending",
  inProgress: "card_attempt_in_progress",
  manualReview: "card_attempt_manual_review",
  conflict: "card_attempt_conflict",
  notFound: "card_attempt_not_found",
  tokenUnavailable: "card_token_unavailable",
} as const

export type CardAttemptErrorCode =
  (typeof CARD_ATTEMPT_ERROR_CODES)[keyof typeof CARD_ATTEMPT_ERROR_CODES]

const DEFINITIONS: Record<CardAttemptErrorCode, { type: string; message: string }> = {
  card_attempt_pending: {
    type: MedusaError.Types.NOT_ALLOWED,
    message: "A previous card payment attempt is still being confirmed.",
  },
  card_attempt_in_progress: {
    type: MedusaError.Types.NOT_ALLOWED,
    message: "A card payment attempt is already being authorized.",
  },
  card_attempt_manual_review: {
    type: MedusaError.Types.NOT_ALLOWED,
    message: "The card payment attempt requires manual review.",
  },
  card_attempt_conflict: {
    type: MedusaError.Types.NOT_ALLOWED,
    message: "The card payment attempt was changed by another request.",
  },
  card_attempt_not_found: {
    type: MedusaError.Types.NOT_FOUND,
    message: "Card payment attempt not found.",
  },
  card_token_unavailable: {
    type: MedusaError.Types.UNEXPECTED_STATE,
    message: "The card token of the attempt is unavailable.",
  },
}

// Fixed message per code; never includes attempt data, tokens or keys.
export function cardAttemptError(code: CardAttemptErrorCode): MedusaError {
  const { type, message } = DEFINITIONS[code]
  return new MedusaError(type, message, code)
}
