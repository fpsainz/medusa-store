import { createHash } from 'node:crypto'

import { AbstractPaymentProvider, BigNumber, MedusaError } from '@medusajs/framework/utils'
import { MercadoPagoConfig, Order } from 'mercadopago'

type MercadoPagoProviderOptions = {
  access_token?: string
}

type PaymentData = Record<string, unknown>

// Card payment types accepted in session.data.payment_type_id, exactly as the
// Orders API expects them in payment_method.type. Collected from the Payment
// Brick's additionalData.paymentTypeId (see ADR-005). prepaid_card is
// deliberately out of this contract.
export type CardPaymentType = 'credit_card' | 'debit_card'

export function isCardPaymentType(value: unknown): value is CardPaymentType {
  return value === 'credit_card' || value === 'debit_card'
}

// Presentation status of a Mercado Pago Pix charge, derived from the Orders
// API's native order/transaction statuses. It is NOT a Medusa status: the
// Medusa Payment Session / Payment / Order keep their own states. The native
// Mercado Pago statuses are returned alongside it in the DTO.
export type PixDisplayStatus =
  | 'processing'
  | 'pending'
  | 'approved'
  | 'expired'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'refunded'
  | 'charged_back'
  | 'unknown'

export const PIX_TERMINAL_STATUSES: readonly PixDisplayStatus[] = [
  'approved',
  'expired',
  'canceled',
  'failed',
  'rejected',
  'refunded',
  'charged_back',
]

// Payment window of every Pix charge, sent as
// transactions.payments[].expiration_time (ISO 8601 duration; Mercado Pago
// accepts 30 minutes to 30 days and defaults to 24 hours when omitted).
// Business decision recorded in ADR-007.
export const PIX_EXPIRATION_TIME = 'PT1H'
const PIX_EXPIRATION_MS = 60 * 60 * 1000

function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

// Conservative deadline of a Pix charge: the earliest of
//   - when this process started the create request + the payment window
//     (never later than Mercado Pago's own creation time for a new Order);
//   - the Order's created_date + the payment window, when returned (covers
//     an idempotent replay that returns an Order created earlier);
//   - any absolute date the response carries (date_of_expiration, or an
//     expiration_time that is a date-time rather than a duration).
// Whether the Orders API returns an absolute date is not confirmed, so it is
// only used when present and valid, never required.
export function computePixDeadline(input: {
  requestStartedAt: number
  orderCreatedDate?: string
  dateOfExpiration?: string
  expirationTime?: string
}): string {
  const createdAt = parseInstant(input.orderCreatedDate)
  const candidates = [
    input.requestStartedAt + PIX_EXPIRATION_MS,
    createdAt !== undefined ? createdAt + PIX_EXPIRATION_MS : undefined,
    parseInstant(input.dateOfExpiration),
    parseInstant(input.expirationTime),
  ].filter((value): value is number => value !== undefined)

  return new Date(Math.min(...candidates)).toISOString()
}

// Session data fields that describe the Mercado Pago Pix Order currently
// attached to a Payment Session. Removed together when that Order stops
// being the session's charge (payment method switched, or replaced).
const PIX_ORDER_FIELDS = [
  'mercadopago_order_id',
  'mercadopago_order_status',
  'mercadopago_order_status_detail',
  'mercadopago_order_total_amount',
  'mercadopago_order_payment_method',
  'mercadopago_payment_id',
  'mercadopago_payment_status',
  'mercadopago_status_detail',
  'mercadopago_pix_qr_code',
  'mercadopago_pix_qr_code_base64',
  'mercadopago_pix_ticket_url',
  'mercadopago_pix_date_of_expiration',
  'mercadopago_pix_expiration_time',
  'mercadopago_pix_expires_at',
  'mercadopago_pix_idempotency_key',
  'mercadopago_external_reference',
] as const

// Explicit Orders API status mapping (order status first, since it is the
// aggregate; transaction status as fallback). Unknown values map to
// 'unknown' — never silently to 'pending'.
export function normalizePixStatus(input: {
  orderStatus?: string
  orderStatusDetail?: string
  paymentStatus?: string
  paymentStatusDetail?: string
}): PixDisplayStatus {
  const status = (input.orderStatus || input.paymentStatus || '').toLowerCase()

  switch (status) {
    case 'processed':
    case 'approved':
    case 'accredited':
      return 'approved'
    case 'action_required':
      return 'pending'
    case 'created':
    case 'processing':
    case 'in_process':
    case 'in_review':
      return 'processing'
    case 'expired':
      return 'expired'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'failed':
      return 'failed'
    case 'rejected':
      return 'rejected'
    case 'refunded':
      return 'refunded'
    case 'charged_back':
      return 'charged_back'
    default:
      return 'unknown'
  }
}

export type PixPaymentDto = {
  status: PixDisplayStatus
  // Application policy, not a Mercado Pago status: true once the charge's
  // stored deadline (mercadopago_pix_expires_at) has passed.
  payment_window_closed?: boolean
  charge_ref?: string
  qr_code?: string
  qr_code_base64?: string
  ticket_url?: string
  expires_at?: string
}

// Formats a Medusa monetary value as the Orders API's 2-decimal string. The
// Payment Module passes amounts as BigNumberInput (number, string, BigNumber
// or the raw { value, precision } it stores), so Number() is not enough:
// Number({ value, precision }) is NaN. Returns undefined for anything that is
// not a finite positive amount.
function toPositiveDecimalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  let amount: BigNumber
  try {
    amount = new BigNumber(value as ConstructorParameters<typeof BigNumber>[0])
  } catch {
    return undefined
  }

  const bigNumber = amount.bigNumber
  if (!bigNumber || !bigNumber.isFinite() || !bigNumber.isGreaterThan(0)) {
    return undefined
  }

  return bigNumber.toFixed(2)
}

