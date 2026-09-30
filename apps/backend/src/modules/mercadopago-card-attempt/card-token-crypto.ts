import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

// Encryption of the Mercado Pago card token of a card attempt (ADR-015,
// INV-009). AES-256-GCM from node:crypto only.
//
// Envelope: `v1:<kid>:<iv>:<tag>:<ciphertext>`, every binary part base64url
// without padding. AAD binds the ciphertext to its attempt, its payment
// session, the envelope version and the key id; changing the AAD format
// requires a new envelope version.
//
// Nothing secret ever leaves this file in an error: errors carry a fixed
// message and a reason from a closed list, never the token, the envelope,
// the ciphertext or a key, and never wrap a lower-level error.
//
// Memory: the token is a JavaScript string (immutable, copied by the
// runtime), so it cannot be wiped deterministically. It is only held in the
// narrowest scope, never cached, persisted in plaintext or logged.

const ALGORITHM = "aes-256-gcm"
const ENVELOPE_VERSION = "v1"
const AAD_LABEL = "mercadopago_card_token"
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_TOKEN_LENGTH = 512

const KID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export type CardTokenKeyRing = {
  readonly currentKid: string
  readonly keys: ReadonlyMap<string, Buffer>
}

export type CardTokenBinding = {
  attemptId: string
  paymentSessionId: string
}

export const CARD_TOKEN_FAILURE_REASONS = [
  "key_missing",
  "kid_unknown",
  "envelope_invalid",
  "auth_failed",
  "token_invalid",
] as const

export type CardTokenFailureReason = (typeof CARD_TOKEN_FAILURE_REASONS)[number]

// Fails closed. The message names only the reason.
export class CardTokenCryptoError extends Error {
  readonly reason: CardTokenFailureReason

  constructor(reason: CardTokenFailureReason) {
    super(`card_token_unavailable (${reason})`)
    this.name = "CardTokenCryptoError"
    this.reason = reason
  }
}

// Malformed key configuration. Stops the boot (module loader). The message
// never includes key material.
export class CardTokenKeyConfigError extends Error {
  constructor(detail: string) {
    super(`Mercado Pago card token key configuration is invalid: ${detail}`)
    this.name = "CardTokenKeyConfigError"
  }
}

// Strict base64url: allowed characters only and canonical (decoding and
// re-encoding gives the same string). Buffer.from(…, "base64url") alone
// silently skips invalid characters.
function decodeStrictBase64Url(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, "base64url")
  return decoded.toString("base64url") === value ? decoded : null
}

// Parses MERCADOPAGO_CARD_TOKEN_KEYS (`kid:key,kid:key,…`, each key 32 bytes
// base64url) and MERCADOPAGO_CARD_TOKEN_CURRENT_KID.
// - Both absent or empty: null (the app may start; card token operations
//   then fail with `key_missing`).
// - Anything else malformed: throws CardTokenKeyConfigError.
export function parseCardTokenKeyRing(
  keysValue: string | undefined,
  currentKidValue: string | undefined
): CardTokenKeyRing | null {
  const keysText = keysValue?.trim() ?? ""
  const currentKid = currentKidValue?.trim() ?? ""

  if (!keysText && !currentKid) {
    return null
  }

  if (!keysText) {
    throw new CardTokenKeyConfigError("MERCADOPAGO_CARD_TOKEN_KEYS is empty")
  }

  if (!currentKid) {
    throw new CardTokenKeyConfigError("MERCADOPAGO_CARD_TOKEN_CURRENT_KID is empty")
  }

  const keys = new Map<string, Buffer>()

  for (const [index, rawEntry] of keysText.split(",").entries()) {
    const entry = rawEntry.trim()
    const separator = entry.indexOf(":")

    if (separator <= 0 || separator !== entry.lastIndexOf(":")) {
      throw new CardTokenKeyConfigError(`entry ${index + 1} is not <kid>:<key>`)
    }

    const kid = entry.slice(0, separator)
    const key = decodeStrictBase64Url(entry.slice(separator + 1))

    if (!KID_PATTERN.test(kid)) {
      throw new CardTokenKeyConfigError(`entry ${index + 1} has an invalid key id`)
    }

    if (keys.has(kid)) {
      throw new CardTokenKeyConfigError(`key id "${kid}" is repeated`)
    }

    if (!key || key.length !== KEY_BYTES) {
      throw new CardTokenKeyConfigError(`key "${kid}" is not ${KEY_BYTES} bytes of base64url`)
    }

    keys.set(kid, key)
  }

  if (!keys.has(currentKid)) {
    throw new CardTokenKeyConfigError(`current key id "${currentKid}" is not in the key ring`)
  }

  return { currentKid, keys }
}

