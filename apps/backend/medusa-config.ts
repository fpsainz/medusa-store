import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL?.replace(
      /([?&])sslmode=require(&?)/i,
      "$1ssl_mode=disable$2"
    ),
    databaseDriverOptions: {
      connection: {
        ssl: {
          rejectUnauthorized: false,
        },
      },
    },
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  modules: [
    {
      resolve: '@medusajs/medusa/payment',
      options: {
        providers: [
          {
            // No `id` here: the registered provider token is `pp_${identifier}`
            // (service.ts: static identifier = 'mercadopago') -> pp_mercadopago.
            // Adding an `id` would append a `_<id>` suffix (see @medusajs/payment's
            // provider loader) and reintroduce the pp_mercadopago_mercadopago duplication.
            resolve: './src/modules/mercadopago',
            options: {
              access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
            },
          },
        ],
      },
    },
    {
      // Temporary payment capabilities (ADR-007). Its table comes from
      // src/modules/payment-access/migrations.
      resolve: './src/modules/payment-access',
    },
  ],
})
