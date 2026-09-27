import { defineMiddlewares } from "@medusajs/framework/http"

import { redactMercadoPagoDataMiddleware } from "./utils/redact-mercadopago-data"

// Store API routes whose responses can contain payment sessions or payments
// (cart and all its mutations, including the complete error response; payment
// collections and session creation; orders). See ADR-006.
export default defineMiddlewares({
  routes: [
    { matcher: "/store/carts*", middlewares: [redactMercadoPagoDataMiddleware] },
    {
      matcher: "/store/payment-collections*",
      middlewares: [redactMercadoPagoDataMiddleware],
    },
    { matcher: "/store/orders*", middlewares: [redactMercadoPagoDataMiddleware] },
  ],
})
