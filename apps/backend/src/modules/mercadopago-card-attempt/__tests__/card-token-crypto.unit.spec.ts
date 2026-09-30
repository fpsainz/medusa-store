import { randomBytes } from "node:crypto"

import {
  CardTokenCryptoError,
  CardTokenKeyConfigError,
  decryptCardToken,
  encryptCardToken,
  parseCardTokenKeyRing,
} from "../card-token-crypto"

// Fake token, random keys: nothing here is a real card token or key.
const TOKEN = "FAKE-card-token-0123456789abcdef-not-real"
const K1 = randomBytes(32).toString("base64url")
const K2 = randomBytes(32).toString("base64url")
const BINDING = { attemptId: "mpca_01TESTATTEMPT", paymentSessionId: "payses_01TESTSESSION" }

const ring = (keys: string, current: string) => parseCardTokenKeyRing(keys, current)!
const RING_K1 = ring(`k1:${K1}`, "k1")

const expectFailure = (fn: () => unknown, reason: string) => {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(CardTokenCryptoError)
  expect((caught as CardTokenCryptoError).reason).toBe(reason)
  return caught as CardTokenCryptoError
}

const parts = (envelope: string) => envelope.split(":")
const flipFirstByte = (b64: string) => {
  const bytes = Buffer.from(b64, "base64url")
  bytes[0] ^= 1
  return bytes.toString("base64url")
}

