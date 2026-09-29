import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

const MERCADOPAGO_PROVIDER_ID = "pp_mercadopago"

export type SessionLike = {
  id: string
  provider_id?: string | null
  status?: string | null
  amount?: unknown
  currency_code?: string | null
  data?: Record<string, unknown> | null
}

export type CancelPendingPixChargeInput = {
  order_id: string
}

export type CancelPendingPixChargeResult = {
  payment_session_id: string
  status: string
}

// A Pix charge Medusa still waits for: the order was placed with the Pix
// pending (pending_authorization) and the session holds a Mercado Pago Order.
// Card sessions, sessions without a charge and Pix already authorized (paid:
// the core refunds its captured Payment) or cancelled are left alone.
export function selectPendingPixSessions(sessions: SessionLike[]): SessionLike[] {
  return sessions.filter(
    (session) =>
      session.provider_id === MERCADOPAGO_PROVIDER_ID &&
      session.status === "pending_authorization" &&
      session.data?.payment_method_id === "pix" &&
      typeof session.data?.mercadopago_order_id === "string" &&
      session.data.mercadopago_order_id.length > 0
  )
}

// Cancels the order's pending Pix charge through the payment module (the
// provider's transient 'cancel' action → invalidatePixOrder), so there is a
// single Mercado Pago cancellation path. The provider reads the Order first:
// a paid charge throws NOT_ALLOWED and nothing is cancelled. Any failure is
// rethrown with its reason, so the caller does not cancel the Medusa order.
// No pending Pix → undefined (nothing to do). Shared by the
// cancel-order-with-pending-pix workflow (before the core cancellation,
// ADR-013) and the orderCanceled hook (safety net, ADR-012).
export async function cancelPendingPixChargeForOrder(
  orderId: string,
  container: MedusaContainer
): Promise<CancelPendingPixChargeResult | undefined> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "payment_collections.payment_sessions.id",
      "payment_collections.payment_sessions.provider_id",
      "payment_collections.payment_sessions.status",
      "payment_collections.payment_sessions.amount",
      "payment_collections.payment_sessions.currency_code",
      "payment_collections.payment_sessions.data",
    ],
    filters: { id: orderId },
  })

  const sessions = ((data[0]?.payment_collections ?? []) as Array<{ payment_sessions?: SessionLike[] | null } | null>)
    .flatMap((collection) => collection?.payment_sessions ?? [])
  const pending = selectPendingPixSessions(sessions)

  if (pending.length === 0) {
    return undefined
  }

  if (pending.length > 1) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Mercado Pago: order ${orderId} has more than one pending Pix charge; it was not canceled.`
    )
  }

  const [session] = pending
  const paymentModule = container.resolve(Modules.PAYMENT)

  try {
    const updated = await paymentModule.updatePaymentSession({
      id: session.id,
      amount: session.amount as number,
      currency_code: session.currency_code as string,
      data: { ...session.data, mercadopago_pix_action: "cancel" },
    })

    return { payment_session_id: updated.id, status: updated.status }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new MedusaError(
      error instanceof MedusaError ? error.type : MedusaError.Types.UNEXPECTED_STATE,
      `Mercado Pago: order ${orderId} was not canceled because its pending Pix charge could not be canceled (${cause}).`
    )
  }
}

export async function cancelPendingPixChargeInvoke(
  input: CancelPendingPixChargeInput,
  { container }: { container: MedusaContainer }
) {
  return new StepResponse(await cancelPendingPixChargeForOrder(input.order_id, container))
}

// No compensation on purpose: a Mercado Pago cancellation cannot be undone.
// If a later step fails, the Pix stays cancelled and the Medusa order stays
// active; cancelling the order again finds no pending Pix and only runs the
// core (ADR-013).
export const cancelPendingPixChargeStep = createStep(
  "cancel-pending-pix-charge",
  cancelPendingPixChargeInvoke
)
