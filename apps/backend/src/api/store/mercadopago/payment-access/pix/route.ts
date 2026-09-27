import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { MercadoPagoConfig, Order } from "mercadopago"

import { toPixAccessDto } from "../../../../../modules/mercadopago/pix-access-view"
import {
  PIX_TERMINAL_STATUSES,
  hasPixOrderData,
  mergePixOrderData,
  toPixPaymentDto,
} from "../../../../../modules/mercadopago/service"
import { PAYMENT_ACCESS_MODULE } from "../../../../../modules/payment-access"
import { PIX_PAYMENT_VIEW_POLICY } from "../../../../../modules/payment-access/policies"
import type PaymentAccessModuleService from "../../../../../modules/payment-access/service"
import { PAYMENT_ACCESS_TOKEN_HEADER } from "../../../../utils/pix-payment-access"

type SessionRow = {
  id: string
  provider_id?: string
  payment_collection_id?: string
  status?: string
  data?: Record<string, unknown> | null
}

// Every failure (no/unknown/expired/revoked token, wrong purpose, missing or
// changed session, broken binding) gets this same answer.
function notFound(): MedusaError {
  return new MedusaError(MedusaError.Types.NOT_FOUND, "Payment not found.")
}

// Read-only view of one Pix payment, authorized by a payment capability
// (ADR-007) sent by the storefront server in the x-payment-access-token
// header. The client names nothing: no order id, no payment session id. The
// capability is never read from the query string. Everything is resolved
// from the capability and revalidated against the current state.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")

  const token = req.headers[PAYMENT_ACCESS_TOKEN_HEADER]
  if (typeof token !== "string") {
    throw notFound()
  }

  const paymentAccess: PaymentAccessModuleService = req.scope.resolve(PAYMENT_ACCESS_MODULE)
  const grant = await paymentAccess.findUsableGrant(token, PIX_PAYMENT_VIEW_POLICY.purpose)
  if (
    !grant ||
    grant.provider_id !== PIX_PAYMENT_VIEW_POLICY.provider_id ||
    grant.payment_method !== PIX_PAYMENT_VIEW_POLICY.payment_method
  ) {
    throw notFound()
  }

  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const [session] = (await paymentModuleService.listPaymentSessions(
    { id: grant.payment_session_id },
    { select: ["id", "provider_id", "payment_collection_id", "status", "data"] }
  )) as SessionRow[]

  const sessionData = session?.data ?? {}
  if (
    !session ||
    session.provider_id !== grant.provider_id ||
    session.payment_collection_id !== grant.payment_collection_id ||
    sessionData.payment_method_id !== PIX_PAYMENT_VIEW_POLICY.payment_method ||
    !hasPixOrderData(sessionData)
  ) {
    throw notFound()
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: collections } = await query.graph(
    {
      entity: "payment_collection",
      fields: ["id", "order.id"],
      filters: { id: grant.payment_collection_id },
    },
    { throwIfKeyNotFound: false }
  )
  const orderId =
    (collections?.[0] as { order?: { id?: string } | null } | undefined)?.order?.id ?? null

  // Same live read as the cart route: while the stored state is not final,
  // Mercado Pago is asked (read-only) so an approval or cancellation shows up
  // even before the webhook. Nothing is written.
  let data = sessionData
  const stored = toPixPaymentDto({ status: session.status, data: sessionData })
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!PIX_TERMINAL_STATUSES.includes(stored.status) && accessToken) {
    try {
      const order = await new Order(new MercadoPagoConfig({ accessToken })).get({
        id: sessionData.mercadopago_order_id as string,
      })
      data = mergePixOrderData(sessionData, order, order.transactions?.payments?.[0])
    } catch {
      // Mercado Pago unreachable: the stored state still answers.
    }
  }

  res.json(toPixAccessDto({ session_status: session.status, data, order_id: orderId, now: new Date() }))
}
