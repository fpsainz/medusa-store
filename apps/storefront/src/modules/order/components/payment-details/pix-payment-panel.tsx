"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button, Text } from "@modules/common/components/ui"
import Modal from "@modules/common/components/modal"
import ErrorMessage from "@modules/checkout/components/error-message"
import {
  preparePixPayment,
  retrieveCartPixPayment,
  type CartPixPoll,
} from "@lib/data/cart"
import type { PixCharge, PixChargeStatus } from "@lib/util/pix-client"
import PixChargeDetails, {
  PIX_MAX_POLLS,
  PIX_POLL_INTERVAL_MS,
  PIX_STATUS_LABELS,
  PIX_TERMINAL_STATUSES,
  formatPixExpiration,
  hasPayablePixData,
} from "./pix-charge-details"

type PixPaymentPanelProps = {
  cartId: string
  paymentSessionId: string
  // Tells the Review whether "Place order" may proceed: only while the charge
  // is awaiting payment with real Mercado Pago data, or already approved.
  onPlaceOrderAllowedChange?: (allowed: boolean) => void
}

// Polling never creates a charge and never changes any status by itself —
// it just re-reads GET /store/mercadopago/carts/:id/pix (interval, budget and
// terminal statuses are shared with the order page, see pix-charge-details).

// States in which the charge can no longer be paid and a new one may be
// created for the same session. A paid charge is never regenerated.
const REGENERABLE_STATUSES: PixChargeStatus[] = ["expired", "canceled", "failed", "rejected"]

