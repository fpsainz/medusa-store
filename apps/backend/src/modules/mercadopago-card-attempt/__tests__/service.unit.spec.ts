import { randomBytes } from "node:crypto"

import { encryptCardToken, parseCardTokenKeyRing } from "../card-token-crypto"
import MercadopagoCardAttemptModuleService from "../service"

const TOKEN = "FAKE-card-token-0123456789abcdef-not-real"
const RING = parseCardTokenKeyRing(`k1:${randomBytes(32).toString("base64url")}`, "k1")
const OTHER_RING = parseCardTokenKeyRing(`k1:${randomBytes(32).toString("base64url")}`, "k1")
const SESSION = "payses_01TEST"
const ID = "mpca_01TESTATTEMPT"

type Call = { sql: string; params: unknown[] }
type Row = Record<string, unknown>

const baseRow = (over: Row = {}): Row => ({
  id: ID,
  payment_session_id: SESSION,
  cart_id: "cart_01TEST",
  state: "submitted",
  external_reference: "cart_01TEST-01TESTATTEMPT",
  body_sha256: null,
  mercadopago_order_id: null,
  last_error_class: null,
  created_at: new Date("2026-09-30T10:00:00.000Z"),
  authorization_started_at: null,
  authorizing_at: null,
  ended_at: null,
  token_destroyed_at: null,
  has_card_token: true,
  past_deadline: false,
  ...over,
})

// A service over a fake repository: each statement goes to `handler`.
function makeService(handler: (sql: string, params: unknown[]) => Row[], keyRing = RING) {
  const calls: Call[] = []
  const warnings: string[] = []
  const service = Object.create(MercadopagoCardAttemptModuleService.prototype) as MercadopagoCardAttemptModuleService
  Object.assign(service, {
    baseRepository_: {
      transaction: async (task: (em: unknown) => Promise<unknown>) =>
        task({
          execute: async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params })
            return handler(sql, params)
          },
        }),
    },
    logger_: { warn: (message: string) => warnings.push(message) },
    keyRing_: keyRing,
  })
  return { service, calls, warnings }
}

const isUpdateTo = (sql: string, state: string) => sql.startsWith("UPDATE") && sql.includes(`SET state = '${state}'`)
const isSelect = (sql: string) => sql.startsWith("SELECT id, payment_session_id")

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

