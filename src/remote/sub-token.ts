/**
 * Capability-scoped sub-token — HMAC-attenuated handoff (T6f).
 *
 * The remote-control server starts with a single parent token (the one
 * displayed in the QR / printed by `preste --remote`). For collaborator
 * handoff (`preste remote share --scope read-only --ttl 1h`), the parent
 * mints a sub-token carrying a scope and an expiry, signed with HMAC-SHA256
 * against the parent token.
 *
 * The server verifies in O(1): recompute HMAC, constant-time compare. No
 * key registry, no per-session state, no WASM. The sub-token is a JWT-like
 * `<payload>.<signature>` (base64url) but with a compact 1-version payload
 * and `parent` as the HMAC key (no key id, single-tenant).
 *
 * Scope hierarchy (lowest privilege first):
 *
 *   read-only      observe : /remote/health, /remote/state, /remote/stream
 *   approve-only   read-only + HITL : /remote/hitl/*, /remote/veto/*
 *   full           everything : adds /remote/inject (mid-run steering)
 *
 * A `full` sub-token still expires (TTL-bounded delegation). The parent
 * token itself never expires — its lifetime is the running session.
 *
 * Design choices :
 *   - HMAC-SHA256, not Biscuit. Biscuit is in the workspace (bastion-api uses
 *     `@biscuit-auth/biscuit-wasm` 0.6.0) but pulls in a WASM blob and a
 *     datalog policy language. T6f MVP doesn't need further attenuation by
 *     the delegatee — the founder hands ONE bounded token. If chained
 *     delegation arrives later, that's when Biscuit earns its weight.
 *   - base64url, not raw hex : URL-safe for QR / share UIs.
 *   - `jti` is a random 6-byte id : not used by the server (no revocation
 *     list yet), but unique per mint for log correlation.
 *
 * @public @since 2.18.0 — preste remote-control T6f
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type EcP256Jwk, computeJwkThumbprint } from "./dpop.js";

// ─── Scopes ──────────────────────────────────────────────────────────────────

/**
 * Capability scopes, lowest-privilege first.
 * @public
 */
export type SubTokenScope = "read-only" | "approve-only" | "full";

/** Rank function — higher = more privilege. */
const SCOPE_RANK: Record<SubTokenScope, number> = {
  "read-only": 0,
  "approve-only": 1,
  full: 2,
};

/**
 * True iff `granted` covers `required`.
 * @public
 */
