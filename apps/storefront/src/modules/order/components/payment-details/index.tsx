import { Container, Heading, Text } from "@modules/common/components/ui"

import { isStripeLike, paymentInfoMap } from "@lib/constants"
import { retrieveOrderPixPayment } from "@lib/data/orders"
import Divider from "@modules/common/components/divider"
import { convertToLocale } from "@lib/util/money"
import { HttpTypes } from "@medusajs/types"
import OrderPixPayment from "./order-pix-payment"

type PaymentDetailsProps = {
  order: HttpTypes.StoreOrder
}

const PaymentDetails = async ({ order }: PaymentDetailsProps) => {
  const payment = order.payment_collections?.[0].payments?.[0]

  // A Pix payment still awaiting the buyer's transfer has no Payment record
  // yet (Medusa only creates one once the provider confirms it, via the
  // webhook), so `payment` above is undefined in that window. Its state is
  // read with this browser's Pix payment capability (HttpOnly cookie, see
  // ADR-007), never with the order id: the id in the URL is only compared
  // with the capability's order. Another browser, or this one after the
  // capability expired, gets null and sees no Pix details.
  //
  // Nothing here creates or prepares a charge; OrderPixPayment only follows
  // the existing one (polling through a Server Action).
  const pixPayment = await retrieveOrderPixPayment(order.id)
  const isPixOrder = pixPayment !== null
  // Awaiting only while Mercado Pago reports it pending/processing AND the
  // payment window (application deadline) is still open.
  const isAwaitingPix =
    isPixOrder &&
    pixPayment.payment_window_closed !== true &&
    (pixPayment.status === "pending" || pixPayment.status === "processing")

  // Pending Pix has no Payment record yet — the summary falls back to the
  // Mercado Pago provider id and the order's total, without creating one.
  const summaryProviderId = payment?.provider_id ?? (isPixOrder ? "pp_mercadopago" : undefined)

  return (
    <div>
      <Heading level="h2" className="flex flex-row text-3xl-regular my-6">
        Payment
      </Heading>
      <div>
        {summaryProviderId && (
          <div className="flex items-start gap-x-1 w-full">
            <div className="flex flex-col w-1/3">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                Payment method
              </Text>
              <Text
                className="txt-medium text-ui-fg-subtle"
                data-testid="payment-method"
              >
                {paymentInfoMap[summaryProviderId].title}
              </Text>
            </div>
            <div className="flex flex-col w-2/3">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                Payment details
              </Text>
              <div className="flex gap-2 txt-medium text-ui-fg-subtle items-center">
                <Container className="flex items-center h-7 w-fit p-2 bg-ui-button-neutral-hover">
                  {paymentInfoMap[summaryProviderId].icon}
                </Container>
                <Text data-testid="payment-amount">
                  {payment
                    ? isStripeLike(payment.provider_id) && payment.data?.card_last4
                      ? `**** **** **** ${payment.data.card_last4}`
                      : isAwaitingPix
                      ? `${convertToLocale({
                          amount: payment.amount,
                          currency_code: order.currency_code,
                        })} — awaiting Pix payment`
                      : `${convertToLocale({
                          amount: payment.amount,
                          currency_code: order.currency_code,
                        })} paid at ${new Date(
                          payment.created_at ?? ""
                        ).toLocaleString()}`
                    : isAwaitingPix
                    ? `${convertToLocale({
                        amount: order.total,
                        currency_code: order.currency_code,
                      })} — awaiting Pix payment`
                    : convertToLocale({
                        amount: order.total,
                        currency_code: order.currency_code,
                      })}
                </Text>
              </div>
            </div>
          </div>
        )}

        {pixPayment && <OrderPixPayment orderId={order.id} initialCharge={pixPayment} />}
      </div>

      <Divider className="mt-8" />
    </div>
  )
}

export default PaymentDetails