// X-Idempotency-Key accepts 1 to 128 characters (Orders API integration
// errors: invalid_idempotency_key_length).
const MAX_IDEMPOTENCY_KEY_LENGTH = 128

// Deterministic JSON: object keys sorted at every level, array order kept,
// undefined properties dropped (as JSON.stringify does). The same body always
// serializes the same way, whatever order its keys were built or read in
// (session.data comes back from a jsonb column).
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)

    return `{${entries.join(',')}}`
  }

  return JSON.stringify(value)
}

function getStringField(data: PaymentData | null | undefined, key: string): string | undefined {
  const value = data?.[key]
  return typeof value === 'string' ? value : undefined
}

// Opaque reference of the current Pix charge, so the storefront can tell a
// regenerated charge apart (the Review opens the QR once per charge) without
// ever receiving the Mercado Pago Order id.
function toChargeRef(orderId: string | undefined): string | undefined {
  return orderId
    ? createHash('sha256').update(`pix-charge:${orderId}`).digest('hex').slice(0, 16)
    : undefined
}

// The only Pix surface the storefront reads: the display status plus what is
// needed to pay. Never the payer, identification, card data, idempotency
// keys, Mercado Pago ids, native statuses or anything else in session.data.
// A session Medusa has already authorized (webhook or completeCart) is
// 'approved' regardless of the last stored Mercado Pago status.
//
// Once the charge's deadline has passed, the QR, copy-and-paste code and
// ticket link are no longer returned, whatever Mercado Pago still reports:
// its status can stay action_required for minutes after the due date, and
// Mercado Pago recommends cancelling charges not paid by then. `status` stays
// the real, provider-derived one (never turned into expired/canceled here);
// payment_window_closed says the window is over. Charges without a stored
// deadline (created before it existed) keep the previous behaviour.
export function toPixPaymentDto(
  session: {
    status?: string | null
    data?: PaymentData | null
  },
  now: Date = new Date()
): PixPaymentDto {
  const data = session.data ?? undefined
  const orderStatus = getStringField(data, 'mercadopago_order_status')
  const orderStatusDetail = getStringField(data, 'mercadopago_order_status_detail')
  const paymentStatus = getStringField(data, 'mercadopago_payment_status')
  const paymentStatusDetail = getStringField(data, 'mercadopago_status_detail')
  const sessionStatus = session.status ?? 'pending'

  const status: PixDisplayStatus =
    sessionStatus === 'authorized'
      ? 'approved'
      : normalizePixStatus({ orderStatus, orderStatusDetail, paymentStatus, paymentStatusDetail })

  const deadline = parseInstant(getStringField(data, 'mercadopago_pix_expires_at'))
  const windowClosed = deadline !== undefined && now.getTime() >= deadline

  return {
    status,
    ...(windowClosed ? { payment_window_closed: true } : {}),
    charge_ref: toChargeRef(getStringField(data, 'mercadopago_order_id')),
    qr_code: windowClosed ? undefined : getStringField(data, 'mercadopago_pix_qr_code'),
    qr_code_base64: windowClosed ? undefined : getStringField(data, 'mercadopago_pix_qr_code_base64'),
    ticket_url: windowClosed ? undefined : getStringField(data, 'mercadopago_pix_ticket_url'),
    expires_at:
      getStringField(data, 'mercadopago_pix_expires_at') ??
      getStringField(data, 'mercadopago_pix_date_of_expiration') ??
      getStringField(data, 'mercadopago_pix_expiration_time'),
  }
}

// True when the session data carries a Mercado Pago Pix Order. Card Orders
// also store mercadopago_order_id, so the Pix marker (or Pix-only fields
// written by older Pix sessions) is what distinguishes them.
export function hasPixOrderData(data: PaymentData): boolean {
  return (
    typeof data.mercadopago_order_id === 'string' &&
    data.mercadopago_order_id.length > 0 &&
    (data.mercadopago_order_payment_method === 'pix' ||
      typeof data.mercadopago_pix_qr_code === 'string' ||
      typeof data.mercadopago_pix_ticket_url === 'string')
  )
}

type PixOrderLike = {
  id?: string
  status?: string
  status_detail?: string
  total_amount?: string
  created_date?: string
}

type PixOrderPaymentLike = {
  id?: string
  status?: string
  status_detail?: string
  date_of_expiration?: string
  expiration_time?: string
  payment_method?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string }
}

