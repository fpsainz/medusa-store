import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

import {
  type PixAccessBinding,
  type PixAccessCart,
  type PixAccessSession,
  resolvePixAccessBinding,
} from "../pix-access-binding"

export type ResolvePixAccessBindingInput = {
  cart_id: string
  payment_session_id: string
}

// Reads the current cart and payment session (never trusting what the route
// already checked) and decides the binding. Read-only: nothing to compensate.
export const resolvePixAccessBindingStep = createStep(
  "resolve-pix-access-binding",
  async (input: ResolvePixAccessBindingInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const paymentModuleService = container.resolve(Modules.PAYMENT)

    const { data: carts } = await query.graph(
      {
        entity: "cart",
        fields: ["id", "completed_at", "payment_collection.id"],
        filters: { id: input.cart_id },
      },
      { throwIfKeyNotFound: false }
    )

    const [session] = await paymentModuleService.listPaymentSessions(
      { id: input.payment_session_id },
      { select: ["id", "provider_id", "payment_collection_id", "data"] }
    )

    const binding: PixAccessBinding | null = resolvePixAccessBinding({
      cart: carts?.[0] as PixAccessCart | undefined,
      session: session as PixAccessSession | undefined,
      now: new Date(),
    })

    return new StepResponse(binding)
  }
)
