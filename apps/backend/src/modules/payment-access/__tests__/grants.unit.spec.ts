import {
  PAYMENT_ACCESS_TOKEN_PREFIX,
  type PaymentAccessGrantRecord,
  generatePaymentAccessToken,
  hashPaymentAccessToken,
  isGrantUsable,
  isWellFormedPaymentAccessToken,
  selectGrantsToSupersede,
} from "../grants"

const NOW = new Date("2026-09-27T12:00:00.000Z")

function grant(overrides: Partial<PaymentAccessGrantRecord> = {}): PaymentAccessGrantRecord {
  return {
    id: "pag_1",
    token_hash: "hash",
    purpose: "pix_payment_view",
    provider_id: "pp_mercadopago",
    payment_method: "pix",
    payment_session_id: "payses_1",
    payment_collection_id: "pay_col_1",
    cart_id: "cart_1",
    expires_at: "2026-09-27T13:00:00.000Z",
    revoked_at: null,
    created_at: "2026-09-27T11:00:00.000Z",
    ...overrides,
  }
}

describe("payment access tokens", () => {
  it("are opaque, prefixed and carry 256 random bits (base64url)", () => {
    const token = generatePaymentAccessToken()

    expect(token.startsWith(PAYMENT_ACCESS_TOKEN_PREFIX)).toBe(true)
    const raw = Buffer.from(token.slice(PAYMENT_ACCESS_TOKEN_PREFIX.length), "base64url")
    expect(raw).toHaveLength(32)
    expect(isWellFormedPaymentAccessToken(token)).toBe(true)
    // Not a JWT: no dot-separated segments to decode.
    expect(token.split(".")).toHaveLength(1)
  })

  it("never repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generatePaymentAccessToken()))
    expect(tokens.size).toBe(200)
  })

  it("are stored only as a SHA-256 hex digest, never as plaintext", () => {
    const token = generatePaymentAccessToken()
    const hash = hashPaymentAccessToken(token)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(token.slice(PAYMENT_ACCESS_TOKEN_PREFIX.length))
    expect(hashPaymentAccessToken(token)).toBe(hash)
    expect(hashPaymentAccessToken(generatePaymentAccessToken())).not.toBe(hash)
  })

  it("rejects malformed values before any lookup", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "pat_",
      "pat_short",
      `pat_${"a".repeat(44)}`,
      `xyz_${"a".repeat(43)}`,
      `pat_${"a".repeat(42)}!`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    ]) {
      expect(isWellFormedPaymentAccessToken(value)).toBe(false)
    }
  })
})

describe("isGrantUsable", () => {
  it("accepts an active grant of the same purpose before it expires", () => {
    expect(isGrantUsable(grant(), "pix_payment_view", NOW)).toBe(true)
  })

  it("rejects another purpose", () => {
    expect(isGrantUsable(grant({ purpose: "boleto_payment_view" }), "pix_payment_view", NOW)).toBe(false)
  })

  it("rejects a revoked grant", () => {
    expect(
      isGrantUsable(grant({ revoked_at: "2026-09-27T11:30:00.000Z" }), "pix_payment_view", NOW)
    ).toBe(false)
  })

  it("rejects a grant at or after expires_at, and an unparsable expiry", () => {
    expect(isGrantUsable(grant({ expires_at: NOW.toISOString() }), "pix_payment_view", NOW)).toBe(false)
    expect(
      isGrantUsable(grant({ expires_at: "2026-09-27T11:59:59.000Z" }), "pix_payment_view", NOW)
    ).toBe(false)
    expect(isGrantUsable(grant({ expires_at: "not-a-date" }), "pix_payment_view", NOW)).toBe(false)
  })
})

describe("selectGrantsToSupersede", () => {
  const grants = [
    grant({ id: "pag_a", created_at: "2026-09-27T11:00:00.000Z" }),
    grant({ id: "pag_c", created_at: "2026-09-27T11:02:00.000Z" }),
    grant({ id: "pag_b", created_at: "2026-09-27T11:01:00.000Z" }),
    grant({ id: "pag_d", created_at: "2026-09-27T11:03:00.000Z" }),
  ]

  it("keeps the newest N and returns the older ones", () => {
    expect(selectGrantsToSupersede(grants, 3).map((g) => g.id)).toEqual(["pag_a"])
    expect(selectGrantsToSupersede(grants, 1).map((g) => g.id)).toEqual(["pag_c", "pag_b", "pag_a"])
    expect(selectGrantsToSupersede(grants.slice(0, 2), 3)).toEqual([])
  })

  it("is deterministic for grants created at the same instant", () => {
    const tied = [
      grant({ id: "pag_x", created_at: "2026-09-27T11:00:00.000Z" }),
      grant({ id: "pag_y", created_at: "2026-09-27T11:00:00.000Z" }),
    ]

    expect(selectGrantsToSupersede(tied, 1).map((g) => g.id)).toEqual(["pag_x"])
    expect(selectGrantsToSupersede([...tied].reverse(), 1).map((g) => g.id)).toEqual(["pag_x"])
  })

  it("never keeps fewer than one grant", () => {
    expect(selectGrantsToSupersede(grants, 0)).toHaveLength(3)
  })
})
