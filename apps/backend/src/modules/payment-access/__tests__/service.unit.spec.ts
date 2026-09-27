import { type PaymentAccessGrantRecord, hashPaymentAccessToken } from "../grants"
import { PIX_PAYMENT_VIEW_POLICY } from "../policies"
import PaymentAccessModuleService, { type IssuePaymentAccessGrantInput } from "../service"

type Filters = Record<string, unknown>

// In-memory stand-in for the CRUD methods MedusaService generates, supporting
// the filters the service uses. Each call yields to the event loop so that
// concurrent issuances actually interleave.
function buildService() {
  const rows: PaymentAccessGrantRecord[] = []
  let sequence = 0
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  const matches = (row: PaymentAccessGrantRecord, filters: Filters): boolean =>
    Object.entries(filters).every(([key, expected]) => {
      if (key === "$or") {
        return (expected as Filters[]).some((alternative) => matches(row, alternative))
      }
      const actual = (row as Record<string, unknown>)[key]
      if (expected === null) {
        return actual === null || actual === undefined
      }
      if (expected && typeof expected === "object" && "$gt" in expected) {
        return new Date(actual as string).getTime() > (expected.$gt as Date).getTime()
      }
      if (expected && typeof expected === "object" && "$lte" in expected) {
        return actual !== null && actual !== undefined &&
          new Date(actual as string).getTime() <= (expected.$lte as Date).getTime()
      }
      return actual === expected
    })

  const service = Object.create(PaymentAccessModuleService.prototype) as PaymentAccessModuleService &
    Record<string, jest.Mock>

  Object.assign(service, {
    createPaymentAccessGrants: jest.fn(async (data: Omit<PaymentAccessGrantRecord, "id">) => {
      await tick()
      sequence += 1
      const row = {
        ...data,
        id: `pag_${String(sequence).padStart(4, "0")}`,
        revoked_at: null,
        created_at: new Date(Date.parse("2026-09-27T12:00:00.000Z") + sequence).toISOString(),
      } as PaymentAccessGrantRecord
      rows.push(row)
      return row
    }),
    listPaymentAccessGrants: jest.fn(async (filters: Filters, config?: { take?: number }) => {
      await tick()
      const found = rows.filter((row) => matches(row, filters)).map((row) => ({ ...row }))
      return config?.take ? found.slice(0, config.take) : found
    }),
    deletePaymentAccessGrants: jest.fn(async (ids: string[]) => {
      await tick()
      for (const id of ids) {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      }
    }),
    updatePaymentAccessGrants: jest.fn(async (updates: Array<Partial<PaymentAccessGrantRecord> & { id: string }>) => {
      await tick()
      for (const update of updates) {
        const row = rows.find((candidate) => candidate.id === update.id)
        if (row) Object.assign(row, update)
      }
    }),
  })

  return { service, rows }
}

function issueInput(overrides: Partial<IssuePaymentAccessGrantInput> = {}): IssuePaymentAccessGrantInput {
  return {
    purpose: PIX_PAYMENT_VIEW_POLICY.purpose,
    provider_id: PIX_PAYMENT_VIEW_POLICY.provider_id,
    payment_method: PIX_PAYMENT_VIEW_POLICY.payment_method,
    payment_session_id: "payses_1",
    payment_collection_id: "pay_col_1",
    cart_id: "cart_1",
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    max_active_per_session: PIX_PAYMENT_VIEW_POLICY.max_active_per_session,
    ...overrides,
  }
}

const active = (rows: PaymentAccessGrantRecord[]) => rows.filter((row) => !row.revoked_at)

