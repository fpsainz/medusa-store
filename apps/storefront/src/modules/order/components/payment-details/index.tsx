import { Container, Heading, Text } from "@modules/common/components/ui"

import { isStripeLike, paymentInfoMap } from "@lib/constants"
import { retrievePixPayment } from "@lib/data/orders"
import Divider from "@modules/common/components/divider"
import { convertToLocale } from "@lib/util/money"
import { HttpTypes } from "@medusajs/types"

type PaymentDetailsProps = {
  order: HttpTypes.StoreOrder
}

const PaymentDetails = async ({ order }: PaymentDetailsProps) => {
  const payment = order.payment_collections?.[0].payments?.[0]

  // A Pix payment still awaiting the buyer's transfer has no Payment record
  // yet (Medusa only creates one once the provider confirms it, via the
  // webhook), so `payment` above is undefined in that window. Its status
  // comes from a dedicated, allowlisted endpoint instead of the raw payment
  // session — null for any order that isn't a Mercado Pago payment.
  //
  // This page only reports the outcome. The Pix charge is prepared and
  // shown (QR modal, polling) on the checkout Review, before "Place order";
  // nothing here creates, prepares or polls it, and no modal opens here.
  const pixPayment = await retrievePixPayment(order.id)
  const isPixOrder = Boolean(
    pixPayment?.qr_code || pixPayment?.qr_code_base64 || pixPayment?.ticket_url
  )
  // The payment session only becomes "authorized" once Medusa has recorded
  // the Pix as paid (webhook or completeCart); until then it is awaiting.
  const isAwaitingPix = isPixOrder && pixPayment?.status !== "authorized"

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
                    : `${convertToLocale({
                        amount: order.total,
                        currency_code: order.currency_code,
                      })} — awaiting Pix payment`}
                </Text>
              </div>
            </div>
          </div>
        )}

        {isAwaitingPix && pixPayment?.ticket_url && (
          <div
            className="flex flex-col gap-2 mt-4"
            data-testid="pix-order-pending"
          >
            <Text className="txt-small text-ui-fg-subtle">
              Your Pix payment has not been confirmed yet.
            </Text>
            <a
              href={pixPayment.ticket_url}
              target="_blank"
              rel="noopener noreferrer"
              className="txt-small text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
              data-testid="pix-order-ticket-url-link"
            >
              Open Pix payment
            </a>
          </div>
        )}
      </div>

      <Divider className="mt-8" />
    </div>
  )
}

export default PaymentDetails
