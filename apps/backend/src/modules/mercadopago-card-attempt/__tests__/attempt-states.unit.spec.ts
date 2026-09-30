import {
  BLOCKING_CARD_ATTEMPT_STATES,
  CARD_ATTEMPT_STATES,
  CARD_ATTEMPT_TTL_HOURS,
  getCardAttemptDeadline,
  LIVE_CARD_ATTEMPT_STATES,
  LIVE_CARD_ATTEMPT_STATES_SQL,
  TOKEN_HOLDING_CARD_ATTEMPT_STATES,
} from "../attempt-states"

describe("card attempt states", () => {
  it("lists the seven states of ADR-015", () => {
    expect([...CARD_ATTEMPT_STATES]).toEqual([
      "submitted",
      "authorizing",
      "unknown",
      "resolved",
      "failed",
      "replaced",
      "expired",
    ])
  })

  it("treats only non-final states and expired as live", () => {
    expect([...LIVE_CARD_ATTEMPT_STATES]).toEqual(["submitted", "authorizing", "unknown", "expired"])
    for (const state of LIVE_CARD_ATTEMPT_STATES) {
      expect(CARD_ATTEMPT_STATES).toContain(state)
    }
  })

  it("blocks a new card on live states except submitted", () => {
    expect([...BLOCKING_CARD_ATTEMPT_STATES]).toEqual(["authorizing", "unknown", "expired"])
  })

  it("keeps the token only while the attempt can still be authorized", () => {
    expect([...TOKEN_HOLDING_CARD_ATTEMPT_STATES]).toEqual(["submitted", "authorizing", "unknown"])
  })

  it("builds the partial unique index predicate from the live states", () => {
    expect(LIVE_CARD_ATTEMPT_STATES_SQL).toBe(
      "state IN ('submitted', 'authorizing', 'unknown', 'expired')"
    )
  })

  it("has a single deadline: created_at + 24 h", () => {
    expect(CARD_ATTEMPT_TTL_HOURS).toBe(24)
    const createdAt = new Date("2026-09-30T10:00:00.000Z")
    expect(getCardAttemptDeadline(createdAt).toISOString()).toBe("2026-10-01T10:00:00.000Z")
  })
})