export function scopeCovers(granted: SubTokenScope, required: SubTokenScope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

// ─── Claims + mint ───────────────────────────────────────────────────────────

/**
 * Sub-token payload shape. v1 only.
 * @public
 */
export interface SubTokenClaims {
  /** Format version. Always 1 in v1. */
  v: 1;
  /** Capability scope granted by this token. */
  scope: SubTokenScope;
  /** Unix epoch seconds — the token MUST be rejected at or after this time. */
  exp: number;
  /** Random per-mint id (12 hex chars). For log correlation, not revocation. */
  jti: string;
  /**
   * Optional confirmation claim (RFC 7800 §3.1 + RFC 9449 §6.1). When
   * present, the bearer alone is not enough — every request must also
   * carry a DPoP proof JWT signed by the key whose JWK thumbprint is
   * `cnf.jkt`. See `remote/dpop.ts` for the validator. (P1b)
   */
  cnf?: { jkt: string };
}

/**
 * Options for `mintSubToken`.
 * @public
 */
export interface MintSubTokenOptions {
  /** The parent session token (typically the one shown in the QR). */
  parentToken: string;
  /** Scope to grant. */
  scope: SubTokenScope;
  /** Time-to-live in seconds. Caller computes from a duration string upstream. */
  ttlSec: number;
  /** Optional clock injection (defaults to `Date.now()`). */
  now?: () => number;
  /**
   * Optional device-binding via RFC 7800 confirmation claim. When set,
   * the resulting sub-token is sender-constrained : the holder must
   * present a DPoP proof JWT (signed by the matching private key) on
   * every request. See `remote/dpop.ts`. (P1b)
   */
  cnf?: { jkt: string };
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf;
  return b.toString("base64url");
}

function b64urlDecodeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Mint a sub-token attenuated from `parentToken`.
 *
 * The returned string is `<payloadB64>.<sigB64>`, safe to embed in URLs / QR
 * codes. Anyone holding the parent token can verify it; nobody else can.
 * @public
 */
export function mintSubToken(opts: MintSubTokenOptions): string {
  if (opts.parentToken === "") {
    throw new Error("mintSubToken: parentToken cannot be empty");
  }
  if (!Number.isInteger(opts.ttlSec) || opts.ttlSec <= 0) {
    throw new Error("mintSubToken: ttlSec must be a positive integer");
  }
  if (!(opts.scope in SCOPE_RANK)) {
    throw new Error(`mintSubToken: unknown scope "${opts.scope}"`);
  }
  const now = opts.now ? opts.now() : Date.now();
  if (opts.cnf !== undefined) {
    if (typeof opts.cnf.jkt !== "string" || opts.cnf.jkt === "") {
      throw new Error("mintSubToken: cnf.jkt must be a non-empty string");
    }
  }
  const claims: SubTokenClaims = {
    v: 1,
    scope: opts.scope,
    exp: Math.floor(now / 1000) + opts.ttlSec,
    jti: randomBytes(6).toString("hex"),
    ...(opts.cnf ? { cnf: { jkt: opts.cnf.jkt } } : {}),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(claims));
  const sig = createHmac("sha256", opts.parentToken).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

// ─── Verify ──────────────────────────────────────────────────────────────────

/**
 * Outcome of `verifySubToken`.
 * @public
 */
export interface VerifySubTokenResult {
  valid: boolean;
  /** Present iff `valid === true`. */
  scope?: SubTokenScope;
  /** Present iff `valid === false`. Brief reason for logs / metrics. */
  reason?: string;
  /** Present iff `valid === true`. Useful for log correlation. */
  jti?: string;
  /**
   * Present iff `valid === true` AND the token carries a `cnf` claim
   * (P1b device-binding). When set, the caller MUST also validate a
   * DPoP proof JWT against `cnf.jkt` via `validateDpopProof` before
   * granting the scope. (Bearer-only acceptance of a device-bound
   * sub-token would defeat the binding.)
   */
  cnf?: { jkt: string };
}

/**
 * Verify a sub-token against `parentToken`. Returns scope on success, or
 * a typed reason on failure. NEVER throws on malformed input — the caller
 * decides whether to log, deny, or surface to the user.
 * @public
 */
export function verifySubToken(
  parentToken: string,
  token: string,
  now: number = Date.now(),
): VerifySubTokenResult {
  if (token === "" || !token.includes(".")) {
    return { valid: false, reason: "malformed" };
  }
  const [payloadB64, sigB64] = token.split(".", 2);
  if (!payloadB64 || !sigB64) return { valid: false, reason: "malformed" };

  const claims = b64urlDecodeJson<SubTokenClaims>(payloadB64);
  if (!claims) return { valid: false, reason: "payload not JSON" };
  if (claims.v !== 1) return { valid: false, reason: `unsupported version ${claims.v}` };
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { valid: false, reason: "exp missing or not numeric" };
  }
  if (typeof claims.scope !== "string" || !(claims.scope in SCOPE_RANK)) {
    return { valid: false, reason: "scope missing or unknown" };
  }
  if (Math.floor(now / 1000) >= claims.exp) {
    return { valid: false, reason: "expired" };
  }

  const expected = createHmac("sha256", parentToken).update(payloadB64).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(sigB64, "base64url");
  } catch {
    return { valid: false, reason: "signature decode failed" };
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { valid: false, reason: "signature mismatch" };
  }

  return {
    valid: true,
    scope: claims.scope,
    ...(typeof claims.jti === "string" ? { jti: claims.jti } : {}),
    ...(claims.cnf && typeof claims.cnf.jkt === "string" ? { cnf: { jkt: claims.cnf.jkt } } : {}),
  };
}

/**
 * Resolve the effective scope for an incoming Authorization Bearer string.
 *
 * Returns:
 *   - "full" when the presented token equals the parent token byte-for-byte
 *     (the founder, full session control).
 *   - the sub-token's scope when the presented token verifies as a sub-token.
 *   - undefined when the presented token is unrecognised / expired / forged
 *     / revoked (when `isRevoked(jti)` returns true).
 *
 * The `now` injection mirrors `verifySubToken` for testability. The optional
 * `isRevoked` callback lets the host plug in its revocation store (e.g.
 * the http-server's in-memory `revokedJtis` Set) without coupling the SDK
 * to any persistence layer.
 * @public
 */
export function resolveAuthScope(
  parentToken: string,
  presentedToken: string,
  now: number = Date.now(),
  isRevoked?: (jti: string) => boolean,
): SubTokenScope | undefined {
  if (parentToken === "") return undefined;
  if (presentedToken === "") return undefined;
  // Constant-time parent token compare.
  const ab = Buffer.from(parentToken);
  const bb = Buffer.from(presentedToken);
  if (ab.length === bb.length && timingSafeEqual(ab, bb)) {
    return "full";
  }
  const v = verifySubToken(parentToken, presentedToken, now);
  if (!v.valid) return undefined;
  // Revocation gate — when an `isRevoked` callback is supplied, a `jti`
  // that returns true demotes the token to "unauthorized" the same way
  // signature failure or expiry would.
  if (isRevoked && typeof v.jti === "string" && isRevoked(v.jti)) {
    return undefined;
  }
  return v.scope;
}

// ─── Rebind (P1b-2 device-binding handshake) ─────────────────────────────────

/**
 * Options for `rebindSubToken`.
 * @public
 */
