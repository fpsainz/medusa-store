import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { MercadoPagoConfig, Order } from "mercadopago"

import {
  PIX_TERMINAL_STATUSES,
  hasPixOrderData,
  mergePixOrderData,
  toPixPaymentDto,
} from "../../../../../../modules/mercadopago/service"

// Same identity as the other Mercado Pago routes (see the webhook route's
// own comment): the registered provider token is pp_mercadopago.
const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

type PaymentSessionRow = {
  id?: string
  provider_id?: string
  status?: string
  data?: Record<string, unknown> | null
}

type CartRow = {
  id: string
  completed_at?: string | Date | null
  payment_collection?: { payment_sessions?: PaymentSessionRow[] | null } | null
}

// Current state of the cart's Mercado Pago Pix charge, for the checkout
// Review. Access follows Medusa's own store cart model: the cart id is the
// capability (as for GET /store/carts/:id), and the Pix session is only
// ever looked up inside that cart's own payment collection.
//
// The cart id stops being a credential once the cart is completed: the route
// then answers 410 with no body, so a Review still open when the webhook
// completed the cart can stop showing a paid charge (see ADR-007).
//
// While the charge is not in a terminal state, the Mercado Pago Order is
// read (GET /v1/orders/:id, read-only) so the Review reflects expiration,
// cancellation or payment as Mercado Pago reports them. Nothing is written:
// Medusa's Payment Session only changes through the webhook, completeCart,
// or the prepare route.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const cartId = req.params.id
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph(
    {
      entity: "cart",
      fields: [
        "id",
        "completed_at",
        "payment_collection.payment_sessions.id",
        "payment_collection.payment_sessions.provider_id",
        "payment_collection.payment_sessions.status",
        "payment_collection.payment_sessions.data",
      ],
      filters: { id: cartId },
    },
    { throwIfKeyNotFound: false }
  )

  const cart = data?.[0] as CartRow | undefined
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Mercado Pago: cart not found.")
  }

  res.setHeader("Cache-Control", "no-store")

  if (cart.completed_at) {
    res.status(410).end()
    return
  }

  const session = cart.payment_collection?.payment_sessions?.find(
    (candidate) =>
      candidate.provider_id === MERCADOPAGO_PROVIDER_ID &&
      candidate.data?.payment_method_id === "pix"
  )

  if (!session) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "Mercado Pago: no Pix payment session found for this cart."
    )
  }

  const stored = toPixPaymentDto(session)
  const sessionData = session.data ?? {}
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN

  if (
    !hasPixOrderData(sessionData) ||
    PIX_TERMINAL_STATUSES.includes(stored.status) ||
    !accessToken
  ) {
    res.json(stored)
    return
  }

  try {
    const order = await new Order(new MercadoPagoConfig({ accessToken })).get({
      id: sessionData.mercadopago_order_id as string,
    })

    res.json(
      toPixPaymentDto({
        status: session.status,
        data: mergePixOrderData(sessionData, order, order.transactions?.payments?.[0]),
      })
    )
  } catch {
    // Mercado Pago unreachable: the last state Medusa stored is still a
    // correct (if older) answer; the next poll will try again.
    res.json(stored)
  }
}
