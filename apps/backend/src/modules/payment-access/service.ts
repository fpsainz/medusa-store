import { MedusaService } from "@medusajs/framework/utils"

import {
  type PaymentAccessGrantRecord,
  type PaymentAccessPurpose,
  generatePaymentAccessToken,
  hashPaymentAccessToken,
  isGrantPurgeable,
  isGrantUsable,
  isWellFormedPaymentAccessToken,
  selectGrantsToSupersede,
} from "./grants"
import PaymentAccessGrant from "./models/payment-access-grant"

export type IssuePaymentAccessGrantInput = {
  purpose: PaymentAccessPurpose
  provider_id: string
  payment_method: string
  payment_session_id: string
  payment_collection_id: string
  cart_id: string
  expires_at: Date
  max_active_per_session: number
}

export type IssuedPaymentAccessGrant = {
  // Plaintext token: returned once, to be handed to the storefront server
  // only. It is never stored.
  token: string
  grant_id: string
  expires_at: Date
}

class PaymentAccessModuleService extends MedusaService({
  PaymentAccessGrant,
}) {
  async issueGrant(input: IssuePaymentAccessGrantInput): Promise<IssuedPaymentAccessGrant> {
    const token = generatePaymentAccessToken()

    const created = (await this.createPaymentAccessGrants({
      token_hash: hashPaymentAccessToken(token),
      purpose: input.purpose,
      provider_id: input.provider_id,
      payment_method: input.payment_method,
      payment_session_id: input.payment_session_id,
      payment_collection_id: input.payment_collection_id,
      cart_id: input.cart_id,
      expires_at: input.expires_at,
    })) as unknown as PaymentAccessGrantRecord

    await this.supersedeExcessGrants(
      input.payment_session_id,
      input.purpose,
      input.max_active_per_session
    )

    return { token, grant_id: created.id, expires_at: input.expires_at }
  }

  // Returns the grant only when the token is well formed, known, of this
  // purpose, not revoked and not expired; otherwise null, without saying why.
  async findUsableGrant(
    token: unknown,
    purpose: PaymentAccessPurpose,
    now: Date = new Date()
  ): Promise<PaymentAccessGrantRecord | null> {
    if (!isWellFormedPaymentAccessToken(token)) {
      return null
    }

    const [grant] = (await this.listPaymentAccessGrants(
      { token_hash: hashPaymentAccessToken(token) },
      { take: 1 }
    )) as unknown as PaymentAccessGrantRecord[]

    return grant && isGrantUsable(grant, purpose, now) ? grant : null
  }

  async revokeSessionGrants(
    paymentSessionId: string,
    reason: string,
    now: Date = new Date()
  ): Promise<number> {
    const active = (await this.listPaymentAccessGrants({
      payment_session_id: paymentSessionId,
      revoked_at: null,
    })) as unknown as PaymentAccessGrantRecord[]

    await this.revoke(active, reason, now)
    return active.length
  }

  // Hard-deletes grants that have been expired or revoked for longer than
  // the retention period, in batches. Idempotent: a second run finds
  // nothing to delete. Returns only how many rows were removed.
  async purgeExpiredGrants(input: {
    retention_ms: number
    batch_size?: number
    now?: Date
  }): Promise<number> {
    const now = input.now ?? new Date()
    const batchSize = input.batch_size ?? 500
    const cutoff = new Date(now.getTime() - input.retention_ms)
    let deleted = 0

    for (;;) {
      const candidates = (await this.listPaymentAccessGrants(
        { $or: [{ expires_at: { $lte: cutoff } }, { revoked_at: { $lte: cutoff } }] },
        { select: ["id", "expires_at", "revoked_at"], take: batchSize }
      )) as unknown as Pick<PaymentAccessGrantRecord, "id" | "expires_at" | "revoked_at">[]

      // Re-checked in code so a filter mistake can never delete a usable grant.
      const ids = candidates
        .filter((grant) => isGrantPurgeable(grant, now, input.retention_ms))
        .map((grant) => grant.id)

      if (ids.length > 0) {
        await this.deletePaymentAccessGrants(ids)
        deleted += ids.length
      }

      if (candidates.length < batchSize || ids.length === 0) {
        return deleted
      }
    }
  }

  private async supersedeExcessGrants(
    paymentSessionId: string,
    purpose: PaymentAccessPurpose,
    maxActive: number,
    now: Date = new Date()
  ): Promise<void> {
    const active = (await this.listPaymentAccessGrants({
      payment_session_id: paymentSessionId,
      purpose,
      revoked_at: null,
      expires_at: { $gt: now },
    })) as unknown as PaymentAccessGrantRecord[]

    await this.revoke(selectGrantsToSupersede(active, maxActive), "superseded", now)
  }

  private async revoke(
    grants: PaymentAccessGrantRecord[],
    reason: string,
    now: Date
  ): Promise<void> {
    if (grants.length === 0) {
      return
    }

    await this.updatePaymentAccessGrants(
      grants.map((grant) => ({ id: grant.id, revoked_at: now, revoked_reason: reason }))
    )
  }
}

export default PaymentAccessModuleService
