"use client"

import { Heading, Text, clx } from "@modules/common/components/ui"

import PaymentButton from "../payment-button"
import { useSearchParams } from "next/navigation"
import { HttpTypes } from "@medusajs/types"
import { useState } from "react"
import { isMercadoPago } from "@lib/constants"
import PixPaymentPanel from "@modules/order/components/payment-details/pix-payment-panel"

const Review = ({ cart }: { cart: HttpTypes.StoreCart }) => {
  const searchParams = useSearchParams()

  const isOpen = searchParams.get("step") === "review"

  const paidByGiftcard = !!(
    (cart as unknown as Record<string, unknown>)?.gift_cards && ((cart as unknown as Record<string, unknown>)?.gift_cards as unknown[])?.length > 0 && cart?.total === 0
  )

  const previousStepsCompleted =
    cart.shipping_address &&
    (cart.shipping_methods?.length ?? 0) > 0 &&
    (cart.payment_collection || paidByGiftcard)

  // Mercado Pago Pix only: the Payment Brick's onSubmit stored
  // payment_method_id "pix" on the session. Card sessions (same provider)
  // and every other provider never render the Pix panel.
  const pixPaymentSession = cart.payment_collection?.payment_sessions?.find(
    (session) =>
      isMercadoPago(session.provider_id) &&
      session.data?.payment_method_id === "pix"
  )

  // A Pix order is only placed once its charge can actually be paid (or is
  // already paid); otherwise the order would have no payable Pix charge.
  const [pixPlaceOrderAllowed, setPixPlaceOrderAllowed] = useState(false)
  const mercadoPagoBlocked = Boolean(pixPaymentSession) && !pixPlaceOrderAllowed

  return (
    <div className="bg-white">
      <div className="flex flex-row items-center justify-between mb-6">
        <Heading
          level="h2"
          className={clx(
            "flex flex-row text-3xl-regular gap-x-2 items-baseline",
            {
              "opacity-50 pointer-events-none select-none": !isOpen,
            }
          )}
        >
          Review
        </Heading>
      </div>
      {isOpen && previousStepsCompleted && (
        <>
          {pixPaymentSession && (
            <PixPaymentPanel
              cartId={cart.id}
              paymentSessionId={pixPaymentSession.id}
              onPlaceOrderAllowedChange={setPixPlaceOrderAllowed}
            />
          )}
          <div className="flex items-start gap-x-1 w-full mb-6">
            <div className="w-full">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                By clicking the Place Order button, you confirm that you have
                read, understand and accept our Terms of Use, Terms of Sale and
                Returns Policy and acknowledge that you have read Medusa
                Store&apos;s Privacy Policy.
              </Text>
            </div>
          </div>
          <PaymentButton
            cart={cart}
            data-testid="submit-order-button"
            mercadoPagoBlocked={mercadoPagoBlocked}
          />
        </>
      )}
    </div>
  )
}

export default Review
