import { type PixDisplayStatus, toPixPaymentDto } from "./service"

// What a Pix payment capability (ADR-007) may read. Explicit allowlist:
//   - `status`: the real, provider-derived status (toPixPaymentDto), never
//     rewritten because of the local deadline;
//   - `payment_window_closed`: application policy (ADR-008/ADR-009), true
//     once the charge's stored deadline has passed (or none is known);
//   - payable data (QR, copy-and-paste, ticket link, deadline) plus an opaque
//     charge reference only while the status is pending AND the window is
//     open.
// order_id lets the storefront server check that the capability belongs to
// the order on the page; it is never a credential and the server does not
// forward it to the browser.
export type PixAccessDto = {
  status: PixDisplayStatus
  payment_window_closed: boolean
  order_id: string | null
  charge_ref?: string
  qr_code?: string
  qr_code_base64?: string
  ticket_url?: string
  expires_at?: string
}

function parseDeadline(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

export function toPixAccessDto(input: {
  session_status?: string | null
  data: Record<string, unknown>
  order_id: string | null
  now: Date
}): PixAccessDto {
  const view = toPixPaymentDto({ status: input.session_status, data: input.data }, input.now)
  const deadline = parseDeadline(input.data.mercadopago_pix_expires_at)
  // Without a known deadline the window is treated as closed: nothing payable
  // is ever exposed without a bound.
  const paymentWindowClosed = deadline === undefined || input.now.getTime() >= deadline

  if (view.status !== "pending" || paymentWindowClosed || deadline === undefined) {
    return { status: view.status, payment_window_closed: paymentWindowClosed, order_id: input.order_id }
  }

  return {
    status: view.status,
    payment_window_closed: false,
    order_id: input.order_id,
    charge_ref: view.charge_ref,
    qr_code: view.qr_code,
    qr_code_base64: view.qr_code_base64,
    ticket_url: view.ticket_url,
    expires_at: new Date(deadline).toISOString(),
  }
}
