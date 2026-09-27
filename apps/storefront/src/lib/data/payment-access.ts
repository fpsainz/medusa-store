import "server-only"

import { MEDUSA_BACKEND_URL } from "@lib/config"
import { PAYMENT_ACCESS_TOKEN_HEADER, type PixCharge, splitPixAccessView } from "@lib/util/pix-client"

import { getPaymentAccessToken } from "./cookies"

export type PixPaymentAccessView = {
  // Order the capability belongs to (null until the cart is completed).
  // Server-only: compared with the page's order, never sent to the browser.
  orderId: string | null
  charge: PixCharge
}

// Reads the Pix payment with the capability kept in the HttpOnly cookie
// (ADR-007). Uses native fetch, not the SDK: the SDK's debug logger (on in
// development) prints request headers and only redacts `authorization`, and
// the capability travels in a request header. Never in the URL. Any failure
// (no cookie, invalid/expired capability, backend down) reads as null.
export async function readPixPaymentAccess(): Promise<PixPaymentAccessView | null> {
  const token = await getPaymentAccessToken()
  if (!token) {
    return null
  }

  const publishableKey = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY

  try {
    const resp = await fetch(`${MEDUSA_BACKEND_URL}/store/mercadopago/payment-access/pix`, {
      method: "GET",
      headers: {
        [PAYMENT_ACCESS_TOKEN_HEADER]: token,
        ...(publishableKey ? { "x-publishable-api-key": publishableKey } : {}),
      },
      cache: "no-store",
    })

    if (!resp.ok) {
      return null
    }

    return splitPixAccessView(await resp.json())
  } catch {
    return null
  }
}
