"use client"

import { useEffect, useState } from "react"
import { Button, Text } from "@modules/common/components/ui"
import Modal from "@modules/common/components/modal"
import { retrieveOrderPixPayment } from "@lib/data/orders"
import type { PixCharge } from "@lib/util/pix-client"

import PixChargeDetails, {
  PIX_MAX_POLLS,
  PIX_POLL_INTERVAL_MS,
  PIX_STATUS_LABELS,
  PIX_TERMINAL_STATUSES,
  hasPayablePixData,
} from "./pix-charge-details"

type OrderPixPaymentProps = {
  orderId: string
  initialCharge: PixCharge
}

// Pix of the order confirmation page. Follows the charge through a Server
// Action that reads it with this browser's payment capability (ADR-007); the
// capability itself never reaches this component. When the capability stops
// answering (deadline + grace, revoked, another order) the last known status
// stays, without anything payable.
const OrderPixPayment = ({ orderId, initialCharge }: OrderPixPaymentProps) => {
  const [pixCharge, setPixCharge] = useState<PixCharge>(initialCharge)
  const [accessClosed, setAccessClosed] = useState(false)
  const [pollCount, setPollCount] = useState(0)
  const [isQrModalOpen, setIsQrModalOpen] = useState(false)

  const isTerminal = PIX_TERMINAL_STATUSES.includes(pixCharge.status)
  const pollBudgetExhausted = pollCount >= PIX_MAX_POLLS

  useEffect(() => {
    if (isTerminal || accessClosed || pollBudgetExhausted) {
      return
    }

    let cancelled = false

    const timeout = setTimeout(async () => {
      const next = await retrieveOrderPixPayment(orderId).catch(() => undefined)

      if (cancelled) {
        return
      }

      if (next === null) {
        setAccessClosed(true)
        setIsQrModalOpen(false)
      } else if (next) {
        setPixCharge(next)
      }

      setPollCount((count) => count + 1)
    }, PIX_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [orderId, pixCharge, isTerminal, accessClosed, pollBudgetExhausted])

  const isPayable = !accessClosed && pixCharge.status === "pending" && hasPayablePixData(pixCharge)

  useEffect(() => {
    if (!isPayable) {
      setIsQrModalOpen(false)
    }
  }, [isPayable])

  return (
    <div className="flex flex-col gap-2 mt-4" data-testid="pix-order-payment">
      <Text className="txt-medium-plus text-ui-fg-base" data-testid="pix-order-status">
        {PIX_STATUS_LABELS[pixCharge.status]}
      </Text>

      {isPayable && (
        <>
          <Text className="txt-small text-ui-fg-subtle" data-testid="pix-order-pending">
            Your Pix payment has not been confirmed yet.
          </Text>
          <Button
            variant="secondary"
            onClick={() => setIsQrModalOpen(true)}
            className="w-full md:w-fit"
            data-testid="pix-order-view-qr-button"
          >
            View Pix payment
          </Button>
        </>
      )}

      {pixCharge.status === "approved" && (
        <Text className="txt-small text-ui-fg-subtle" data-testid="pix-order-approved">
          We received your Pix payment.
        </Text>
      )}

      {isPayable && (
        <Modal
          isOpen={isQrModalOpen}
          close={() => setIsQrModalOpen(false)}
          size="small"
          data-testid="pix-order-qr-modal"
        >
          <Modal.Title>Pay with Pix</Modal.Title>
          <Modal.Body>
            <div className="flex flex-col gap-4 w-full py-4 overflow-y-auto">
              <PixChargeDetails pixCharge={pixCharge} />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setIsQrModalOpen(false)}
              data-testid="pix-order-qr-modal-close-button"
            >
              Close
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}

export default OrderPixPayment