// The Pix charge of the checkout Review. Asks the backend to prepare (create
// or reuse) the Mercado Pago charge once per payment session, shows the real
// QR/copy-paste/ticket/expiration in a modal as soon as they exist, and
// follows the charge's status. It never places the order: "Place order"
// stays the Review's own button.
const PixPaymentPanel = ({
  cartId,
  paymentSessionId,
  onPlaceOrderAllowedChange,
}: PixPaymentPanelProps) => {
  const [pixCharge, setPixCharge] = useState<PixCharge | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPreparing, setIsPreparing] = useState(false)
  const [isQrModalOpen, setIsQrModalOpen] = useState(false)
  const [pollCount, setPollCount] = useState(0)
  // The cart was completed (webhook or another tab) while this Review is
  // open: the charge is no longer shown and "Place order" leads to the order.
  const [cartCompleted, setCartCompleted] = useState(false)

  const preparedSessionRef = useRef<string | null>(null)
  const autoOpenedChargeRef = useRef<string | null>(null)

  const prepare = useCallback(
    async (regenerate: boolean) => {
      setIsPreparing(true)
      setError(null)

      try {
        const next = await preparePixPayment(paymentSessionId, cartId, regenerate)
        setPixCharge(next)
        setPollCount(0)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not prepare the Pix payment.")
      } finally {
        setIsPreparing(false)
      }
    },
    [cartId, paymentSessionId]
  )

  // Prepare once per payment session (the ref also absorbs React's dev-mode
  // double effect; the backend is idempotent regardless).
  useEffect(() => {
    if (preparedSessionRef.current === paymentSessionId) {
      return
    }

    preparedSessionRef.current = paymentSessionId
    void prepare(false)
  }, [paymentSessionId, prepare])

  const applyPoll = useCallback((next: CartPixPoll | null) => {
    if (!next) {
      return
    }

    if (next.cart_completed) {
      setCartCompleted(true)
      setIsQrModalOpen(false)
      return
    }

    setPixCharge(next.charge)
  }, [])

  const status = pixCharge?.status
  const isTerminal = cartCompleted || (status ? PIX_TERMINAL_STATUSES.includes(status) : false)
  const pollBudgetExhausted = pollCount >= PIX_MAX_POLLS

  useEffect(() => {
    if (!pixCharge || isTerminal || pollBudgetExhausted) {
      return
    }

    let cancelled = false

    const timeout = setTimeout(async () => {
      const next = await retrieveCartPixPayment(cartId).catch(() => null)

      if (cancelled) {
        return
      }

      applyPoll(next)
      setPollCount((count) => count + 1)
    }, PIX_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [cartId, pixCharge, isTerminal, pollBudgetExhausted, applyPoll])

  // Open the modal automatically once per Mercado Pago charge, as soon as it
  // is awaiting payment with real data. A regenerated charge (new charge_ref)
  // opens it again; closing it is never undone by a later poll.
  useEffect(() => {
    if (
      !cartCompleted &&
      pixCharge?.status === "pending" &&
      hasPayablePixData(pixCharge) &&
      pixCharge.charge_ref &&
      autoOpenedChargeRef.current !== pixCharge.charge_ref
    ) {
      autoOpenedChargeRef.current = pixCharge.charge_ref
      setIsQrModalOpen(true)
    }
  }, [pixCharge, cartCompleted])

  // "Place order" on a completed cart returns the existing order (Medusa's
  // completeCart is idempotent) and redirects to its confirmation page.
  const placeOrderAllowed =
    cartCompleted ||
    pixCharge?.status === "approved" ||
    (pixCharge?.status === "pending" && hasPayablePixData(pixCharge))

  useEffect(() => {
    onPlaceOrderAllowedChange?.(placeOrderAllowed)
  }, [placeOrderAllowed, onPlaceOrderAllowedChange])

  const refreshStatus = async () => {
    applyPoll(await retrieveCartPixPayment(cartId).catch(() => null))
    setPollCount(0)
  }

  const expirationLabel = formatPixExpiration(pixCharge?.expires_at)
  const isPayable =
    !cartCompleted && status === "pending" && pixCharge !== null && hasPayablePixData(pixCharge)
  // Past the charge's deadline the backend stops sending anything payable,
  // even while Mercado Pago still reports it as pending: a new Pix may then be
  // generated (which cancels the old charge, as Mercado Pago recommends).
  const paymentWindowClosed = !cartCompleted && pixCharge?.payment_window_closed === true
  const canRegenerate =
    !cartCompleted &&
    (paymentWindowClosed || (status ? REGENERABLE_STATUSES.includes(status) : false))

  const statusBlock = cartCompleted ? (
    <div className="flex flex-col gap-1">
      <Text className="txt-medium-plus text-ui-fg-base" data-testid="pix-payment-status">
        This order has already been completed
      </Text>
      <Text className="txt-small text-ui-fg-subtle" data-testid="pix-cart-completed">
        Click &quot;Place order&quot; to see your order.
      </Text>
    </div>
  ) : pixCharge && (
    <div className="flex flex-col gap-1">
      <Text className="txt-medium-plus text-ui-fg-base" data-testid="pix-payment-status">
        {PIX_STATUS_LABELS[pixCharge.status]}
      </Text>
      {paymentWindowClosed && pixCharge.status !== "approved" && (
        <Text className="txt-small text-ui-fg-subtle" data-testid="pix-payment-window-closed">
          The time to pay this Pix has ended. Generate a new Pix to continue.
        </Text>
      )}
      {pixCharge.status === "approved" && (
        <Text className="txt-small text-ui-fg-subtle">
          Click &quot;Place order&quot; to finish your order.
        </Text>
      )}
    </div>
  )

  const regenerateButton = canRegenerate && (
    <Button
      variant="secondary"
      onClick={() => prepare(true)}
      isLoading={isPreparing}
      className="w-full md:w-fit"
      data-testid="pix-regenerate-button"
    >
      Generate new Pix
    </Button>
  )

  return (
    <div
      className="flex flex-col gap-3 mb-6 p-4 border rounded-rounded bg-ui-bg-subtle"
      data-testid="pix-payment-panel"
    >
      <Text className="txt-medium-plus text-ui-fg-base">Pay with Pix</Text>

      {!pixCharge && isPreparing && (
        <Text className="txt-small text-ui-fg-subtle">Preparing your Pix charge…</Text>
      )}

      {statusBlock}

      {isPayable && expirationLabel && (
        <Text className="txt-small text-ui-fg-subtle">Expires at {expirationLabel}</Text>
      )}

      {isPayable && (
        <Button
          variant="secondary"
          onClick={() => setIsQrModalOpen(true)}
          className="w-full md:w-fit"
          data-testid="pix-view-qr-button"
        >
          View Pix payment
        </Button>
      )}

      {regenerateButton}

      {!placeOrderAllowed && (
        <Text className="txt-small text-ui-fg-subtle" data-testid="pix-place-order-blocked">
          &quot;Place order&quot; is available once your Pix charge is ready to be paid.
        </Text>
      )}

      {pixCharge && !isTerminal && pollBudgetExhausted && (
        <Button
          variant="secondary"
          onClick={refreshStatus}
          className="w-full md:w-fit"
          data-testid="pix-refresh-status-button"
        >
          Refresh payment status
        </Button>
      )}

      <ErrorMessage error={error} data-testid="pix-payment-error" />

      {pixCharge && (
        <Modal
          isOpen={isQrModalOpen}
          close={() => setIsQrModalOpen(false)}
          size="small"
          data-testid="pix-qr-modal"
        >
          <Modal.Title>Pay with Pix</Modal.Title>
          <Modal.Body>
            <div className="flex flex-col gap-4 w-full py-4 overflow-y-auto">
              {statusBlock}

              {isPayable && <PixChargeDetails pixCharge={pixCharge} />}

              {regenerateButton}
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setIsQrModalOpen(false)}
              data-testid="pix-qr-modal-close-button"
            >
              Close
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}

export default PixPaymentPanel