describe("MercadopagoCardAttemptModuleService", () => {
  describe("submitAttempt (rules 1 + 2)", () => {
    it("replaces the submitted attempt, checks for a blocking one and inserts only the ciphertext", async () => {
      let inserted: unknown[] = []
      const { service, calls } = makeService((sql, params) => {
        if (sql.startsWith("INSERT")) {
          inserted = params
          return [{ id: params[0] }]
        }
        if (isSelect(sql)) return [baseRow({ id: inserted[0] })]
        return []
      })

      const view = await service.submitAttempt({ payment_session_id: SESSION, cart_id: "cart_01TEST", card_token: TOKEN })

      expect(calls[0].sql).toContain("SET state = 'replaced'")
      expect(calls[0].sql).toContain("WHERE payment_session_id = ?")
      expect(calls[0].sql).toContain("state IN ('submitted')")
      expect(calls[1].sql).toContain("state IN ('authorizing', 'unknown', 'expired')")
      expect(calls[2].sql).toContain("ON CONFLICT DO NOTHING RETURNING id")
      const [id, session, cart, externalReference, envelope] = inserted as string[]
      expect(id).toMatch(/^mpca_/)
      expect(session).toBe(SESSION)
      expect(cart).toBe("cart_01TEST")
      expect(externalReference).toBe(`cart_01TEST-${id.slice(5)}`)
      expect(externalReference.length).toBeLessThanOrEqual(64)
      expect(envelope).toMatch(/^v1:k1:/)
      expect(JSON.stringify(calls)).not.toContain(TOKEN)
      expect(JSON.stringify(view)).not.toContain("v1:k1:")
      expect(view).not.toHaveProperty("encrypted_card_token")
    })

    it("retries a lost insert race once, then succeeds", async () => {
      let inserts = 0
      const { service } = makeService((sql, params) => {
        if (sql.startsWith("INSERT")) return ++inserts === 1 ? [] : [{ id: params[0] }]
        if (isSelect(sql)) return [baseRow()]
        return []
      })
      await service.submitAttempt({ payment_session_id: SESSION, cart_id: "cart_01TEST", card_token: TOKEN })
      expect(inserts).toBe(2)
    })

    it("fails with card_attempt_conflict after losing the race twice", async () => {
      const { service } = makeService(() => [])
      await expectCode(
        service.submitAttempt({ payment_session_id: SESSION, cart_id: "cart_01TEST", card_token: TOKEN }),
        "card_attempt_conflict"
      )
    })

    it.each([
      ["authorizing", "card_attempt_pending"],
      ["unknown", "card_attempt_pending"],
      ["expired", "card_attempt_manual_review"],
    ])("refuses a new card while an attempt is %s (%s), without inserting", async (state, code) => {
      const { service, calls } = makeService((sql) => (sql.startsWith("SELECT state") ? [{ state }] : []))
      await expectCode(
        service.submitAttempt({ payment_session_id: SESSION, cart_id: "cart_01TEST", card_token: TOKEN }),
        code
      )
      expect(calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false)
    })

    it("fails closed without keys: card_token_unavailable, nothing inserted, token not logged", async () => {
      const { service, calls, warnings } = makeService(() => [], null)
      await expectCode(
        service.submitAttempt({ payment_session_id: SESSION, cart_id: "cart_01TEST", card_token: TOKEN }),
        "card_token_unavailable"
      )
      expect(calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false)
      expect(warnings.join("\n")).toContain("key_missing")
      expect(warnings.join("\n")).not.toContain(TOKEN)
    })

    it("refuses a cart id that cannot form the external_reference", async () => {
      const { service } = makeService(() => [])
      await expect(
        service.submitAttempt({ payment_session_id: SESSION, cart_id: "cart-with-dash", card_token: TOKEN })
      ).rejects.toMatchObject({ type: "invalid_data" })
    })
  })

  describe("transitions: 0 rows picks a stable error, never a write", () => {
    it.each([
      [{ state: "authorizing" }, "card_attempt_in_progress"],
      [{ state: "expired" }, "card_attempt_manual_review"],
      [{ state: "resolved" }, "card_attempt_conflict"],
      [{ state: "replaced" }, "card_attempt_conflict"],
    ])("markUnknown on %o → %s", async (over, code) => {
      const { service, calls } = makeService((sql) => (isSelect(sql) ? [baseRow(over)] : []))
      await expectCode(service.markUnknown(ID, "MPConnectionError"), code)
      expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toHaveLength(1)
    })

    it("missing attempt → card_attempt_not_found", async () => {
      const { service } = makeService(() => [])
      await expectCode(service.failAuthorization(ID, "MPPaymentError"), "card_attempt_not_found")
    })

    it("a successful transition returns the view read after it", async () => {
      const { service } = makeService((sql) =>
        isUpdateTo(sql, "resolved") ? [{ id: ID }] : isSelect(sql) ? [baseRow({ state: "resolved", has_card_token: false })] : []
      )
      const view = await service.resolveAuthorization(ID, "ORD_1")
      expect(view.state).toBe("resolved")
      expect(view.has_card_token).toBe(false)
    })

    it("rule 12: resolveUnknown binds the recorded Order in the WHERE", async () => {
      const { service, calls } = makeService((sql) =>
        isUpdateTo(sql, "resolved") ? [{ id: ID }] : isSelect(sql) ? [baseRow({ state: "resolved" })] : []
      )
      await service.resolveUnknown(ID, "ORD_1")
      expect(calls[0].sql).toContain("state IN ('unknown')")
      expect(calls[0].params).toEqual([ID, "ORD_1"])
    })
  })

  describe("single deadline", () => {
    it("beginAuthorization of a submitted attempt past the deadline replaces it → card_token_unavailable", async () => {
      const { service, calls } = makeService((sql) => {
        if (isUpdateTo(sql, "replaced")) return [{ id: ID }]
        if (isSelect(sql)) return [baseRow({ past_deadline: true })]
        return []
      })
      await expectCode(service.beginAuthorization(ID, "hash"), "card_token_unavailable")
      expect(calls.some((c) => isUpdateTo(c.sql, "replaced"))).toBe(true)
    })

    it("resume (replay) past the deadline expires the attempt → card_attempt_manual_review", async () => {
      const { service, calls } = makeService((sql) => {
        if (isUpdateTo(sql, "expired")) return [{ id: ID }]
        if (isSelect(sql)) return [baseRow({ state: "unknown", past_deadline: true })]
        return []
      })
      await expectCode(service.resumeAuthorization(ID), "card_attempt_manual_review")
      expect(calls.some((c) => isUpdateTo(c.sql, "expired"))).toBe(true)
    })

    it("resume of a recent authorizing attempt → card_attempt_in_progress", async () => {
      const { service } = makeService((sql) => (isSelect(sql) ? [baseRow({ state: "authorizing" })] : []))
      await expectCode(service.resumeAuthorization(ID), "card_attempt_in_progress")
    })

    it("expireIfPastDeadline: open → expired, else submitted → replaced (deadline-gated), else null", async () => {
      const expired = makeService((sql) => (isUpdateTo(sql, "expired") ? [{ id: ID }] : []))
      expect(await expired.service.expireIfPastDeadline(ID)).toBe("expired")

      const replaced = makeService((sql) => (isUpdateTo(sql, "replaced") ? [{ id: ID }] : []))
      expect(await replaced.service.expireIfPastDeadline(ID)).toBe("replaced")
      expect(replaced.calls[1].sql).toContain("created_at <= now() - interval '24 hours'")

      const none = makeService(() => [])
      expect(await none.service.expireIfPastDeadline(ID)).toBeNull()
    })
  })

  describe("readCardToken", () => {
    const envelope = encryptCardToken(RING, TOKEN, { attemptId: ID, paymentSessionId: SESSION })
    const withToken = (over: Row) => (sql: string) =>
      isSelect(sql) ? [baseRow({ encrypted_card_token: envelope, ...over })] : []

    it("decrypts the token of an open attempt before the deadline", async () => {
      const { service } = makeService(withToken({ state: "authorizing" }))
      await expect(service.readCardToken(ID, SESSION)).resolves.toBe(TOKEN)
    })

    it("unknown attempt whose token cannot be decrypted → manual review, never failed", async () => {
      const { service, calls, warnings } = makeService(withToken({ state: "unknown" }), OTHER_RING)
      await expectCode(service.readCardToken(ID, SESSION), "card_attempt_manual_review")
      expect(calls.some((c) => isUpdateTo(c.sql, "failed"))).toBe(false)
      expect(warnings.join("\n")).toContain("auth_failed")
      expect(warnings.join("\n")).not.toContain(TOKEN)
      expect(warnings.join("\n")).not.toContain(envelope)
    })

    it("submitted attempt whose token cannot be decrypted → card_token_unavailable", async () => {
      const { service } = makeService(withToken({ state: "submitted" }), OTHER_RING)
      await expectCode(service.readCardToken(ID, SESSION), "card_token_unavailable")
    })

    it("another payment session → card_attempt_not_found", async () => {
      const { service } = makeService(withToken({ state: "authorizing" }))
      await expectCode(service.readCardToken(ID, "payses_other"), "card_attempt_not_found")
    })

    it.each([
      [{ state: "resolved", encrypted_card_token: null }, "card_token_unavailable"],
      [{ state: "expired", encrypted_card_token: null }, "card_attempt_manual_review"],
      [{ state: "unknown", encrypted_card_token: null }, "card_attempt_manual_review"],
    ])("%o → %s", async (over, code) => {
      const { service } = makeService(withToken(over))
      await expectCode(service.readCardToken(ID, SESSION), code)
    })

    it("open attempt past the deadline is expired before refusing (manual review)", async () => {
      const { service, calls } = makeService((sql) => {
        if (isUpdateTo(sql, "expired")) return [{ id: ID }]
        return withToken({ state: "unknown", past_deadline: true })(sql)
      })
      await expectCode(service.readCardToken(ID, SESSION), "card_attempt_manual_review")
      expect(calls.some((c) => isUpdateTo(c.sql, "expired"))).toBe(true)
    })

    it("no error or log carries the token or the envelope", async () => {
      const { service, warnings } = makeService(withToken({ state: "unknown" }), OTHER_RING)
      try {
        await service.readCardToken(ID, SESSION)
      } catch (error) {
        const exposed = [(error as Error).message, (error as Error).stack ?? "", JSON.stringify(error), ...warnings].join("\n")
        expect(exposed).not.toContain(TOKEN)
        expect(exposed).not.toContain(envelope)
      }
    })
  })

  describe("association and destruction", () => {
    it("recordOrder maps a unique violation to card_attempt_conflict", async () => {
      const { service } = makeService(() => {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" })
      })
      await expectCode(service.recordOrder(ID, "ORD_1"), "card_attempt_conflict")
    })

    it("destroyCardToken is idempotent (1, then 0)", async () => {
      let destroyed = false
      const { service } = makeService(() => {
        if (destroyed) return []
        destroyed = true
        return [{ id: ID }]
      })
      expect(await service.destroyCardToken(ID)).toBe(1)
      expect(await service.destroyCardToken(ID)).toBe(0)
    })
  })
})
