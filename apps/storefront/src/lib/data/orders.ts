"use server"

import { sdk } from "@lib/config"
import medusaError from "@lib/util/medusa-error"
import { FetchError } from "@medusajs/js-sdk"
import { getAuthHeaders, getCacheOptions } from "./cookies"
import { HttpTypes } from "@medusajs/types"

export const retrieveOrder = async (id: string) => {
  const headers = {
    ...(await getAuthHeaders()),
  }

  const next = {
    ...(await getCacheOptions("orders")),
  }

  return sdk.client
    .fetch<HttpTypes.StoreOrderResponse>(`/store/orders/${id}`, {
      method: "GET",
      query: {
        fields:
          "*payment_collections.payments,*items,*items.metadata,*items.variant,*items.product",
      },
      headers,
      next,
      cache: "force-cache",
    })
    .then(({ order }) => order)
    .catch((err) => medusaError(err))
}

export type PixPayment = {
  status: string
  qr_code?: string
  qr_code_base64?: string
  ticket_url?: string
  expires_at?: string
}

// Pix QR/copy-paste/ticket_url/expiration are not part of the Order/Payment
// the storefront otherwise fetches: while the Pix payment is
// pending_authorization, Medusa hasn't materialized a Payment record yet,
// only the (unsanitized) Payment Session. Rather than exposing
// payment_sessions.data to the client (the previous, since-reverted
// approach), this reads the allowlisted Pix DTO from a dedicated backend
// endpoint that never returns the payer, any document/identification, the
// idempotency key, or any other Mercado Pago internal id.
//
// Returns null, rather than throwing, when the order has no Mercado Pago
// Pix session (e.g. it was paid by card, or with another provider) — that
// is an expected, non-error outcome for this call, not a failure.
export const retrievePixPayment = async (
  orderId: string
): Promise<PixPayment | null> => {
  const headers = {
    ...(await getAuthHeaders()),
  }

  return sdk.client
    .fetch<PixPayment>(`/store/mercadopago/orders/${orderId}/pix`, {
      method: "GET",
      headers,
      cache: "no-store",
    })
    .then((pixPayment) => pixPayment)
    .catch((err) => {
      if (err instanceof FetchError && err.status === 404) {
        return null
      }

      return medusaError(err)
    })
}

export const listOrders = async (
  limit: number = 10,
  offset: number = 0,
  filters?: Record<string, unknown>
) => {
  const headers = {
    ...(await getAuthHeaders()),
  }

  const next = {
    ...(await getCacheOptions("orders")),
  }

  return sdk.client
    .fetch<HttpTypes.StoreOrderListResponse>(`/store/orders`, {
      method: "GET",
      query: {
        limit,
        offset,
        order: "-created_at",
        fields: "*items,+items.metadata,*items.variant,*items.product",
        ...filters,
      },
      headers,
      next,
      cache: "force-cache",
    })
    .then(({ orders }) => orders)
    .catch((err) => medusaError(err))
}

export const createTransferRequest = async (
  state: {
    success: boolean
    error: string | null
    order: HttpTypes.StoreOrder | null
  },
  formData: FormData
): Promise<{
  success: boolean
  error: string | null
  order: HttpTypes.StoreOrder | null
}> => {
  const id = formData.get("order_id") as string

  if (!id) {
    return { success: false, error: "Order ID is required", order: null }
  }

  const headers = await getAuthHeaders()

  return await sdk.store.order
    .requestTransfer(
      id,
      {},
      {
        fields: "id, email",
      },
      headers
    )
    .then(({ order }) => ({ success: true, error: null, order }))
    .catch((err) => ({ success: false, error: err.message, order: null }))
}

export const acceptTransferRequest = async (id: string, token: string) => {
  const headers = await getAuthHeaders()

  return await sdk.store.order
    .acceptTransfer(id, { token }, {}, headers)
    .then(({ order }) => ({ success: true, error: null, order }))
    .catch((err) => ({ success: false, error: err.message, order: null }))
}

export const declineTransferRequest = async (id: string, token: string) => {
  const headers = await getAuthHeaders()

  return await sdk.store.order
    .declineTransfer(id, { token }, {}, headers)
    .then(({ order }) => ({ success: true, error: null, order }))
    .catch((err) => ({ success: false, error: err.message, order: null }))
}
