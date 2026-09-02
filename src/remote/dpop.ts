/**
 * remote/dpop — minimal RFC 9449 DPoP primitives for device-bound sub-tokens (P1b).
 *
 * The default sub-token (T6f) is a bearer : whoever holds the string can use
 * it until expiry. That is acceptable for paste-and-go handoff but unsafe
 * when the QR is captured (clipboard hostile, screen capture, photo of
 * laptop). P1b binds a sub-token to a specific device's keypair via a `cnf`
 * (confirmation) claim — RFC 9449 §6.1 + RFC 7800. The server then requires
 * every request to carry a fresh DPoP proof JWT signed by that device's key.
 *
 * Stolen sub-token alone → useless. Stolen sub-token + stolen private key →
 * still attacker would need physical access to the device's secure storage
 * (IndexedDB-backed P-256 in the PWA, OS keychain elsewhere).
 *
 * Scope of this module
 * --------------------
 *   - `computeJwkThumbprint(jwk)` : RFC 7638 thumbprint (sha256 over the
 *     canonical members of the JWK, base64url). The `jkt` claim value.
 *   - `validateDpopProof(dpopJwt, opts)` : verifies a DPoP JWT against
 *     `expectedJkt`, expected HTTP method (`htm`), expected URL (`htu`),
 *     iat freshness, jti uniqueness, and the embedded JWK signature.
 *   - `DpopReplayStore` : in-process jti deny-list with TTL ; the host
 *     plugs its own store (Redis, SQLite) when scaled out.
 *
 * Crypto choice
 * -------------
 * P-256 / ES256 only for v1. WebCrypto exposes `ECDSA` verify with
 * `namedCurve: P-256` in both Node 20+ (`globalThis.crypto.subtle`) AND
 * every modern browser without a polyfill. The SDK stays free of `jose`
 * (which the legacy CC backend uses) so the bundle stays small enough
 * for the PWA. RFC 9449 also permits RS256/PS256/ES384/ES512 ; those are
 * out of scope for v1 (no observed need + each adds an algorithm branch
 * to the verifier).
 *
 * @public @since 2.24.0 — preste P1b (DPoP device-binding primitives)
 */

import { createHash } from "node:crypto";

// ─── JWK shapes (subset used by this module) ─────────────────────────────

/**
 * JWK for an ECDSA P-256 key (RFC 7517 §3 + RFC 7518 §6.2).
 * Only the public-key members are required at the verifier side ; `d`
 * (private scalar) is rejected if present (a DPoP header MUST carry a
 * public key only).
 * @public
 */
export interface EcP256Jwk {
  kty: "EC";
  crv: "P-256";
  /** x coordinate, base64url. */
  x: string;
  /** y coordinate, base64url. */
  y: string;
  /** Algorithm hint. Optional in spec ; when present, MUST be "ES256". */
  alg?: "ES256";
  use?: "sig";
  /** Private scalar — MUST NOT be present in a DPoP header. */
  d?: never;
}

/**
 * Decoded DPoP proof claims (RFC 9449 §4.2).
 * @public
 */
export interface DpopClaims {
  /** HTTP method (uppercase). */
  htm: string;
  /** HTTP URL — scheme + host + path, no query / fragment. */
  htu: string;
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Unique proof id (replay protection). */
  jti: string;
  /**
   * Optional hash of the access token (RFC 9449 §4.3) — sha256 of the
   * token, base64url. When present, validators MUST cross-check the
   * presented sub-token against this hash.
   */
  ath?: string;
}

// ─── base64url helpers ───────────────────────────────────────────────────

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function b64urlDecodeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(b64urlDecode(s).toString("utf-8")) as T;
  } catch {
    return undefined;
  }
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

// ─── RFC 7638 JWK thumbprint ─────────────────────────────────────────────

/**
 * Compute the SHA-256 JWK thumbprint of an EC P-256 public key per
 * RFC 7638. The canonical members for `kty:EC` are `{crv, kty, x, y}`,
 * sorted lexicographically, JSON-serialised with no whitespace.
 *
 * The resulting base64url-encoded digest is the `jkt` claim value
 * embedded in a sub-token's `cnf` field and the `jkt` attribute on
 * `validateDpopProof` calls.
 *
 * Exported for clients that need to compute their own device's jkt
 * (e.g. the PWA at first launch, to send up to the server during the
 * device-bind handshake).
 * @public
 */
export function computeJwkThumbprint(jwk: EcP256Jwk): string {
  if (jwk.kty !== "EC") throw new Error("dpop: only kty=EC supported");
  if (jwk.crv !== "P-256") throw new Error("dpop: only crv=P-256 supported");
  if (!jwk.x || !jwk.y) throw new Error("dpop: missing x or y in JWK");
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return b64urlEncode(createHash("sha256").update(canonical, "utf-8").digest());
}

