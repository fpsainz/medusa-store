import { ModuleProvider, Modules } from '@medusajs/framework/utils'

import MercadoPagoPaymentProviderService from './service'

export default ModuleProvider(Modules.PAYMENT, {
  services: [MercadoPagoPaymentProviderService],
})
