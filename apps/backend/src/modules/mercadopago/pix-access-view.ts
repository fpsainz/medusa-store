import {
  PIX_TERMINAL_STATUSES,
  type PixDisplayStatus,
  toPixPaymentDto,
} from "./service"

// What a Pix payment capability (ADR-007) may read. Explicit allowlist:
//   - while the charge is awaiting payment AND before its deadline: what is
//     needed to pay (QR, copy-and-paste, ticket link, deadline) plus an
//     opaque charge reference;
//   - otherwise (paid, final, or past the deadline): the status only.
// order_id lets the storefront server check that the capability belongs to
// the order on the page; it is never a credential and the server does not
// forward it to the browser.
export type PixAccessDto = {
  status: PixDisplayStatus
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

// The status is decided in this order: Medusa already authorized the
// session (approved); a final Mercado Pago status (stored or read live) is
// kept; any other state past the deadline, or without a known deadline,
// becomes "expired" — Mercado Pago may take much longer to report it.
export function toPixAccessDto(input: {
  session_status?: string | null
  data: Record<string, unknown>
  order_id: string | null
  now: Date
}): PixAccessDto {
  const view = toPixPaymentDto({ status: input.session_status, data: input.data }, input.now)
  const deadline = parseDeadline(input.data.mercadopago_pix_expires_at)
  const pastDeadline = deadline === undefined || input.now.getTime() >= deadline

  const status: PixDisplayStatus =
    view.status !== "approved" && !PIX_TERMINAL_STATUSES.includes(view.status) && pastDeadline
      ? "expired"
      : view.status

  if (status !== "pending" || deadline === undefined) {
    return { status, order_id: input.order_id }
  }

  return {
    status,
    order_id: input.order_id,
    charge_ref: view.charge_ref,
    qr_code: view.qr_code,
    qr_code_base64: view.qr_code_base64,
    ticket_url: view.ticket_url,
    expires_at: new Date(deadline).toISOString(),
  }
}