describe("card token crypto", () => {
  describe("round-trip", () => {
    it("decrypts what it encrypts", () => {
      const envelope = encryptCardToken(RING_K1, TOKEN, BINDING)
      expect(decryptCardToken(RING_K1, envelope, BINDING)).toBe(TOKEN)
    })

    it("uses AES-256-GCM with a 12-byte IV and a 16-byte tag in a v1 base64url envelope", () => {
      const [version, kid, iv, tag, ct] = parts(encryptCardToken(RING_K1, TOKEN, BINDING))
      expect(version).toBe("v1")
      expect(kid).toBe("k1")
      expect(Buffer.from(iv, "base64url")).toHaveLength(12)
      expect(Buffer.from(tag, "base64url")).toHaveLength(16)
      expect(Buffer.from(ct, "base64url")).toHaveLength(Buffer.byteLength(TOKEN))
    })

    it("draws a new IV for every encryption", () => {
      const a = parts(encryptCardToken(RING_K1, TOKEN, BINDING))[2]
      const b = parts(encryptCardToken(RING_K1, TOKEN, BINDING))[2]
      expect(a).not.toBe(b)
    })

    it("refuses an empty or oversized token", () => {
      expectFailure(() => encryptCardToken(RING_K1, "", BINDING), "token_invalid")
      expectFailure(() => encryptCardToken(RING_K1, "x".repeat(513), BINDING), "token_invalid")
    })
  })

  describe("tampering fails closed", () => {
    const envelope = encryptCardToken(RING_K1, TOKEN, BINDING)
    const [v, kid, iv, tag, ct] = parts(envelope)

    it.each([
      ["ciphertext", [v, kid, iv, tag, flipFirstByte(ct)]],
      ["tag", [v, kid, iv, flipFirstByte(tag), ct]],
      ["iv", [v, kid, flipFirstByte(iv), tag, ct]],
    ])("changing the %s", (_, altered) => {
      expectFailure(() => decryptCardToken(RING_K1, (altered as string[]).join(":"), BINDING), "auth_failed")
    })

    it("changing the key id to another key of the ring", () => {
      const both = ring(`k1:${K1},k2:${K2}`, "k1")
      expectFailure(() => decryptCardToken(both, [v, "k2", iv, tag, ct].join(":"), BINDING), "auth_failed")
    })

    it.each([
      ["attempt_id", { ...BINDING, attemptId: "mpca_01OTHER" }],
      ["payment_session_id", { ...BINDING, paymentSessionId: "payses_01OTHER" }],
    ])("changing the AAD %s", (_, binding) => {
      expectFailure(() => decryptCardToken(RING_K1, envelope, binding), "auth_failed")
    })
  })

  describe("keys", () => {
    it("fails with the wrong key under the same key id", () => {
      const envelope = encryptCardToken(RING_K1, TOKEN, BINDING)
      expectFailure(() => decryptCardToken(ring(`k1:${K2}`, "k1"), envelope, BINDING), "auth_failed")
    })

    it("rotation: K1 encrypts, K2 becomes current, K1 retained → still decrypts; new ones use K2", () => {
      const old = encryptCardToken(RING_K1, TOKEN, BINDING)
      const rotated = ring(`k1:${K1},k2:${K2}`, "k2")
      expect(decryptCardToken(rotated, old, BINDING)).toBe(TOKEN)
      expect(parts(encryptCardToken(rotated, TOKEN, BINDING))[1]).toBe("k2")
    })

    it("removed key: K1 no longer in the ring → kid_unknown (no other key is tried)", () => {
      const old = encryptCardToken(RING_K1, TOKEN, BINDING)
      expectFailure(() => decryptCardToken(ring(`k2:${K2}`, "k2"), old, BINDING), "kid_unknown")
    })

    it("no configured keys → key_missing on encrypt and decrypt", () => {
      const envelope = encryptCardToken(RING_K1, TOKEN, BINDING)
      expectFailure(() => encryptCardToken(null, TOKEN, BINDING), "key_missing")
      expectFailure(() => decryptCardToken(null, envelope, BINDING), "key_missing")
    })
  })

  describe("invalid envelopes fail closed before decryption", () => {
    const envelope = encryptCardToken(RING_K1, TOKEN, BINDING)
    const [v, kid, iv, tag, ct] = parts(envelope)
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url")
    const tag15 = Buffer.from(tag, "base64url").subarray(0, 15).toString("base64url")
    const iv11 = Buffer.from(iv, "base64url").subarray(0, 11).toString("base64url")

    it.each([
      ["unknown version", ["v2", kid, iv, tag, ct]],
      ["empty kid", [v, "", iv, tag, ct]],
      ["kid with invalid characters", [v, "K1!", iv, tag, ct]],
      ["invalid base64url characters", [v, kid, iv.slice(0, -1) + "$", tag, ct]],
      ["base64 padding (non canonical)", [v, kid, iv, tag, ct + "="]],
      ["IV of 11 bytes", [v, kid, iv11, tag, ct]],
      ["truncated tag of 4 bytes", [v, kid, iv, shortTag, ct]],
      ["tag of 15 bytes", [v, kid, iv, tag15, ct]],
      ["empty ciphertext", [v, kid, iv, tag, ""]],
      ["extra component", [v, kid, iv, tag, ct, "x"]],
      ["missing component", [v, kid, iv, tag]],
    ])("%s", (_, altered) => {
      expectFailure(() => decryptCardToken(RING_K1, (altered as string[]).join(":"), BINDING), "envelope_invalid")
    })

    it("unknown kid", () => {
      expectFailure(() => decryptCardToken(RING_K1, [v, "k9", iv, tag, ct].join(":"), BINDING), "kid_unknown")
    })

    it("non-string envelope", () => {
      expectFailure(() => decryptCardToken(RING_K1, undefined as unknown as string, BINDING), "envelope_invalid")
    })
  })

  describe("key configuration", () => {
    it("absent configuration → null (the app may start)", () => {
      expect(parseCardTokenKeyRing(undefined, undefined)).toBeNull()
      expect(parseCardTokenKeyRing("", "  ")).toBeNull()
    })

    it("parses several keys and the current one", () => {
      const parsed = parseCardTokenKeyRing(` k1:${K1} , k2:${K2} `, "k2")!
      expect(parsed.currentKid).toBe("k2")
      expect([...parsed.keys.keys()]).toEqual(["k1", "k2"])
    })

    it.each([
      ["keys without current kid", `k1:${K1}`, undefined],
      ["current kid without keys", undefined, "k1"],
      ["current kid not in ring", `k1:${K1}`, "k2"],
      ["key of 31 bytes", `k1:${randomBytes(31).toString("base64url")}`, "k1"],
      ["key of 33 bytes", `k1:${randomBytes(33).toString("base64url")}`, "k1"],
      ["duplicate kid", `k1:${K1},k1:${K2}`, "k1"],
      ["entry without separator", `k1${K1}`, "k1"],
      ["kid with colon", `k:1:${K1}`, "k:1"],
      ["invalid kid", `K1:${K1}`, "K1"],
      ["non canonical key", `k1:${K1}=`, "k1"],
    ])("malformed: %s → throws", (_, keys, current) => {
      expect(() => parseCardTokenKeyRing(keys, current)).toThrow(CardTokenKeyConfigError)
    })

    it("configuration errors never include key material", () => {
      for (const [keys, current] of [[`k1:${K1}`, "k2"], [`k1:${K1},k1:${K2}`, "k1"], [`k1:${K1}=`, "k1"]]) {
        try {
          parseCardTokenKeyRing(keys, current)
        } catch (error) {
          expect(String((error as Error).message)).not.toContain(K1)
          expect(String((error as Error).message)).not.toContain(K2)
        }
      }
    })
  })

  describe("errors never carry secrets", () => {
    it("no token, ciphertext, envelope or key in message, stack or serialization", () => {
      const envelope = encryptCardToken(RING_K1, TOKEN, BINDING)
      const [v, kid, iv, tag, ct] = parts(envelope)
      const failures = [
        () => decryptCardToken(RING_K1, [v, kid, iv, tag, flipFirstByte(ct)].join(":"), BINDING),
        () => decryptCardToken(ring(`k1:${K2}`, "k1"), envelope, BINDING),
        () => decryptCardToken(RING_K1, envelope, { ...BINDING, attemptId: "mpca_x" }),
        () => decryptCardToken(RING_K1, envelope + "x", BINDING),
        () => encryptCardToken(null, TOKEN, BINDING),
      ]

      for (const failure of failures) {
        try {
          failure()
          throw new Error("expected a failure")
        } catch (error) {
          expect(error).toBeInstanceOf(CardTokenCryptoError)
          const exposed = [
            (error as Error).message,
            (error as Error).stack ?? "",
            JSON.stringify(error),
            String((error as { cause?: unknown }).cause ?? ""),
          ].join("\n")
          for (const secret of [TOKEN, envelope, ct, K1, K2]) {
            expect(exposed).not.toContain(secret)
          }
          expect((error as { cause?: unknown }).cause).toBeUndefined()
        }
      }
    })
  })
})
