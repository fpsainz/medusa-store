import type { LoaderOptions } from "@medusajs/framework/types"

import { parseCardTokenKeyRing } from "../card-token-crypto"
import type { MercadopagoCardAttemptModuleOptions } from "../service"

// Runs when the module loads. A malformed card token key configuration
// stops the boot (fail closed and visible). An absent one is allowed: the
// app starts, and card token operations fail with card_token_unavailable.
export default async function validateCardTokenKeys({
  options,
  logger,
}: LoaderOptions<MercadopagoCardAttemptModuleOptions>): Promise<void> {
  const keyRing = parseCardTokenKeyRing(options?.card_token_keys, options?.card_token_current_kid)

  if (!keyRing) {
    logger?.warn(
      "Mercado Pago: card token keys are not configured; card payment attempts will be refused."
    )
  }
}
