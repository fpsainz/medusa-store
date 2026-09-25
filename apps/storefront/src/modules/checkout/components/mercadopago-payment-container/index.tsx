"use client"

import { Payment, initMercadoPago } from "@mercadopago/sdk-react"
import { HttpTypes } from "@medusajs/types"
import { updateMercadoPagoPaymentSession } from "@lib/data/cart"
import { Text } from "@modules/common/components/ui"
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react"

import PaymentContainer from "../payment-container"

type MercadoPagoPaymentContainerProps = {
  cart: HttpTypes.StoreCart
  paymentProviderId: string
  selectedPaymentOptionId: string | null
  disabled?: boolean
  paymentInfoMap: Record<string, { title: string; icon: JSX.Element }>
  setError: (error: string | null) => void
  setPaymentComplete: (complete: boolean) => void
}

const MercadoPagoPaymentContainer: React.FC<MercadoPagoPaymentContainerProps> = ({
  cart,
  paymentProviderId,
  selectedPaymentOptionId,
  paymentInfoMap,
  disabled = false,
  setError,
  setPaymentComplete,
}) => {
  const publicKey = process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY || ""
  const paymentSession = cart.payment_collection?.payment_sessions?.find(
    (session) =>
      session.provider_id === paymentProviderId && session.status === "pending"
  )
  const isSelectedProvider = selectedPaymentOptionId === paymentProviderId
  const shouldRenderBrick =
    isSelectedProvider && Boolean(publicKey) && Boolean(paymentSession?.id)
  const [isBrickReady, setIsBrickReady] = useState(false)
  const hasInitializedMercadoPago = useRef(false)
  const lastRenderedProviderRef = useRef<string | null>(null)

  const cardInitialization = useMemo(
    () => ({
      amount: Number(cart.total ?? paymentSession?.amount ?? 0),
      payer: {
        email: cart.email ?? "",
      },
    }),
    [cart.total, cart.email, paymentSession?.amount]
  )

  const paymentSessionRef = useRef(paymentSession)
  useEffect(() => {
    paymentSessionRef.current = paymentSession
  }, [paymentSession])

  useEffect(() => {
    if (!publicKey || hasInitializedMercadoPago.current) {
      return
    }

    initMercadoPago(publicKey, { locale: "pt-BR" })
    hasInitializedMercadoPago.current = true
  }, [publicKey])

  useEffect(() => {
    setIsBrickReady(false)

    if (!shouldRenderBrick) {
      lastRenderedProviderRef.current = null
      return
    }

    if (lastRenderedProviderRef.current === paymentProviderId) {
      return
    }

    lastRenderedProviderRef.current = paymentProviderId

    return () => {
      if (typeof window === "undefined") {
        return
      }

      const controller = (
        window as Window & {
          paymentBrickController?: { unmount?: () => void }
        }
      ).paymentBrickController

      controller?.unmount?.()
    }
  }, [shouldRenderBrick, paymentProviderId])

  const onSubmit = useCallback(async (rawArgs: any) => {
    console.log(
      "[MP DEBUG] onSubmit INVOKED",
      JSON.stringify(rawArgs, null, 2)
    )

    const { formData } = rawArgs as {
      selectedPaymentMethod?: string
      formData: {
        token?: string
        payment_method_id: string
        issuer_id?: string
        installments?: number
        transaction_amount?: number
        payer?: {
          email?: string
          identification?: {
            type?: string
            number?: string
          }
        }
      }
    }

    console.log("[MP DEBUG] onSubmit formData:", formData)

    const currentSession = paymentSessionRef.current
    if (!currentSession) {
      setError("Mercado Pago payment session is missing.")
      setPaymentComplete(false)
      return
    }

    if (!publicKey) {
      setError("Missing NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY.")
      setPaymentComplete(false)
      return
    }

    const amount = Number(
      cart.total ?? currentSession.amount ?? formData.transaction_amount ?? 0
    )

    // Pix signal per Mercado Pago's own docs: formData.payment_method_id === "pix"
    // is the confirmed value for a Pix submission from the Payment Brick.
    // selectedPaymentMethod is not used here — its runtime value for Pix is
    // not documented by Mercado Pago, so it is not relied upon.
    const isPix = formData.payment_method_id === "pix"

    const payload = isPix
      ? {
          payment_method_id: "pix",
          amount,
          currency_code: cart.currency_code ?? "BRL",
          cart_id: cart.id,
          payer: {
            email: formData.payer?.email ?? cart.email,
            identification: formData.payer?.identification,
          },
        }
      : {
          card_token: formData.token,
          payment_method_id: formData.payment_method_id,
          issuer_id: formData.issuer_id ?? "",
          installments: Number(formData.installments ?? 1),
          transaction_amount: Number(formData.transaction_amount ?? amount),
          amount,
          currency_code: cart.currency_code ?? "BRL",
          cart_id: cart.id,
          payer: {
            email: formData.payer?.email ?? cart.email,
            identification: formData.payer?.identification,
          },
        }

    console.log("[MP DEBUG] BEFORE SERVER ACTION", {
      paymentSessionId: currentSession.id,
      payload: {
        ...payload,
        payer: {
          ...payload.payer,
          email: payload.payer?.email ? "[MASKED]" : payload.payer?.email,
        },
      },
    })

    await updateMercadoPagoPaymentSession(currentSession.id, payload)
      .then(async (result) => {
        console.log("[MP DEBUG] AFTER SERVER ACTION", result)
        setError(null)
        console.log("[MP FLOW] onSubmit DONE")
        setPaymentComplete(true)
        console.log("[MP FLOW] setPaymentComplete TRUE")
      })
      .catch((err: Error) => {
        console.error("[MP DEBUG] SERVER ACTION ERROR", err)
        setPaymentComplete(false)
        setError(err.message || "Unable to authorize the Mercado Pago payment.")
      })
    }, [
      cart.currency_code,
      cart.email,
      cart.id,
      cart.total,
      publicKey,
      setError,
      setPaymentComplete,
    ])

    const customization = useMemo(
      () => ({
        paymentMethods: {
          creditCard: "all" as const,
          debitCard: "all" as const,
          bankTransfer: "all" as const,
          maxInstallments: 12,
        },
      }),
      []
    )

    const handleReady = useCallback(() => {
      setIsBrickReady(true)
    }, [])

    const handleError = useCallback(
      (error: { message?: string }) => {
        setIsBrickReady(false)
        setPaymentComplete(false)
        setError(error?.message || "Could not load the Mercado Pago form.")
      },
      [setError, setPaymentComplete]
    )

  return (
    <PaymentContainer
      paymentProviderId={paymentProviderId}
      selectedPaymentOptionId={selectedPaymentOptionId}
      paymentInfoMap={paymentInfoMap}
      disabled={disabled}
    >
      {shouldRenderBrick && (
        <div
          className="my-4 transition-all duration-150 ease-in-out"
          aria-busy={!isBrickReady}
        >
          <Text className="txt-medium-plus text-ui-fg-base mb-1">
            Enter your payment details:
          </Text>

          {publicKey ? (
            <Payment
              key={paymentProviderId}
              initialization={cardInitialization}
              customization={customization}
              locale="pt-BR"
              onReady={handleReady}
              onSubmit={onSubmit as any}
              onError={handleError}
            />
          ) : (
            <Text className="txt-medium text-ui-fg-subtle">
              Missing NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY.
            </Text>
          )}
        </div>
      )}
    </PaymentContainer>
  )
}

export default MercadoPagoPaymentContainer
