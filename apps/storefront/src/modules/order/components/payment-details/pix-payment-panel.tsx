"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button, Text, clx } from "@modules/common/components/ui"
import Modal from "@modules/common/components/modal"
import ErrorMessage from "@modules/checkout/components/error-message"
import {
  preparePixPayment,
  retrieveCartPixPayment,
  type CartPixPoll,
  type PixCharge,
  type PixChargeStatus,
} from "@lib/data/cart"

type PixPaymentPanelProps = {
  cartId: string
  paymentSessionId: string
  // Tells the Review whether "Place order" may proceed: only while the charge
  // is awaiting payment with real Mercado Pago data, or already approved.
  onPlaceOrderAllowedChange?: (allowed: boolean) => void
}

// Complementary UI refresh only: the webhook is what updates Medusa. Polling
// never creates a charge and never changes any status by itself — it just
// re-reads GET /store/mercadopago/carts/:id/pix. It stops at a terminal
// status, or after a bounded number of polls (then the buyer can refresh
// manually); it is not an expiration timer.
const POLL_INTERVAL_MS = 5000
const MAX_POLLS = 180

const TERMINAL_STATUSES: PixChargeStatus[] = [
  "approved",
  "expired",
  "canceled",
  "failed",
  "rejected",
  "refunded",
  "charged_back",
]

// States in which the charge can no longer be paid and a new one may be
// created for the same session. A paid charge is never regenerated.
const REGENERABLE_STATUSES: PixChargeStatus[] = ["expired", "canceled", "failed", "rejected"]

const STATUS_LABELS: Record<PixChargeStatus, string> = {
  processing: "Preparing your Pix charge…",
  pending: "Awaiting payment",
  approved: "Payment approved",
  expired: "Pix expired",
  canceled: "Pix canceled",
  failed: "Payment failed",
  rejected: "Payment rejected",
  refunded: "Payment refunded",
  charged_back: "Payment charged back",
  unknown: "Status unavailable",
}

// Visual classes copied from Button's "secondary" variant (ui/index.tsx) so
// the ticket_url link matches the starter's design system without nesting
// <Button> inside <a> (invalid: both render interactive/focusable elements).
const secondaryLinkClasses = clx(
  "inline-flex gap-2 items-center justify-center rounded-md font-medium transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
  "bg-white text-black border border-gray-200 hover:bg-gray-50",
  "h-10 px-4",
  "w-full md:w-fit"
)

function hasPayableData(pixCharge: PixCharge): boolean {
  return Boolean(pixCharge.qr_code_base64 || pixCharge.qr_code || pixCharge.ticket_url)
}

function formatExpiration(expiresAt?: string): string | undefined {
  if (!expiresAt) {
    return undefined
  }

  const date = new Date(expiresAt)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : expiresAt
}

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
  const [copied, setCopied] = useState(false)
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
  const isTerminal = cartCompleted || (status ? TERMINAL_STATUSES.includes(status) : false)
  const pollBudgetExhausted = pollCount >= MAX_POLLS

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
    }, POLL_INTERVAL_MS)

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
      hasPayableData(pixCharge) &&
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
    (pixCharge?.status === "pending" && hasPayableData(pixCharge))

  useEffect(() => {
    onPlaceOrderAllowedChange?.(placeOrderAllowed)
  }, [placeOrderAllowed, onPlaceOrderAllowedChange])

  const refreshStatus = async () => {
    applyPoll(await retrieveCartPixPayment(cartId).catch(() => null))
    setPollCount(0)
  }

  const handleCopy = async () => {
    if (!pixCharge?.qr_code) return
    try {
      await navigator.clipboard.writeText(pixCharge.qr_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the copy-paste
      // code and ticket_url link remain visible/manually selectable as
      // fallback, so payment is still completable without this button.
    }
  }

  const expirationLabel = formatExpiration(pixCharge?.expires_at)
  const isPayable =
    !cartCompleted && status === "pending" && pixCharge !== null && hasPayableData(pixCharge)
  const canRegenerate = !cartCompleted && (status ? REGENERABLE_STATUSES.includes(status) : false)

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
        {STATUS_LABELS[pixCharge.status]}
      </Text>
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

              {/* QR is intentionally not rendered inline (unreliable
                  rendering reported in real browsers). It only exists inside
                  this modal — no duplicate <img>, no hidden preload image. */}
              {isPayable && pixCharge.qr_code_base64 && (
                <div className="flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element -- small inline base64 QR, no remote-optimization benefit */}
                  <img
                    src={`data:image/png;base64,${pixCharge.qr_code_base64}`}
                    alt="Pix QR code — scan with your bank's app to pay"
                    width={288}
                    height={288}
                    className="w-64 h-64 md:w-72 md:h-72"
                  />
                </div>
              )}

              {isPayable && pixCharge.qr_code && (
                <div className="flex flex-col gap-2">
                  <Text className="txt-small text-ui-fg-subtle">
                    Pix copy-and-paste code
                  </Text>
                  <div className="flex gap-2 items-start">
                    <Text
                      className="txt-small text-ui-fg-base break-all bg-white border rounded-rounded p-2 flex-1"
                      data-testid="pix-copy-paste-code"
                    >
                      {pixCharge.qr_code}
                    </Text>
                    <Button
                      variant="secondary"
                      onClick={handleCopy}
                      data-testid="pix-copy-button"
                      aria-live="polite"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}

              {isPayable && pixCharge.ticket_url && (
                <a
                  href={pixCharge.ticket_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={secondaryLinkClasses}
                  data-testid="pix-ticket-url-link"
                >
                  Open Pix payment
                </a>
              )}

              {isPayable && expirationLabel && (
                <Text
                  className="txt-small text-ui-fg-subtle"
                  data-testid="pix-expiration"
                >
                  Expires at {expirationLabel}
                </Text>
              )}

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