describe("PaymentAccessModuleService.purgeExpiredGrants", () => {
  const DAY = 24 * 60 * 60 * 1000
  const RETENTION = 7 * DAY
  const NOW = new Date("2026-10-10T12:00:00.000Z")
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

  function seed(rows: PaymentAccessGrantRecord[], list: Array<Partial<PaymentAccessGrantRecord> & { id: string }>) {
    for (const row of list) {
      rows.push({
        token_hash: `hash_${row.id}`,
        purpose: "pix_payment_view",
        provider_id: "pp_mercadopago",
        payment_method: "pix",
        payment_session_id: "payses_1",
        payment_collection_id: "pay_col_1",
        cart_id: "cart_1",
        expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
        revoked_at: null,
        ...row,
      } as PaymentAccessGrantRecord)
    }
  }

  it("removes only grants unusable for more than 7 days, and a repeated run is a no-op", async () => {
    const { service, rows } = buildService()
    seed(rows, [
      { id: "pag_active" },
      { id: "pag_expired_6d", expires_at: ago(6 * DAY) },
      { id: "pag_expired_8d", expires_at: ago(8 * DAY) },
      { id: "pag_revoked_8d", expires_at: ago(6 * DAY), revoked_at: ago(8 * DAY), revoked_reason: "superseded" },
      { id: "pag_revoked_2d", expires_at: ago(DAY), revoked_at: ago(2 * DAY), revoked_reason: "payment_method_changed" },
      { id: "pag_revoked_active_window", revoked_at: ago(DAY), revoked_reason: "superseded" },
    ])

    const first = await service.purgeExpiredGrants({ retention_ms: RETENTION, now: NOW })

    expect(first).toBe(2)
    expect(rows.map((row) => row.id).sort()).toEqual(
      ["pag_active", "pag_expired_6d", "pag_revoked_2d", "pag_revoked_active_window"].sort()
    )

    const second = await service.purgeExpiredGrants({ retention_ms: RETENTION, now: NOW })
    expect(second).toBe(0)
    expect(rows).toHaveLength(4)
  })

  it("works in batches until nothing old is left", async () => {
    const { service, rows } = buildService()
    seed(rows, [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `pag_old_${i}`, expires_at: ago(9 * DAY) })),
      { id: "pag_active" },
    ])

    const deleted = await service.purgeExpiredGrants({ retention_ms: RETENTION, batch_size: 2, now: NOW })

    expect(deleted).toBe(5)
    expect(rows.map((row) => row.id)).toEqual(["pag_active"])
    expect((service.deletePaymentAccessGrants as unknown as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it("never deletes a usable grant even if the store returned it", async () => {
    const { service, rows } = buildService()
    seed(rows, [{ id: "pag_active" }])
    ;(service.listPaymentAccessGrants as unknown as jest.Mock).mockResolvedValueOnce(rows.map((row) => ({ ...row })))

    const deleted = await service.purgeExpiredGrants({ retention_ms: RETENTION, now: NOW })

    expect(deleted).toBe(0)
    expect(service.deletePaymentAccessGrants).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
  })
})

describe("PaymentAccessModuleService", () => {
  it("issues a token, persisting only its hash and the server-side binding", async () => {
    const { service, rows } = buildService()

    const issued = await service.issueGrant(issueInput())

    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(hashPaymentAccessToken(issued.token))
    expect(JSON.stringify(rows)).not.toContain(issued.token)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        purpose: "pix_payment_view",
        provider_id: "pp_mercadopago",
        payment_method: "pix",
        payment_session_id: "payses_1",
        payment_collection_id: "pay_col_1",
        cart_id: "cart_1",
      })
    )
    expect(issued.grant_id).toBe(rows[0].id)
  })

  it("finds a usable grant by token and returns null for anything else, without saying why", async () => {
    const { service, rows } = buildService()
    const issued = await service.issueGrant(issueInput())

    expect((await service.findUsableGrant(issued.token, "pix_payment_view"))?.id).toBe(rows[0].id)
    expect(await service.findUsableGrant("pat_unknown", "pix_payment_view")).toBeNull()
    expect(await service.findUsableGrant(`pat_${"A".repeat(43)}`, "pix_payment_view")).toBeNull()
    expect(await service.findUsableGrant(undefined, "pix_payment_view")).toBeNull()
    expect(
      await service.findUsableGrant(issued.token, "pix_payment_view", new Date(Date.now() + 2 * 60 * 60 * 1000))
    ).toBeNull()
  })

  it("does not look up malformed tokens", async () => {
    const { service } = buildService()

    await service.findUsableGrant("not-a-token", "pix_payment_view")

    expect(service.listPaymentAccessGrants).not.toHaveBeenCalled()
  })

  it("keeps at most 3 active grants per session, revoking the oldest", async () => {
    const { service, rows } = buildService()
    const tokens: string[] = []

    for (let i = 0; i < 5; i++) {
      tokens.push((await service.issueGrant(issueInput())).token)
    }

    expect(active(rows)).toHaveLength(3)
    expect(rows.filter((row) => row.revoked_reason === "superseded")).toHaveLength(2)
    expect(await service.findUsableGrant(tokens[0], "pix_payment_view")).toBeNull()
    expect(await service.findUsableGrant(tokens[4], "pix_payment_view")).not.toBeNull()
  })

  it("converges to at most 3 active grants when issuances race", async () => {
    const { service, rows } = buildService()

    await Promise.all(Array.from({ length: 6 }, () => service.issueGrant(issueInput())))

    expect(active(rows).length).toBeLessThanOrEqual(3)
    expect(active(rows).length).toBeGreaterThanOrEqual(1)
  })

  it("does not count other sessions' grants against the limit", async () => {
    const { service, rows } = buildService()

    for (let i = 0; i < 3; i++) {
      await service.issueGrant(issueInput())
    }
    await service.issueGrant(issueInput({ payment_session_id: "payses_2" }))

    expect(active(rows)).toHaveLength(4)
  })

  it("revokes every active grant of a session", async () => {
    const { service, rows } = buildService()
    const first = await service.issueGrant(issueInput())
    await service.issueGrant(issueInput())
    await service.issueGrant(issueInput({ payment_session_id: "payses_2" }))

    const revoked = await service.revokeSessionGrants("payses_1", "payment_method_changed")

    expect(revoked).toBe(2)
    expect(rows.filter((row) => row.payment_session_id === "payses_1").every((row) => row.revoked_at)).toBe(true)
    expect(rows.find((row) => row.payment_session_id === "payses_2")?.revoked_at).toBeNull()
    expect(await service.findUsableGrant(first.token, "pix_payment_view")).toBeNull()
  })
})
