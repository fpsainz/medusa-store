import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { purgeExpiredPaymentAccessWorkflow } from "../workflows/payment-access/purge-expired-payment-access"

// Daily cleanup of payment capabilities expired or revoked more than 7 days
// ago (ADR-007). Logs only how many rows were removed: never a token (only
// hashes are stored anyway), id or session.
export default async function cleanupPaymentAccessGrants(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const { result } = await purgeExpiredPaymentAccessWorkflow(container).run({ input: {} })

  logger.info(`payment_access cleanup: removed ${result} expired/revoked grant(s)`)
}

export const config = {
  name: "cleanup-payment-access-grants",
  schedule: "30 3 * * *",
}
