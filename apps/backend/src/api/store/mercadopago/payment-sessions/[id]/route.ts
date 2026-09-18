import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const paymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const paymentSessionId = req.params.id
  const body = req.body as Record<string, unknown>

  const paymentSession = await paymentModuleService.retrievePaymentSession(paymentSessionId)

  const updatedPaymentSession = await paymentModuleService.updatePaymentSession({
    id: paymentSessionId,
    currency_code: paymentSession.currency_code,
    amount: paymentSession.amount,
    data: {
      ...paymentSession.data,
      ...body,
    },
  })

  res.json({
    payment_session: updatedPaymentSession,
  })
}