export interface RebindSubTokenOptions {
  /** Parent session token (same one that minted `oldSubToken`). */
  parentToken: string;
  /** Currently-valid bearer sub-token to upgrade. MUST NOT already carry cnf. */
  oldSubToken: string;
  /** Device public key (JWK). Its thumbprint will be bound into `cnf.jkt`. */
  jwk: EcP256Jwk;
  /** Optional clock injection (defaults to `Date.now()`). */
  now?: () => number;
}

/**
 * Result of `rebindSubToken`.
 * @public
 */
export interface RebindSubTokenResult {
  /** New sender-constrained sub-token. */
  subToken: string;
  /** Unix epoch ms for the new expiry (same as old — TTL inherited). */
  expiresAt: number;
  /** Scope (carried over from the old sub-token). */
  scope: SubTokenScope;
  /** jti of the OLD sub-token. The caller MUST add it to the revocation list. */
  oldJti: string;
  /** jti of the NEW sub-token (for log correlation). */
  newJti: string;
}

/**
 * Rebind a bearer sub-token to a device keypair via RFC 7800 `cnf` claim.
 *
 * Used by the PWA after pairing : the bearer sub-token from the QR is
 * upgraded to a sender-constrained token bound to a P-256 key generated
 * non-extractably in IndexedDB. The new token's TTL + scope are inherited
 * from the old one — the caller is responsible for revoking `oldJti`
 * server-side immediately after a successful rebind.
 *
 * @throws Error with a `code` property on validation failure :
 *   - `parent_missing`     — parentToken empty
 *   - `old_malformed`      — oldSubToken not a `<payload>.<sig>` pair
 *   - `old_invalid`        — HMAC fails, payload decode fails, etc
 *   - `old_expired`        — exp already passed
 *   - `already_bound`      — oldSubToken already carries cnf claim
 *   - `jwk_invalid`        — wrong kty/crv or missing x/y
 *   - `jwk_private`        — JWK carries `d` (private scalar)
 *
 * @public @since 2.26.0 — P1b-2 PWA DPoP handshake
 */
export function rebindSubToken(opts: RebindSubTokenOptions): RebindSubTokenResult {
  if (opts.parentToken === "") {
    throw Object.assign(new Error("rebindSubToken: parentToken required"), {
      code: "parent_missing",
    });
  }
  if (opts.oldSubToken === "" || !opts.oldSubToken.includes(".")) {
    throw Object.assign(new Error("rebindSubToken: oldSubToken malformed"), {
      code: "old_malformed",
    });
  }
  const j = opts.jwk;
  if (!j || j.kty !== "EC" || j.crv !== "P-256") {
    throw Object.assign(new Error("rebindSubToken: jwk must be EC P-256"), {
      code: "jwk_invalid",
    });
  }
  if (typeof j.x !== "string" || typeof j.y !== "string" || j.x === "" || j.y === "") {
    throw Object.assign(new Error("rebindSubToken: jwk.x and jwk.y required"), {
      code: "jwk_invalid",
    });
  }
  if ((j as { d?: unknown }).d !== undefined) {
    throw Object.assign(new Error("rebindSubToken: jwk must not carry private scalar d"), {
      code: "jwk_private",
    });
  }
  const now = opts.now ? opts.now() : Date.now();
  const verification = verifySubToken(opts.parentToken, opts.oldSubToken, now);
  if (!verification.valid || !verification.scope || !verification.jti) {
    throw Object.assign(
      new Error(`rebindSubToken: oldSubToken invalid — ${verification.reason ?? "unknown"}`),
      {
        code: verification.reason === "expired" ? "old_expired" : "old_invalid",
      },
    );
  }
  if (verification.cnf) {
    throw Object.assign(
      new Error("rebindSubToken: oldSubToken already device-bound — revoke then re-mint"),
      { code: "already_bound" },
    );
  }
  // Inherit remaining TTL from the old claims (read directly from payload).
  const oldPayloadB64 = opts.oldSubToken.split(".", 2)[0];
  const oldClaims = b64urlDecodeJson<SubTokenClaims>(oldPayloadB64 ?? "");
  if (!oldClaims) {
    throw Object.assign(new Error("rebindSubToken: payload decode failed"), {
      code: "old_invalid",
    });
  }
  const remainingTtl = oldClaims.exp - Math.floor(now / 1000);
  if (remainingTtl <= 0) {
    throw Object.assign(new Error("rebindSubToken: oldSubToken expired"), {
      code: "old_expired",
    });
  }
  const jkt = computeJwkThumbprint(j);
  const subToken = mintSubToken({
    parentToken: opts.parentToken,
    scope: verification.scope,
    ttlSec: remainingTtl,
    ...(opts.now ? { now: opts.now } : {}),
    cnf: { jkt },
  });
  const newPayloadB64 = subToken.split(".", 2)[0];
  const newClaims = b64urlDecodeJson<SubTokenClaims>(newPayloadB64 ?? "");
  return {
    subToken,
    expiresAt: (newClaims?.exp ?? oldClaims.exp) * 1000,
    scope: verification.scope,
    oldJti: verification.jti,
    newJti: newClaims?.jti ?? "",
  };
}
