/**
 * sha256 / hmacSha256 — Web Crypto API wrappers.
 *
 * Zero external dependencies. Uses globalThis.crypto.subtle (Node ≥ 19 native,
 * browser, Deno, Cloudflare Workers). Throws if the runtime does not expose
 * SubtleCrypto (Node < 19 without --experimental-global-webcrypto).
 *
 * @module proof/sha256
 */

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      "proof/sha256: globalThis.crypto.subtle is unavailable. " +
        "Require Node.js >= 19 or pass --experimental-global-webcrypto.",
    );
  }
  return s;
}

/**
 * Ensure the returned Uint8Array is backed by a plain ArrayBuffer
 * (not SharedArrayBuffer), as required by SubtleCrypto's BufferSource type.
 * The explicit return type avoids Uint8Array<ArrayBufferLike> widening.
 */
function toBytes(input: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  // Always copy into a fresh ArrayBuffer to guarantee the concrete type.
  const copy = new Uint8Array(input.length);
  copy.set(input);
  return copy;
}

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 hex digest via Web Crypto.
 *
 * @param input - UTF-8 string or raw bytes.
 * @returns Lowercase hex digest (64 chars).
 * @throws If SubtleCrypto is unavailable.
 * @public
 */
export async function sha256(input: string | Uint8Array): Promise<string> {
  const buf = await subtle().digest("SHA-256", toBytes(input));
  return bufferToHex(buf);
}

/**
 * HMAC-SHA-256 hex digest via Web Crypto.
 *
 * @param key   - Raw key bytes (min 32 bytes recommended for HMAC-SHA-256).
 * @param input - UTF-8 string or raw bytes to authenticate.
 * @returns Lowercase hex MAC (64 chars).
 * @throws If SubtleCrypto is unavailable or key import fails.
 * @public
 */
export async function hmacSha256(key: Uint8Array, input: string | Uint8Array): Promise<string> {
  const s = subtle();
  // Copy key into fresh ArrayBuffer to satisfy SubtleCrypto's BufferSource constraint.
  const keyBytes = new Uint8Array(key.length);
  keyBytes.set(key);
  const cryptoKey = await s.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const buf = await s.sign("HMAC", cryptoKey, toBytes(input));
  return bufferToHex(buf);
}
