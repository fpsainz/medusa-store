import { BEFORE_DEADLINE_SQL, PAST_DEADLINE_SQL, TOKEN_HOLDING_CARD_ATTEMPT_STATES } from "../attempt-states"
import {
  buildDestroyTokenStatement,
  buildRecordOrderStatement,
  buildTransitionStatement,
  CARD_ATTEMPT_TRANSITIONS,
  type TransitionName,
} from "../transitions"

const edges = () =>
  Object.values(CARD_ATTEMPT_TRANSITIONS).flatMap((t) => t.from.map((from) => `${from}→${t.to}`))

const statement = (name: TransitionName) =>
  buildTransitionStatement(CARD_ATTEMPT_TRANSITIONS[name], { column: "id", value: "mpca_1" })

describe("card attempt transitions", () => {
  it("are exactly the transitions approved in INV-009 (rule 1 is the insert)", () => {
    expect(edges().sort()).toEqual(
      [
        "submitted→replaced", // 2
        "submitted→authorizing", // 3
        "unknown→authorizing", // 4
        "authorizing→authorizing", // 5
        "authorizing→resolved", // 6
        "authorizing→failed", // 7
        "authorizing→unknown", // 8
        "unknown→failed", // 9
        "authorizing→expired", // 10
        "unknown→expired", // 10
        "expired→resolved", // 11
        "expired→failed", // 11
        "unknown→resolved", // 12
      ].sort()
    )
  })

  it("never replaces a blocking attempt and never leaves a final state", () => {
    expect(edges()).not.toContain("authorizing→replaced")
    expect(edges()).not.toContain("unknown→replaced")
    for (const final of ["resolved", "failed", "replaced"]) {
      expect(edges().some((edge) => edge.startsWith(`${final}→`))).toBe(false)
    }
  })

  it.each(Object.keys(CARD_ATTEMPT_TRANSITIONS) as TransitionName[])(
    "%s: conditional on id, origin state and not soft-deleted; sets updated_at; returns ids",
    (name) => {
      const { sql } = statement(name)
      const definition = CARD_ATTEMPT_TRANSITIONS[name]
      expect(sql).toMatch(/^UPDATE "mercadopago_card_attempt" SET /)
      expect(sql).toContain(`state = '${definition.to}'`)
      expect(sql).toContain("updated_at = now()")
      expect(sql).toContain("WHERE id = ? AND deleted_at IS NULL AND state IN (")
      for (const from of definition.from) {
        expect(sql).toContain(`'${from}'`)
      }
      expect(sql).toMatch(/RETURNING id$/)
    }
  )

  it("destroys the token exactly when leaving a token-holding state for a state without one", () => {
    for (const [name, definition] of Object.entries(CARD_ATTEMPT_TRANSITIONS)) {
      const leavesHolding =
        definition.from.every((s) => (TOKEN_HOLDING_CARD_ATTEMPT_STATES as readonly string[]).includes(s)) &&
        !(TOKEN_HOLDING_CARD_ATTEMPT_STATES as readonly string[]).includes(definition.to)
      expect({ name, destroys: definition.destroysToken }).toEqual({ name, destroys: leavesHolding })
      const { sql } = statement(name as TransitionName)
      expect(sql.includes("encrypted_card_token = NULL")).toBe(definition.destroysToken)
      if (definition.destroysToken) {
        // Idempotent: the first destruction time is kept.
        expect(sql).toContain("token_destroyed_at = COALESCE(token_destroyed_at, now())")
      }
    }
  })

  it("gates replay and the first authorization on the single deadline", () => {
    for (const name of ["begin_authorization", "resume_unknown", "resume_stale_authorizing"] as const) {
      expect(statement(name).sql).toContain(BEFORE_DEADLINE_SQL)
    }
    expect(statement("expire").sql).toContain(PAST_DEADLINE_SQL)
    expect(BEFORE_DEADLINE_SQL).toBe("created_at > now() - interval '24 hours'")
    expect(PAST_DEADLINE_SQL).toBe("created_at <= now() - interval '24 hours'")
  })

  it("resumes an authorizing attempt only after the stale window", () => {
    expect(statement("resume_stale_authorizing").sql).toContain("authorizing_at < now() - interval '5 minutes'")
  })

  it("rule 12 (unknown → resolved) requires the recorded Order to match", () => {
    const s = buildTransitionStatement(
      CARD_ATTEMPT_TRANSITIONS.resolve_from_unknown,
      { column: "id", value: "mpca_1" },
      [],
      ["ORD_1"]
    )
    expect(s.sql).toContain("state IN ('unknown')")
    expect(s.sql).toContain("mercadopago_order_id = ?")
    expect(s.bindings).toEqual(["mpca_1", "ORD_1"])
  })

  it("orders bindings as SET values, target, WHERE values", () => {
    const s = buildTransitionStatement(
      CARD_ATTEMPT_TRANSITIONS.resolve_from_authorizing,
      { column: "id", value: "mpca_1" },
      ["ORD_1"],
      ["ORD_1"]
    )
    expect(s.sql.indexOf("mercadopago_order_id = ?")).toBeLessThan(s.sql.indexOf("WHERE"))
    expect(s.bindings).toEqual(["ORD_1", "mpca_1", "ORD_1"])
  })

  it("sets the authorization timestamps only when authorization starts or resumes", () => {
    expect(statement("begin_authorization").sql).toContain("authorization_started_at = now(), authorizing_at = now()")
    expect(statement("resume_unknown").sql).toContain("authorizing_at = now()")
    expect(statement("resume_unknown").sql).not.toContain("authorization_started_at")
  })

  it("records an Order without a state change, only on an open attempt without one", () => {
    const s = buildRecordOrderStatement("mpca_1", "ORD_1")
    expect(s.sql).not.toContain("state =")
    expect(s.sql).toContain("state IN ('authorizing', 'unknown') AND mercadopago_order_id IS NULL")
    expect(s.bindings).toEqual(["ORD_1", "mpca_1"])
  })

  it("destroys a leftover token idempotently, never on a token-holding attempt", () => {
    const s = buildDestroyTokenStatement("mpca_1")
    expect(s.sql).toContain("encrypted_card_token IS NOT NULL")
    expect(s.sql).toContain("state NOT IN ('submitted', 'authorizing', 'unknown')")
    expect(s.sql).toContain("COALESCE(token_destroyed_at, now())")
  })
})