// JSON array: deterministic, delimited and escaped, so no two bindings can
// produce the same AAD.
function buildAad(kid: string, binding: CardTokenBinding): Buffer {
  return Buffer.from(
    JSON.stringify([AAD_LABEL, ENVELOPE_VERSION, kid, binding.attemptId, binding.paymentSessionId]),
    "utf8"
  )
}

function assertBinding(binding: CardTokenBinding): void {
  if (
    typeof binding?.attemptId !== "string" ||
    !binding.attemptId ||
    typeof binding.paymentSessionId !== "string" ||
    !binding.paymentSessionId
  ) {
    throw new CardTokenCryptoError("token_invalid")
  }
}

// Always encrypts with the current key.
export function encryptCardToken(
  keyRing: CardTokenKeyRing | null,
  token: string,
  binding: CardTokenBinding
): string {
  if (!keyRing) {
    throw new CardTokenCryptoError("key_missing")
  }

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new CardTokenCryptoError("token_invalid")
  }

  assertBinding(binding)

  const kid = keyRing.currentKid
  const key = keyRing.keys.get(kid)

  if (!key) {
    throw new CardTokenCryptoError("key_missing")
  }

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(buildAad(kid, binding))
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    ENVELOPE_VERSION,
    kid,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":")
}

type ParsedEnvelope = { kid: string; iv: Buffer; tag: Buffer; ciphertext: Buffer }

// Every check happens before any decryption.
function parseEnvelope(envelope: unknown): ParsedEnvelope {
  if (typeof envelope !== "string") {
    throw new CardTokenCryptoError("envelope_invalid")
  }

  const parts = envelope.split(":")

  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION || !KID_PATTERN.test(parts[1])) {
    throw new CardTokenCryptoError("envelope_invalid")
  }

  const iv = decodeStrictBase64Url(parts[2])
  const tag = decodeStrictBase64Url(parts[3])
  const ciphertext = decodeStrictBase64Url(parts[4])

  if (
    !iv ||
    iv.length !== IV_BYTES ||
    !tag ||
    tag.length !== TAG_BYTES ||
    !ciphertext ||
    ciphertext.length === 0
  ) {
    throw new CardTokenCryptoError("envelope_invalid")
  }

  return { kid: parts[1], iv, tag, ciphertext }
}

// Decrypts only with the key named by the envelope; never tries other keys
// and never falls back to plaintext. Any failure throws before returning.
export function decryptCardToken(
  keyRing: CardTokenKeyRing | null,
  envelope: string,
  binding: CardTokenBinding
): string {
  if (!keyRing) {
    throw new CardTokenCryptoError("key_missing")
  }

  assertBinding(binding)

  const { kid, iv, tag, ciphertext } = parseEnvelope(envelope)
  const key = keyRing.keys.get(kid)

  if (!key) {
    throw new CardTokenCryptoError("kid_unknown")
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(buildAad(kid, binding))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const token = plaintext.toString("utf8")

    if (token.length === 0) {
      throw new CardTokenCryptoError("token_invalid")
    }

    return token
  } catch (error) {
    if (error instanceof CardTokenCryptoError) {
      throw error
    }

    // The node:crypto error is dropped on purpose (no `cause`).
    throw new CardTokenCryptoError("auth_failed")
  }
}