// Builds the non-destructive data merge shared by Pix order creation,
// preparation, re-authorization and the storefront status read: spreads
// the existing session data first (never removing card_token/payer/
// installments or anything else already there), then adds/overwrites only the Mercado Pago fields that are
// actually present in this Order response. Never writes a key with an
// undefined value. qr_code_base64 is persisted as-is even when it's an
// empty string (sandbox behavior), never substituted with another value.
// Expiration is persisted under the exact field name the API actually
// returned (date_of_expiration and/or expiration_time), never invented
// for the one that's absent.
export function mergePixOrderData(
  data: PaymentData,
  order: PixOrderLike,
  payment?: PixOrderPaymentLike
): PaymentData {
  const paymentMethod = payment?.payment_method

  return {
    ...data,
    mercadopago_order_payment_method: 'pix',
    ...(order.id !== undefined ? { mercadopago_order_id: order.id } : {}),
    ...(order.total_amount !== undefined
      ? { mercadopago_order_total_amount: order.total_amount }
      : {}),
    ...(order.status !== undefined ? { mercadopago_order_status: order.status } : {}),
    ...(order.status_detail !== undefined
      ? { mercadopago_order_status_detail: order.status_detail }
      : {}),
    ...(payment?.id !== undefined ? { mercadopago_payment_id: payment.id } : {}),
    ...(payment?.status !== undefined ? { mercadopago_payment_status: payment.status } : {}),
    ...(payment?.status_detail !== undefined
      ? { mercadopago_status_detail: payment.status_detail }
      : {}),
    ...(paymentMethod?.qr_code !== undefined ? { mercadopago_pix_qr_code: paymentMethod.qr_code } : {}),
    ...(paymentMethod?.qr_code_base64 !== undefined
      ? { mercadopago_pix_qr_code_base64: paymentMethod.qr_code_base64 }
      : {}),
    ...(paymentMethod?.ticket_url !== undefined
      ? { mercadopago_pix_ticket_url: paymentMethod.ticket_url }
      : {}),
    ...(payment?.date_of_expiration !== undefined
      ? { mercadopago_pix_date_of_expiration: payment.date_of_expiration }
      : {}),
    ...(payment?.expiration_time !== undefined
      ? { mercadopago_pix_expiration_time: payment.expiration_time }
      : {}),
  }
}

class MercadoPagoPaymentProviderService extends AbstractPaymentProvider<MercadoPagoProviderOptions> {
  static identifier = 'mercadopago'

