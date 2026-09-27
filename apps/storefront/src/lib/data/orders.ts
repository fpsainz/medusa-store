"use server"

import { sdk } from "@lib/config"
import medusaError from "@lib/util/medusa-error"
import { FetchError } from "@medusajs/js-sdk"
import { getAuthHeaders, getCacheOptions } from "./cookies"
import { HttpTypes } from "@medusajs/types"
import type { PixCharge } from "@lib/util/pix-client"
import { readPixPaymentAccess } from "./payment-access"

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
  ticket_url?: string
}

// The Pix status and ticket_url are not part of the Order/Payment the
// storefront otherwise fetches: while the Pix payment is
// pending_authorization, Medusa hasn't materialized a Payment record yet,
// only the Payment Session. This reads the minimal order-page DTO from a
// dedicated backend endpoint (status + ticket_url only: no QR code, payer,
// document/identification, idempotency key or Mercado Pago internal id).
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

// Pix of an order, read with the Pix payment capability of this browser
// (HttpOnly cookie, ADR-007). The order id is only compared with the order
// the capability belongs to: it is never sent to the backend and grants
// nothing. Null when this browser holds no valid capability for that order.
export const retrieveOrderPixPayment = async (
  orderId: string
): Promise<PixCharge | null> => {
  const view = await readPixPaymentAccess()

  return view && view.orderId !== null && view.orderId === orderId ? view.charge : null
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
