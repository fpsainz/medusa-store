import { Module } from "@medusajs/framework/utils"

import validateCardTokenKeys from "./loaders/validate-card-token-keys"
import MercadopagoCardAttemptModuleService from "./service"

export const MERCADOPAGO_CARD_ATTEMPT_MODULE = "mercadopagoCardAttempt"

export default Module(MERCADOPAGO_CARD_ATTEMPT_MODULE, {
  service: MercadopagoCardAttemptModuleService,
  loaders: [validateCardTokenKeys],
})
