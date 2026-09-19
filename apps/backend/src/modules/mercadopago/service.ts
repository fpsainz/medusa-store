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
