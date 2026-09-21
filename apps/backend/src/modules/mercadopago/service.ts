import { createHash } from 'node:crypto'

import { AbstractPaymentProvider, MedusaError } from '@medusajs/framework/utils'
import { MercadoPagoConfig, Order } from 'mercadopago'

type MercadoPagoProviderOptions = {
  access_token?: string
}

type PaymentData = Record<string, unknown>

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

  // Maps the one Pix-specific state the Orders API can return that has no
  // equivalent in getStatusFromGateway(): an order awaiting the buyer's Pix
  // transfer. Delegates to the existing, unmodified getStatusFromGateway()
  // for every other case (including the final captured/authorized states),
  // so card/debit behavior (which never calls this function) is untouched
  // and the approved/rejected/etc. mapping isn't duplicated.
  private resolvePixStatus(
    paymentStatus?: string,
    paymentStatusDetail?: string,
    orderStatus?: string,
    orderStatusDetail?: string
  ): 'captured' | 'authorized' | 'pending' | 'canceled' | 'error' | 'requires_more' | 'pending_authorization' {
    const normalizedPaymentStatus = paymentStatus?.toLowerCase() ?? ''
    const normalizedPaymentDetail = paymentStatusDetail?.toLowerCase() ?? ''
    const normalizedOrderStatus = orderStatus?.toLowerCase() ?? ''
    const normalizedOrderDetail = orderStatusDetail?.toLowerCase() ?? ''

    const isActionRequired =
      normalizedPaymentStatus === 'action_required' || normalizedOrderStatus === 'action_required'
    const isWaitingTransfer =
      normalizedPaymentDetail === 'waiting_transfer' || normalizedOrderDetail === 'waiting_transfer'

    if (isActionRequired && isWaitingTransfer) {
      return 'pending_authorization'
    }

    return this.getStatusFromGateway(paymentStatus, orderStatus)
  }

  // Builds the non-destructive data merge shared by Pix order creation and
  // Pix re-authorization: spreads the existing session data first (never
  // removing card_token/payer/installments or anything else already
  // there), then adds/overwrites only the Mercado Pago fields that are
  // actually present in this Order response. Never writes a key with an
  // undefined value. qr_code_base64 is persisted as-is even when it's an
  // empty string (sandbox behavior), never substituted with another value.
  // Expiration is persisted under the exact field name the API actually
  // returned (date_of_expiration and/or expiration_time), never invented
  // for the one that's absent.
  private buildPixOrderData(
    data: PaymentData,
    order: { id?: string; status?: string; status_detail?: string },
    payment?: {
      id?: string
      status?: string
      status_detail?: string
      date_of_expiration?: string
      expiration_time?: string
      payment_method?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string }
    }
  ): PaymentData {
    const paymentMethod = payment?.payment_method

    return {
      ...data,
      ...(order.id !== undefined ? { mercadopago_order_id: order.id } : {}),
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
            },
          ],
        },
      },
      requestOptions: {
        idempotencyKey,
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

  async updatePayment(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const amount = this.getAmount(input?.amount ?? data.amount ?? 0, 'payment amount')
    const currency = (input?.currency_code ?? data.currency_code ?? 'BRL').toString().toUpperCase()
    const idempotencyKey = this.getIdempotencyKey({ ...data, amount, currency_code: currency }, input?.context)

    return {
      data: {
        ...data,
        amount: amount.toFixed(2),
        currency_code: currency,
        mercadopago_idempotency_key: idempotencyKey,
      },
    }
  }

  async deletePayment(input: any): Promise<any> {
    return {
      data: this.getDataObject(input),
    }
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
                id: paymentMethodId,
                token: cardToken,
                type: 'credit_card',
                installments,
              },
            },
          ],
        },
      },
      requestOptions: {
        idempotencyKey,
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

  async refundPayment(input: any): Promise<any> {
    const data = this.getDataObject(input)
    const orderId = typeof data.mercadopago_order_id === 'string' ? data.mercadopago_order_id : undefined
    const paymentId = typeof data.mercadopago_payment_id === 'string' ? data.mercadopago_payment_id : undefined
    const amount = this.getAmount(input?.amount ?? data.amount ?? 0, 'refund amount')

    if (!orderId || !paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Mercado Pago: mercadopago_order_id and mercadopago_payment_id are required to refund the payment.'
      )
    }

    const idempotencyKey = this.getIdempotencyKey({ ...data, amount }, input?.context)
    const order = await this.orderClient.refund({
      id: orderId,
      body: {
        transactions: [
          {
            id: paymentId,
            amount: amount.toFixed(2),
          },
        ],
      },
      requestOptions: {
        idempotencyKey,
      },
    })

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
        mercadopago_refunded_amount: refund?.amount ?? amount.toFixed(2),
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