  static validateOptions(options: Record<string, any>) {
    if (!options?.access_token || typeof options.access_token !== 'string') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: access_token is required'
      )
    }
  }

  protected readonly client: MercadoPagoConfig
  protected readonly orderClient: Order

  constructor(container: Record<string, unknown>, options: MercadoPagoProviderOptions) {
    super(container, options)

    const accessToken = options.access_token

    if (!accessToken || typeof accessToken !== 'string') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: access_token is required'
      )
    }

    this.client = new MercadoPagoConfig({ accessToken })
    this.orderClient = new Order(this.client)
  }

  private getDataObject(input: any): PaymentData {
    return input?.data && typeof input.data === 'object' ? (input.data as PaymentData) : {}
  }

  private getAmount(value: unknown, fallbackLabel: string): number {
    const amount = Number(value)

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Mercado Pago: ${fallbackLabel} must be a positive number.`
      )
    }

    return amount
  }

  private getIdempotencyKey(data: PaymentData, context?: Record<string, unknown>): string {
    const candidate =
      (typeof data.mercadopago_idempotency_key === 'string' && data.mercadopago_idempotency_key) ||
      (typeof context?.idempotency_key === 'string' && context.idempotency_key) ||
      (typeof data.idempotency_key === 'string' && data.idempotency_key)

    if (candidate) {
      return candidate
    }

    const stableIdentifier =
      (typeof data.cart_id === 'string' && data.cart_id) ||
      (typeof data.payment_session_id === 'string' && data.payment_session_id) ||
      (typeof data.id === 'string' && data.id) ||
      (typeof context?.cart_id === 'string' && context.cart_id) ||
      (typeof context?.payment_session_id === 'string' && context.payment_session_id) ||
      'mercadopago-operation'

    const amount = this.getAmount(data.amount ?? data.transaction_amount ?? 0, 'payment amount')
    const currency = typeof data.currency_code === 'string' ? data.currency_code : 'BRL'

    return createHash('sha256')
      .update(`${stableIdentifier}:${amount}:${currency}`)
      .digest('hex')
  }

  private getStatusFromGateway(paymentStatus?: string, orderStatus?: string): 'captured' | 'authorized' | 'pending' | 'canceled' | 'error' | 'requires_more' {
    const normalizedPaymentStatus = paymentStatus?.toLowerCase() ?? ''
    const normalizedOrderStatus = orderStatus?.toLowerCase() ?? ''

    if (
      normalizedPaymentStatus === 'processed' ||
      normalizedPaymentStatus === 'approved' ||
      normalizedOrderStatus === 'processed' ||
      normalizedOrderStatus === 'approved'
    ) {
      return 'captured'
    }

    if (
      normalizedPaymentStatus === 'authorized' ||
      normalizedOrderStatus === 'authorized'
    ) {
      return 'authorized'
    }

    if (
      normalizedPaymentStatus === 'pending' ||
      normalizedPaymentStatus === 'in_process' ||
      normalizedOrderStatus === 'pending' ||
      normalizedOrderStatus === 'in_process'
    ) {
      return 'pending'
    }

    if (
      normalizedPaymentStatus === 'cancelled' ||
      normalizedPaymentStatus === 'canceled' ||
      normalizedOrderStatus === 'cancelled' ||
      normalizedOrderStatus === 'canceled'
    ) {
      return 'canceled'
    }

    if (
      normalizedPaymentStatus === 'rejected' ||
      normalizedPaymentStatus === 'failed' ||
      normalizedPaymentStatus === 'error' ||
      normalizedPaymentStatus === 'declined'
    ) {
      return 'error'
    }

    if (
      normalizedPaymentStatus === 'in_mediation' ||
      normalizedPaymentStatus === 'requires_more' ||
      normalizedOrderStatus === 'requires_more'
    ) {
      return 'requires_more'
    }

    return 'pending'
  }

  // Discriminates a Pix session from card/debit using only explicit
  // signals present in the data, never by absence of card fields (see
  // getPixSignals() below for exactly which properties count).
  //
  // paymentType === 'bank_transfer' is treated as an independent Pix
  // signal in this revision: the future Payment Brick (Payment component,
  // not CardPayment) will send this value for the Pix path, and the
  // backend must recognize it on its own, without also requiring
  // payment_method_id/payment_method.id to be present.
  //
  // If any explicit Pix signal AND any explicit non-Pix signal are both
  // present at the same time, that's inconsistent data from the caller
  // (e.g. a stale card payment_method_id left over from a previous
  // selection, sent alongside a new paymentType='bank_transfer') — this
  // throws synchronously, before any external call, rather than silently
  // picking one interpretation.
  private isPixSession(data: PaymentData): boolean {
    const { hasPixSignal, hasNonPixSignal } = this.getPixSignals(data)

    if (hasPixSignal && hasNonPixSignal) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: Inconsistent Mercado Pago payment method data'
      )
    }

    return hasPixSignal
  }

  // Extracts explicit Pix / non-Pix signals from session data, per the Pix
  // discriminator contract:
  //
  // Pix signals:
  //   - data.paymentType === 'bank_transfer'
  //   - data.payment_method_id === 'pix'
  //   - data.payment_method?.id === 'pix'
  //
  // Non-Pix signals (ONLY these, never absence of a field, never
  // card_token, never installments, never payer, never any other generic
  // field):
  //   - data.payment_method_id is present AND !== 'pix'
  //   - data.payment_method?.id is present AND !== 'pix'
  private getPixSignals(data: PaymentData): { hasPixSignal: boolean; hasNonPixSignal: boolean } {
    const paymentMethod = data.payment_method
    const paymentMethodId =
      paymentMethod && typeof paymentMethod === 'object'
        ? (paymentMethod as Record<string, unknown>).id
        : undefined

    const hasPixSignal =
      data.paymentType === 'bank_transfer' ||
      data.payment_method_id === 'pix' ||
      paymentMethodId === 'pix'

    const hasNonPixSignal =
      (data.payment_method_id !== undefined && data.payment_method_id !== 'pix') ||
      (paymentMethodId !== undefined && paymentMethodId !== 'pix')

    return { hasPixSignal, hasNonPixSignal }
  }

  // Maps a Pix Order's native Orders API status to the Medusa Payment
  // Session status authorizePayment must return. Card/debit never call this
  // (they keep getStatusFromGateway()). Every Orders API status has an
  // explicit mapping; an unrecognized one throws instead of silently
  // becoming 'pending'.
  private resolvePixStatus(
    paymentStatus?: string,
    paymentStatusDetail?: string,
    orderStatus?: string,
    orderStatusDetail?: string
  ): 'captured' | 'canceled' | 'error' | 'pending_authorization' {
    const display = normalizePixStatus({
      orderStatus,
      orderStatusDetail,
      paymentStatus,
      paymentStatusDetail,
    })

    switch (display) {
      case 'approved':
        return 'captured'
      // Charge created and awaiting the buyer's transfer (action_required /
      // waiting_transfer), or still being processed asynchronously: the
      // outcome arrives later through the webhook.
      case 'pending':
      case 'processing':
        return 'pending_authorization'
      case 'expired':
      case 'canceled':
      case 'refunded':
      case 'charged_back':
        return 'canceled'
      case 'failed':
      case 'rejected':
        return 'error'
      default:
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `Mercado Pago: unrecognized Pix order status "${orderStatus ?? paymentStatus ?? ''}".`
        )
    }
  }

  private isSameAmount(orderAmount: unknown, sessionAmount: unknown): boolean {
    // The Orders API always returns total_amount; when a response lacks it
    // there is nothing to compare against, so it is not treated as a
    // mismatch.
    if (orderAmount === undefined || orderAmount === null || orderAmount === '') {
      return true
    }

    return Number(orderAmount).toFixed(2) === Number(sessionAmount).toFixed(2)
  }

  // Idempotency key for creating a card Order (ADR-014). The Orders API
  // answers a reused key with the original result only when the body is the
  // same, and with 409 idempotency_key_already_used when it differs. So the
  // key is derived from the session's base key (never replacing it) and the
  // canonical body actually sent: a retry of the same attempt rebuilds the
  // same body from the persisted session data and gets the same key, while a
  // new attempt (new card token, installments, payer...) gets a new one.
  private getCardOrderIdempotencyKey(baseKey: string, body: Record<string, unknown>): string {
    const bodyHash = createHash('sha256').update(canonicalJson(body)).digest('hex')

    return createHash('sha256')
      .update(`${baseKey}:card:${bodyHash}`)
      .digest('hex')
  }

  // Idempotency key for creating a Pix Order. Derived from (never replacing)
  // the session's existing key, so it cannot collide with a card Order key
  // or a Pix Order created earlier for the same session. The amount is part
  // of it, and the generation changes on every replacement, so a regenerated
  // Pix never gets back the expired Order Mercado Pago already associated
  // with the previous key.
  private getPixIdempotencyKey(data: PaymentData, amount: number, generation: number, context?: Record<string, unknown>): string {
    const baseKey = this.getIdempotencyKey({ ...data, amount }, context)

    return createHash('sha256')
      .update(`${baseKey}:pix:${amount.toFixed(2)}:${generation}`)
      .digest('hex')
  }

  private withoutPixOrder(data: PaymentData): PaymentData {
    const next: PaymentData = { ...data }

    for (const field of PIX_ORDER_FIELDS) {
      delete next[field]
    }

    return next
  }

  private async fetchPixDisplayStatus(orderId: string): Promise<PixDisplayStatus> {
    const order = await this.orderClient.get({ id: orderId })
    const payment = order.transactions?.payments?.[0]

    return normalizePixStatus({
      orderStatus: order.status,
      orderStatusDetail: order.status_detail,
      paymentStatus: payment?.status,
      paymentStatusDetail: payment?.status_detail,
    })
  }

  // Makes sure the Pix Order attached to this session can no longer be paid.
  // Pending charges are cancelled through the Orders API; charges already in
  // a terminal state need nothing. A paid charge is never silently discarded
  // (that would leave a captured Pix without any session): the caller gets
  // an error instead. Returns the Orders API response when a cancellation was
  // sent, undefined otherwise.
  private async invalidatePixOrder(
    data: PaymentData,
    knownDisplay?: PixDisplayStatus
  ): Promise<Awaited<ReturnType<Order['cancel']>> | undefined> {
    const orderId = data.mercadopago_order_id as string
    const display = knownDisplay ?? (await this.fetchPixDisplayStatus(orderId))

    if (display === 'approved') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Mercado Pago: this Pix charge has already been paid and cannot be discarded.'
      )
    }

    if (display !== 'pending' && display !== 'processing') {
      return undefined
    }

    const pixKey =
      typeof data.mercadopago_pix_idempotency_key === 'string'
        ? data.mercadopago_pix_idempotency_key
        : orderId

    return this.orderClient.cancel({
      id: orderId,
      requestOptions: {
        idempotencyKey: createHash('sha256').update(`${pixKey}:cancel`).digest('hex'),
      },
    })
  }

  // The Medusa order holding this still-pending Pix is being cancelled
  // (cancel-order-with-pending-pix workflow before the core, ADR-013; or
  // cancelOrderWorkflow's orderCanceled hook, ADR-012). The Order is read
  // right before acting: a paid charge throws NOT_ALLOWED, so the order is
  // not cancelled instead of leaving a paid Pix on a cancelled order; a charge that can no longer be paid is left as it is; a payable one
  // is cancelled on Mercado Pago. The session ends 'canceled', with the
  // Order's real status in its data.
  private async cancelPixOrderForOrderCancellation(data: PaymentData): Promise<any> {
    if (!hasPixOrderData(data)) {
      return { data }
    }

    const order = await this.orderClient.get({ id: data.mercadopago_order_id as string })
    const payment = order.transactions?.payments?.[0]
    const refreshed = this.buildPixOrderData(data, order, payment)
    const display = normalizePixStatus({
      orderStatus: order.status,
      orderStatusDetail: order.status_detail,
      paymentStatus: payment?.status,
      paymentStatusDetail: payment?.status_detail,
    })

    // An unrecognized status is never taken as safe to leave behind
    // (invariant 9): the order cancellation is refused instead.
    if (display === 'unknown') {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Mercado Pago: unrecognized Pix order status "${order.status ?? payment?.status ?? ''}".`
      )
    }

    const canceled = await this.invalidatePixOrder(refreshed, display)

    return {
      status: 'canceled',
      data: canceled
        ? this.buildPixOrderData(refreshed, canceled, canceled.transactions?.payments?.[0])
        : refreshed,
    }
  }

  // Review-time preparation of the Pix charge. Reuses the session's Pix
  // Order while it is still payable for the same amount; otherwise
  // invalidates it and creates a new one. A paid charge is returned as-is
  // and never replaced. Always returns session status 'pending' for a
  // payable charge: the session is only authorized by authorizePayment
  // (completeCart) or by the webhook, never by this preparation.
  private async preparePixOrder(data: PaymentData, input: any, forceNew: boolean): Promise<any> {
    if (hasPixOrderData(data)) {
      const orderId = data.mercadopago_order_id as string
      const order = await this.orderClient.get({ id: orderId })
      const payment = order.transactions?.payments?.[0]
      const refreshed = this.buildPixOrderData(data, order, payment)
      const display = normalizePixStatus({
        orderStatus: order.status,
        orderStatusDetail: order.status_detail,
        paymentStatus: payment?.status,
        paymentStatusDetail: payment?.status_detail,
      })

      if (display === 'approved') {
        return { data: refreshed }
      }

      const reusable =
        !forceNew &&
        (display === 'pending' || display === 'processing') &&
        this.isSameAmount(order.total_amount, data.amount)

      if (reusable) {
        return { status: 'pending', data: refreshed }
      }

      await this.invalidatePixOrder(refreshed, display)
      const created = await this.createPixOrder(this.withoutPixOrder(refreshed), input)

      return { status: 'pending', data: created.data }
    }

    const created = await this.createPixOrder(data, input)

    return { status: 'pending', data: created.data }
  }

  private buildPixOrderData(
    data: PaymentData,
    order: PixOrderLike,
    payment?: PixOrderPaymentLike
  ): PaymentData {
    return mergePixOrderData(data, order, payment)
  }

  // First Pix authorization: no mercadopago_order_id in session data yet.
  // Creates the Order via POST /v1/orders with payment_method {id: 'pix',
  // type: 'bank_transfer'}, no token, no installments, no issuer_id (none
  // of those apply to Pix). Reuses the same amount/idempotency-key
  // machinery already used by the card path (getAmount, getIdempotencyKey
  // with context.idempotency_key === session.id from Medusa), so retries of
  // this same call reuse the same idempotency key rather than generating a
  // new one.
  private async createPixOrder(data: PaymentData, input: any): Promise<any> {
    const amount = this.getAmount(data.amount ?? data.transaction_amount ?? input?.amount, 'transaction amount')
    const cartId = typeof data.cart_id === 'string' && data.cart_id ? data.cart_id : undefined
    const payer = data.payer && typeof data.payer === 'object' ? data.payer : undefined
    const idempotencyKey = this.getIdempotencyKey({ ...data, amount }, input?.context)
    // Each Pix Order created for this session gets the next generation, so
    // a replacement never reuses the key of the Order it replaces. A retry
    // after a failed create reuses the same generation (it was never
    // persisted), and therefore the same key.
    const generation =
      typeof data.mercadopago_pix_generation === 'number' ? data.mercadopago_pix_generation + 1 : 0
    const pixIdempotencyKey = this.getPixIdempotencyKey(data, amount, generation, input?.context)

    if (!payer || typeof payer !== 'object') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: payer is required to create the Pix Order.'
      )
    }

    if (!cartId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: cart_id is required to create the Pix Order.'
      )
    }

    const requestStartedAt = Date.now()
    const order = await this.orderClient.create({
      body: {
        type: 'online',
        external_reference: cartId,
        total_amount: amount.toFixed(2),
        currency: 'BRL',
        processing_mode: 'automatic',
        description: `Medusa cart ${cartId}`,
        payer,
        transactions: {
          payments: [
            {
              amount: amount.toFixed(2),
              payment_method: {
                id: 'pix',
                type: 'bank_transfer',
              },
              expiration_time: PIX_EXPIRATION_TIME,
            },
          ],
        },
      },
      requestOptions: {
        idempotencyKey: pixIdempotencyKey,
      },
    })

    if (!order.id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'Mercado Pago: order ID was not returned by the API.'
      )
    }

    const payment = order.transactions?.payments?.[0]

    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'Mercado Pago: payment was not returned in the order response.'
      )
    }

    const status = this.resolvePixStatus(
      payment.status,
      payment.status_detail,
      order.status,
      order.status_detail
    )

    return {
      status,
      data: {
        ...this.buildPixOrderData(data, order, payment),
        mercadopago_external_reference: cartId,
        mercadopago_idempotency_key: idempotencyKey,
        mercadopago_pix_idempotency_key: pixIdempotencyKey,
        mercadopago_pix_generation: generation,
        mercadopago_pix_expires_at: computePixDeadline({
          requestStartedAt,
          orderCreatedDate: order.created_date,
          dateOfExpiration: payment.date_of_expiration,
          expirationTime: payment.expiration_time,
        }),
      },
    }
  }

  // Second Pix authorization: mercadopago_order_id already present in
  // session data (Medusa only reaches here when no Payment record exists
  // yet, per authorizePaymentSession's own idempotency guard (see the
  // report). No new Order is created; the existing one is read to find out
  // whether the buyer has completed the Pix transfer yet.
  private async reauthorizePixOrder(data: PaymentData, orderId: string): Promise<any> {
    const order = await this.orderClient.get({ id: orderId })
    const payment = order.transactions?.payments?.[0]

    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'Mercado Pago: payment not found in the order.'
      )
    }

    // The session amount is fixed for its lifetime (Medusa deletes and
    // recreates sessions when the cart total changes), so a Pix Order for a
    // different amount can never be the charge that authorizes it.
    if (data.amount !== undefined && !this.isSameAmount(order.total_amount, data.amount)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: the Pix charge amount does not match the payment session amount.'
      )
    }

    const status = this.resolvePixStatus(
      payment.status,
      payment.status_detail,
      order.status,
      order.status_detail
    )

    return {
      status,
      data: this.buildPixOrderData(data, order, payment),
    }
  }

  private async authorizePix(data: PaymentData, input: any): Promise<any> {
    const existingOrderId =
      typeof data.mercadopago_order_id === 'string' && data.mercadopago_order_id
        ? data.mercadopago_order_id
        : undefined

    if (existingOrderId) {
      return this.reauthorizePixOrder(data, existingOrderId)
    }

    return this.createPixOrder(data, input)
  }

  async initiatePayment(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const currency = (input?.currency_code ?? data.currency_code ?? 'BRL').toString().toUpperCase()
    const amount = this.getAmount(input?.amount ?? data.amount ?? 0, 'payment amount')
    const cartId =
      typeof data.cart_id === 'string' && data.cart_id ? data.cart_id : 'mercadopago-payment-session'
    const idempotencyKey = this.getIdempotencyKey({ ...data, amount, currency_code: currency }, input?.context)

    return {
      id: cartId,
      data: {
        ...data,
        amount: amount.toFixed(2),
        currency_code: currency,
        mercadopago_status: 'prepared',
        mercadopago_idempotency_key: idempotencyKey,
        mercadopago_orders_api: {
          endpoint: '/v1/orders',
          method: 'POST',
          headers: {
            'X-Idempotency-Key': idempotencyKey,
          },
        },
      },
    }
  }

  // `mercadopago_pix_action` is a transient instruction set only by the
  // POST /store/mercadopago/payment-sessions/:id/pix route (the storefront's
  // session update route drops it via its allowlist). It is never persisted.
  //
  // - No action, no Pix Order attached: same behavior as before (card data
  //   and Pix method selection are just stored).
  // - No action, Pix Order attached, session still Pix: kept as-is.
  // - No action, Pix Order attached, session switched to another method:
  //   the Pix Order is invalidated and detached from the session.
  // - 'prepare': create the Pix Order, or reuse the attached one while it is
  //   still payable for the same amount.
  // - 'regenerate': replace the attached Pix Order unless it has been paid.
  // - 'cancel': set only by the cancel-pending-pix-charge step (the
  //   cancel-order-with-pending-pix workflow and the orderCanceled hook),
  //   never by a store route: the Medusa order is being cancelled, so the
  //   pending Pix Order is cancelled too (see
  //   cancelPixOrderForOrderCancellation).
  async updatePayment(input: any): Promise<any> {
    const { mercadopago_pix_action: pixAction, ...data } = this.getDataObject(input)
    const amount = this.getAmount(input?.amount ?? data.amount ?? 0, 'payment amount')
    const currency = (input?.currency_code ?? data.currency_code ?? 'BRL').toString().toUpperCase()
    const idempotencyKey = this.getIdempotencyKey({ ...data, amount, currency_code: currency }, input?.context)

    const nextData: PaymentData = {
      ...data,
      amount: amount.toFixed(2),
      currency_code: currency,
      mercadopago_idempotency_key: idempotencyKey,
    }

    if (pixAction === undefined) {
      if (!hasPixOrderData(nextData) || this.isPixSession(nextData)) {
        return { data: nextData }
      }

      await this.invalidatePixOrder(nextData)

      return { data: this.withoutPixOrder(nextData) }
    }

    if (pixAction !== 'prepare' && pixAction !== 'regenerate' && pixAction !== 'cancel') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: unsupported Pix action.'
      )
    }

    if (!this.isPixSession(nextData)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: the payment session is not a Pix payment.'
      )
    }

    if (pixAction === 'cancel') {
      return this.cancelPixOrderForOrderCancellation(nextData)
    }

    return this.preparePixOrder(nextData, input, pixAction === 'regenerate')
  }

  // Called by the Payment Module when a session is deleted (payment method
  // or provider switched, or the cart total changed and Medusa recreated
  // the payment sessions). A Pix Order attached to the session must not
  // remain payable without it.
  async deletePayment(input: any): Promise<any> {
    const data = this.getDataObject(input)

    if (!hasPixOrderData(data)) {
      return { data }
    }

    await this.invalidatePixOrder(data)

    return { data: this.withoutPixOrder(data) }
  }

  async authorizePayment(input: any): Promise<any> {
    const data = this.getDataObject(input)

    if (this.isPixSession(data)) {
      return this.authorizePix(data, input)
    }

    const paymentMethodId =
      typeof data.payment_method_id === 'string' ? data.payment_method_id : undefined
    const cardToken = typeof data.card_token === 'string' ? data.card_token : undefined
    const installments = Number(data.installments ?? 1)
    const amount = this.getAmount(data.amount ?? data.transaction_amount ?? input?.amount, 'transaction amount')
    const cartId = typeof data.cart_id === 'string' && data.cart_id ? data.cart_id : undefined
    const payer = data.payer && typeof data.payer === 'object' ? data.payer : undefined
    const idempotencyKey = this.getIdempotencyKey({ ...data, amount }, input?.context)

    if (!cardToken || !paymentMethodId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: tokenized payment data is missing. card_token and payment_method_id must be provided by the storefront/tokenization step before creating the Order.'
      )
    }

    // The card type is never inferred (not from payment_method_id, not by
    // defaulting to credit): a session without it, e.g. one created before
    // payment_type_id existed, must have its payment data collected again.
    if (data.payment_type_id === undefined || data.payment_type_id === null) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: the card payment session is missing the card type. Please re-enter your payment information.'
      )
    }

    if (!isCardPaymentType(data.payment_type_id)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: unsupported card payment type. Please re-enter your payment information.'
      )
    }

    const paymentTypeId = data.payment_type_id

    if (!Number.isInteger(installments) || installments < 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: installments must be a positive integer.'
      )
    }

    if (!payer || typeof payer !== 'object') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: payer is required to create the Order.'
      )
    }

    if (!cartId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: cart_id is required to create the Order.'
      )
    }

    const body = {
      type: 'online',
      external_reference: cartId,
      total_amount: amount.toFixed(2),
      currency: 'BRL',
      processing_mode: 'automatic',
      description: `Medusa cart ${cartId}`,
      payer,
      transactions: {
        payments: [
          {
            amount: amount.toFixed(2),
            payment_method: {
              id: paymentMethodId,
              token: cardToken,
              type: paymentTypeId,
              installments,
            },
          },
        ],
      },
    }

    const order = await this.orderClient.create({
      body,
      requestOptions: {
        idempotencyKey: this.getCardOrderIdempotencyKey(idempotencyKey, body),
      },
    })

    const payment = order.transactions?.payments?.[0]

    if (!order.id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'Mercado Pago: order ID was not returned by the API.'
      )
    }

    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'Mercado Pago: payment was not returned in the order response.'
      )
    }

    const status = this.getStatusFromGateway(payment.status, order.status)

    return {
      status,
      data: {
        ...data,
        mercadopago_order_id: order.id,
        mercadopago_payment_id: payment.id,
        mercadopago_payment_status: payment.status,
        mercadopago_status_detail: payment.status_detail,
        mercadopago_order_status: order.status,
        mercadopago_order_status_detail: order.status_detail,
        mercadopago_external_reference: cartId,
        mercadopago_idempotency_key: idempotencyKey,
      },
    }
  }

  async capturePayment(input: any): Promise<any> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Mercado Pago: automatic capture is used for this project, so capturePayment is not required in the backend provider flow.'
    )
  }

  // Called by the Payment Module (refundPaymentFromProvider_) after it has
  // recorded the Refund and checked it against what was captured. input.amount
  // is refund.raw_amount and context.idempotency_key is refund.id, unique per
  // refund.
  //
  // Orders API contract: a total refund is POST /v1/orders/{id}/refund with no
  // body; a partial one sends transactions[{ id: transactions.payments[].id,
  // amount }]. The Payment Module only lets a refund equal the full payment
  // amount when nothing was refunded before, so that is the total case; any
  // other amount (including the remainder after partial refunds) is partial.
  async refundPayment(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const orderId = typeof data.mercadopago_order_id === 'string' ? data.mercadopago_order_id : undefined
    const paymentId = typeof data.mercadopago_payment_id === 'string' ? data.mercadopago_payment_id : undefined
    const amount = toPositiveDecimalString(input?.amount)
    const idempotencyKey = input?.context?.idempotency_key

    if (amount === undefined) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: refund amount must be a positive number.'
      )
    }

    // Never the session's key (used for other requests and shared by every
    // refund of this payment): each refund is a distinct operation.
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: a unique idempotency key is required to refund the payment.'
      )
    }

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: mercadopago_order_id is required to refund the payment.'
      )
    }

    const isTotal = amount === toPositiveDecimalString(data.amount)

    if (!isTotal && !paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: mercadopago_payment_id is required for a partial refund.'
      )
    }

    const requestOptions = { idempotencyKey }
    const order = await this.orderClient.refund(
      isTotal
        ? { id: orderId, requestOptions }
        : {
            id: orderId,
            body: { transactions: [{ id: paymentId, amount }] },
            requestOptions,
          }
    )

    const payment = order.transactions?.payments?.[0]
    const refund = order.transactions?.refunds?.at(-1)

    return {
      data: {
        ...data,
        mercadopago_order_id: order.id ?? orderId,
        mercadopago_payment_id: payment?.id ?? paymentId,
        mercadopago_payment_status: payment?.status ?? data.mercadopago_payment_status,
        mercadopago_status_detail: payment?.status_detail ?? data.mercadopago_status_detail,
        mercadopago_order_status: order.status,
        mercadopago_order_status_detail: order.status_detail,
        mercadopago_refund_id: refund?.id ?? data.mercadopago_refund_id,
        mercadopago_refunded_amount: refund?.amount ?? amount,
      },
    }
  }

  async retrievePayment(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const orderId = typeof data.mercadopago_order_id === 'string' ? data.mercadopago_order_id : undefined

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: mercadopago_order_id is required to retrieve the payment.'
      )
    }

    const order = await this.orderClient.get({ id: orderId })
    const payment = order.transactions?.payments?.[0]

    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'Mercado Pago: payment not found in the order.'
      )
    }

    return {
      data: {
        ...data,
        mercadopago_order_id: order.id ?? orderId,
        mercadopago_payment_id: payment.id ?? data.mercadopago_payment_id,
        mercadopago_payment_status: payment.status,
        mercadopago_status_detail: payment.status_detail,
        mercadopago_order_status: order.status,
        mercadopago_order_status_detail: order.status_detail,
      },
    }
  }

  async cancelPayment(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const orderId = typeof data.mercadopago_order_id === 'string' ? data.mercadopago_order_id : undefined

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: mercadopago_order_id is required to cancel the payment.'
      )
    }

    const idempotencyKey = this.getIdempotencyKey(data, input?.context)
    const order = await this.orderClient.cancel({
      id: orderId,
      requestOptions: {
        idempotencyKey,
      },
    })

    return {
      data: {
        ...data,
        mercadopago_order_id: order.id ?? orderId,
        mercadopago_order_status: order.status,
        mercadopago_order_status_detail: order.status_detail,
      },
    }
  }

  async getPaymentStatus(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const orderId = typeof data.mercadopago_order_id === 'string' ? data.mercadopago_order_id : undefined

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: mercadopago_order_id is required to query the payment status.'
      )
    }

    const order = await this.orderClient.get({ id: orderId })
    const payment = order.transactions?.payments?.[0]

    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'Mercado Pago: payment not found in the order.'
      )
    }

    const status = this.getStatusFromGateway(payment.status, order.status)

    return {
      status,
      data: {
        ...data,
        mercadopago_order_id: order.id ?? orderId,
        mercadopago_payment_id: payment.id ?? data.mercadopago_payment_id,
        mercadopago_payment_status: payment.status,
        mercadopago_status_detail: payment.status_detail,
        mercadopago_order_status: order.status,
        mercadopago_order_status_detail: order.status_detail,
      },
    }
  }

  async getWebhookActionAndData(payload: any): Promise<any> {
    const sessionId =
      typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : ''

    const notSupported = {
      action: 'not_supported',
      data: {
        session_id: sessionId,
        amount: 0,
      },
    }

    // The route already validated HMAC and resolved the session; here we only
    // apply the existing status mapping to the state it already fetched from
    // the Mercado Pago Order. No second network call, no container access.
    if (!sessionId || payload?.data?.type !== 'order') {
      return notSupported
    }

    const paymentStatus =
      typeof payload?.paymentStatus === 'string' ? payload.paymentStatus : undefined
    const orderStatus =
      typeof payload?.orderStatus === 'string' ? payload.orderStatus : undefined

    const status = this.getStatusFromGateway(paymentStatus, orderStatus)

    if (status !== 'captured' && status !== 'authorized') {
      return notSupported
    }

    if (typeof payload?.amount !== 'string' || payload.amount.trim().length === 0) {
      return notSupported
    }

    return {
      action: status,
      data: {
        session_id: sessionId,
        amount: payload.amount,
      },
    }
  }
}

export default MercadoPagoPaymentProviderService