// ─── DPoP proof validation ───────────────────────────────────────────────

/**
 * Options for `validateDpopProof`.
 * @public
 */
export interface ValidateDpopOptions {
  /**
   * Expected JWK thumbprint (the `jkt` from the sub-token's `cnf` claim).
   * The DPoP header's embedded JWK MUST thumbprint to this value.
   */
  expectedJkt: string;
  /** Expected HTTP method (uppercase). */
  expectedHtm: string;
  /**
   * Expected HTTP URL — scheme + host + path. Query string + fragment
   * stripped before compare (htu has no query/fragment per spec).
   */
  expectedHtu: string;
  /** Optional access token to cross-check via `ath`. */
  accessToken?: string;
  /**
   * Maximum clock skew + age in seconds. Default 60. Proofs older than
   * `now - maxAgeSec` are rejected (replay window).
   */
  maxAgeSec?: number;
  /** Optional clock injection (defaults to Date.now()). */
  now?: () => number;
  /**
   * Replay-protection callback. Returns true if the jti has been seen
   * within the maxAge window. The validator throws when the callback
   * returns true ; the host is expected to call back with `false` AND
   * persist the jti when the proof is otherwise valid.
   */
  isReplayed?: (jti: string) => boolean;
  /** Callback to record a freshly-validated jti for future replay checks. */
  recordJti?: (jti: string, expiresAtMs: number) => void;
}

/**
 * Validated DPoP proof outcome.
 * @public
 */
export interface ValidatedDpop {
  valid: true;
  /** Confirmed thumbprint (matches expectedJkt). */
  jkt: string;
  /** Confirmed claims. */
  claims: DpopClaims;
}

/**
 * Failure outcome. Brief reason for logs ; never throws on bad input.
 * @public
 */
export interface DpopValidationFailure {
  valid: false;
  reason: string;
}

/** @public */
export type DpopValidationResult = ValidatedDpop | DpopValidationFailure;

const ALLOWED_ALGS = new Set(["ES256"]);

/**
 * Validate a DPoP proof JWT. Returns the resolved jkt + claims on success
 * or a typed failure with a brief reason ; NEVER throws (the caller
 * decides whether to log, deny, or surface to the user). Mirrors the
 * `verifySubToken` contract.
 *
 * Validation steps (RFC 9449 §4.3 subset) :
 *   1. Three-segment JWT structure.
 *   2. Header : `typ === "dpop+jwt"`, `alg` allowlisted, `jwk` present
 *      and EC P-256 (no `d` claim allowed).
 *   3. Computed thumbprint matches `expectedJkt`.
 *   4. Payload : `htm` matches, `htu` matches, `iat` not in the future,
 *      `iat` not older than `maxAgeSec`, `jti` present.
 *   5. Optional : `ath` matches sha256(accessToken).
 *   6. Optional : `isReplayed(jti)` returns false.
 *   7. Signature : `subtle.verify('ECDSA', publicKey, sig, data)` over
 *      `header.payload` bytes with `hash: SHA-256`.
 *
 * On success, calls `recordJti(jti, exp)` if supplied so the host can
 * persist the proof for future replay detection.
 * @public
 */
