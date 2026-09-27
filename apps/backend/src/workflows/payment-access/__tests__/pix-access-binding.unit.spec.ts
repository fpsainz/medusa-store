import { type PixAccessCart, type PixAccessSession, resolvePixAccessBinding } from "../pix-access-binding"

const NOW = new Date("2026-09-27T12:00:00.000Z")

const CART: PixAccessCart = { id: "cart_1", completed_at: null, payment_collection: { id: "paycol_1" } }

const SESSION: PixAccessSession = {
  id: "payses_1",
  provider_id: "pp_mercadopago",
  payment_collection_id: "paycol_1",
  data: {
    payment_method_id: "pix",
    mercadopago_order_id: "ORD_PIX_A",
    mercadopago_order_payment_method: "pix",
    mercadopago_pix_expires_at: "2026-09-27T12:40:00.000Z",
  },
}

const resolve = (overrides: { cart?: PixAccessCart | null; session?: PixAccessSession | null; now?: Date } = {}) =>
  resolvePixAccessBinding({
    cart: "cart" in overrides ? overrides.cart : CART,
    session: "session" in overrides ? overrides.session : SESSION,
    now: overrides.now ?? NOW,
  })

describe("resolvePixAccessBinding", () => {
  it("binds an open cart's Pix session with a charge, expiring at deadline + 15 min", () => {
    expect(resolve()).toEqual({
      payment_session_id: "payses_1",
      payment_collection_id: "paycol_1",
      cart_id: "cart_1",
      expires_at: "2026-09-27T12:55:00.000Z",
    })
  })

  it("never issues for a missing or completed cart", () => {
    expect(resolve({ cart: null })).toBeNull()
    expect(resolve({ cart: { ...CART, completed_at: "2026-09-27T11:59:00.000Z" } })).toBeNull()
  })

  it("never issues for a missing session or one outside the cart's payment collection", () => {
    expect(resolve({ session: null })).toBeNull()
    expect(resolve({ session: { ...SESSION, payment_collection_id: "paycol_other" } })).toBeNull()
    expect(resolve({ cart: { ...CART, payment_collection: null } })).toBeNull()
  })

  it("never issues for another provider or a non-Pix (card) session", () => {
    expect(resolve({ session: { ...SESSION, provider_id: "pp_system_default" } })).toBeNull()
    expect(resolve({ session: { ...SESSION, data: { ...SESSION.data, payment_method_id: "visa" } } })).toBeNull()
  })

  it("never issues before a Pix charge exists", () => {
    expect(
      resolve({ session: { ...SESSION, data: { payment_method_id: "pix", mercadopago_pix_expires_at: "2026-09-27T12:40:00.000Z" } } })
    ).toBeNull()
  })

  it("never issues for a charge without a stored deadline (created before the explicit expiration)", () => {
    const { mercadopago_pix_expires_at: _omit, ...legacy } = SESSION.data ?? {}
    expect(resolve({ session: { ...SESSION, data: legacy } })).toBeNull()
    expect(resolve({ session: { ...SESSION, data: { ...SESSION.data, mercadopago_pix_expires_at: "PT1H" } } })).toBeNull()
  })

  it("never issues once deadline + grace has passed", () => {
    expect(resolve({ now: new Date("2026-09-27T12:55:00.000Z") })).toBeNull()
    expect(resolve({ now: new Date("2026-09-27T12:54:59.000Z") })).not.toBeNull()
  })
})
