import { Module } from "@medusajs/framework/utils"

import PaymentAccessModuleService from "./service"

export const PAYMENT_ACCESS_MODULE = "paymentAccess"

export default Module(PAYMENT_ACCESS_MODULE, {
  service: PaymentAccessModuleService,
})