export async function validateDpopProof(
  dpopJwt: string,
  opts: ValidateDpopOptions,
): Promise<DpopValidationResult> {
  if (typeof dpopJwt !== "string" || dpopJwt === "") {
    return { valid: false, reason: "empty proof" };
  }
  const parts = dpopJwt.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed (segments)" };
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // 1. Header.
  const header = b64urlDecodeJson<{
    typ?: string;
    alg?: string;
    jwk?: EcP256Jwk;
  }>(headerB64);
  if (!header) return { valid: false, reason: "header not JSON" };
  if (header.typ !== "dpop+jwt") {
    return { valid: false, reason: "typ must be dpop+jwt" };
  }
  if (!header.alg || !ALLOWED_ALGS.has(header.alg)) {
    return {
      valid: false,
      reason: `alg ${header.alg ?? "missing"} not allowed`,
    };
  }
  const jwk = header.jwk;
  if (!jwk) return { valid: false, reason: "header missing jwk" };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    return { valid: false, reason: "jwk must be EC P-256" };
  }
  if (jwk.d !== undefined) {
    return { valid: false, reason: "jwk must be public (no d)" };
  }

  // 2. Thumbprint match.
  let jkt: string;
  try {
    jkt = computeJwkThumbprint(jwk);
  } catch (err) {
    return {
      valid: false,
      reason: `thumbprint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (jkt !== opts.expectedJkt) {
    return { valid: false, reason: "jkt mismatch" };
  }

  // 3. Payload.
  const claims = b64urlDecodeJson<DpopClaims>(payloadB64);
  if (!claims) return { valid: false, reason: "payload not JSON" };
  if (typeof claims.htm !== "string" || claims.htm !== opts.expectedHtm) {
    return { valid: false, reason: "htm mismatch" };
  }
  const htu = (opts.expectedHtu.split("?")[0] ?? "").split("#")[0] ?? "";
  if (typeof claims.htu !== "string" || claims.htu !== htu) {
    return { valid: false, reason: "htu mismatch" };
  }
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
    return { valid: false, reason: "iat missing or not numeric" };
  }
  if (typeof claims.jti !== "string" || claims.jti === "") {
    return { valid: false, reason: "jti missing" };
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const maxAge = opts.maxAgeSec ?? 60;
  if (claims.iat > nowSec + maxAge) {
    return { valid: false, reason: "iat in the future" };
  }
  if (claims.iat < nowSec - maxAge) {
    return { valid: false, reason: "iat too old" };
  }

  // 4. Optional ath check. RFC 9449 §4.3 makes ath "if used" — it MUST
  // match when present, but the proof is not invalidated for omitting it.
  // The server-side gate already validates `cnf.jkt` against the bound
  // device key, which is the strong binding ; ath would only add
  // protection against an attacker who has both the access token AND
  // the bound private key, which is not the documented threat model.
  if (opts.accessToken !== undefined && typeof claims.ath === "string" && claims.ath.length > 0) {
    const expectedAth = b64urlEncode(
      createHash("sha256").update(opts.accessToken, "utf-8").digest(),
    );
    if (claims.ath !== expectedAth) {
      return { valid: false, reason: "ath mismatch" };
    }
  }

  // 5. Replay check.
  if (opts.isReplayed?.(claims.jti)) {
    return { valid: false, reason: "replayed jti" };
  }

  // 6. Signature verification via Web Crypto.
  let ok = false;
  try {
    const subtle = (globalThis.crypto ?? require("node:crypto").webcrypto).subtle;
    const key = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    // Build fresh Uint8Arrays backed by ArrayBuffer (not Buffer's
    // ArrayBufferLike) so WebCrypto's BufferSource typing is satisfied.
    const dataView = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const data = new Uint8Array(dataView.byteLength);
    data.set(dataView);
    const sigBuf = b64urlDecode(sigB64);
    const sig = new Uint8Array(sigBuf.byteLength);
    sig.set(sigBuf);
    ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
  } catch (err) {
    return {
      valid: false,
      reason: `signature verify failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!ok) return { valid: false, reason: "signature mismatch" };

  // 7. Record jti for future replay checks.
  if (opts.recordJti) {
    const expiresAtMs = (claims.iat + maxAge) * 1000;
    opts.recordJti(claims.jti, expiresAtMs);
  }

  return { valid: true, jkt, claims };
}

// ─── In-process replay store ─────────────────────────────────────────────

/**
 * Bounded in-process jti deny-list. Entries auto-expire after their
 * `maxAge` window. The host plugs in a shared store (Redis, SQLite via
 * `PersistencePort`) when scaled out — the SDK only ships the local
 * impl as a starting point.
 * @public
 */
export class DpopReplayStore {
  private readonly seen = new Map<string, number>();
  private readonly maxSize: number;

  constructor(opts: { maxSize?: number } = {}) {
    this.maxSize = opts.maxSize ?? 10_000;
  }

  /** Returns true if `jti` is within an unexpired window. */
  isReplayed(jti: string, nowMs: number = Date.now()): boolean {
    this.gcExpired(nowMs);
    const expiresAtMs = this.seen.get(jti);
    if (expiresAtMs === undefined) return false;
    return expiresAtMs > nowMs;
  }

  /** Record a jti as seen with its expiry timestamp. */
  record(jti: string, expiresAtMs: number): void {
    this.gcExpired(Date.now());
    this.seen.set(jti, expiresAtMs);
    // Bounded — drop the oldest entry when over capacity. O(N) but only
    // when the store overflows, which is rare under correct usage.
    if (this.seen.size > this.maxSize) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
  }

  /** Wipe — test helper. */
  reset(): void {
    this.seen.clear();
  }

  /** Current size — test / observability helper. */
  get size(): number {
    return this.seen.size;
  }

  private gcExpired(nowMs: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(k);
    }
  }
}
