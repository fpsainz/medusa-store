"use client"

import { useState } from "react"
import { Button, Text, clx } from "@modules/common/components/ui"
import type { PixCharge, PixChargeStatus } from "@lib/util/pix-client"

// Shared by the checkout Review panel and the order confirmation page.

// Complementary UI refresh only: the webhook is what updates Medusa. Polling
// stops at a terminal status, or after a bounded number of polls; it is not
// an expiration timer.
export const PIX_POLL_INTERVAL_MS = 5000
export const PIX_MAX_POLLS = 180

export const PIX_TERMINAL_STATUSES: PixChargeStatus[] = [
  "approved",
  "expired",
  "canceled",
  "failed",
  "rejected",
  "refunded",
  "charged_back",
]

export const PIX_STATUS_LABELS: Record<PixChargeStatus, string> = {
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

export function hasPayablePixData(pixCharge: PixCharge): boolean {
  return Boolean(pixCharge.qr_code_base64 || pixCharge.qr_code || pixCharge.ticket_url)
}

export function formatPixExpiration(expiresAt?: string): string | undefined {
  if (!expiresAt) {
    return undefined
  }

  const date = new Date(expiresAt)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : expiresAt
}

// What the buyer needs to pay: QR, copy-and-paste code, ticket link and
// deadline. Callers render it only while the charge is payable.
const PixChargeDetails = ({ pixCharge }: { pixCharge: PixCharge }) => {
  const [copied, setCopied] = useState(false)
  const expirationLabel = formatPixExpiration(pixCharge.expires_at)

  const handleCopy = async () => {
    if (!pixCharge.qr_code) return
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

  return (
    <>
      {/* QR is intentionally not rendered inline (unreliable rendering
          reported in real browsers). It only exists inside the caller's
          modal — no duplicate <img>, no hidden preload image. */}
      {pixCharge.qr_code_base64 && (
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

      {pixCharge.qr_code && (
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

      {pixCharge.ticket_url && (
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

      {expirationLabel && (
        <Text className="txt-small text-ui-fg-subtle" data-testid="pix-expiration">
          Expires at {expirationLabel}
        </Text>
      )}
    </>
  )
}

export default PixChargeDetails
