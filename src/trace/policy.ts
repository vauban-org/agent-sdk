/**
 * PayloadPolicy — 4-axis payload handling policy for trace steps.
 *
 * Axes:
 *   include    — store the full (optionally PII-redacted) payload
 *   redact     — remove PII fields before storing; hash the original
 *   hmac       — hash + HMAC(original, out-of-band key); no plaintext stored
 *   hash-only  — SHA-256 of canonical payload; no plaintext, no HMAC
 *
 * defaultPolicy(env, piiFields?) — fail-closed in production:
 *   - prod without piiFields → throws PRODUCTION_PII_FIELDS_REQUIRED
 *   - prod with piiFields    → { kind: 'redact', piiFields } (no detector by default, R8-I3)
 *   - dev                    → { kind: 'include' } (full payloads for debugging)
 *
 * STRICT_PII_DETECTOR is opt-in only — never activated by defaultPolicy.
 *
 * @module trace/policy
 */

import { canonicalize } from "./canonical.js";

// ─── PIIDetector port ────────────────────────────────────────────────────────

/**
 * A function that returns true when the given field value is suspected
 * to contain PII. Used to extend structural redaction (piiFields) with
 * heuristic scanning.
 *
 * NOTE: defaultPolicy does NOT activate a PIIDetector by default (R8-I3).
 * Opt in explicitly: { kind: 'redact', piiFields: [...], piiDetector: STRICT_PII_DETECTOR }
 * @public
 */
export type PIIDetector = (value: unknown) => boolean;

// ─── PayloadPolicy discriminated union ───────────────────────────────────────

/** Store the full payload (PII fields removed if present). Dev-safe. */
export interface IncludePolicy {
  kind: "include";
}

/** Remove piiFields from the stored payload. HMAC the original for auditability. */
export interface RedactPolicy {
  kind: "redact";
  /** Field names to remove from the payload before storage. */
  piiFields: readonly string[];
  /**
   * Optional detector run on every value in the payload. When it fires,
   * the owning key is redacted even if not in piiFields.
   * Intentionally absent by default (R8-I3 — false-positive risk).
   */
  piiDetector?: PIIDetector;
}

/** HMAC-SHA-256(canonical(original), key) + SHA-256 hash. No plaintext stored. */
export interface HmacPolicy {
  kind: "hmac";
  /** Key provider for HMAC operations. */
  keyProvider: import("../ports/key-provider.js").KeyProvider;
  /** Key identifier passed to keyProvider.getKey(). */
  keyId: string;
}

/** SHA-256(canonical(payload)) only. No plaintext, no HMAC. */
export interface HashOnlyPolicy {
  kind: "hash-only";
}

/**
 * Discriminated union of all supported payload policies.
 * @public
 */
export type PayloadPolicy = IncludePolicy | RedactPolicy | HmacPolicy | HashOnlyPolicy;

// ─── SHA-256 via Web Crypto (zero external deps) ─────────────────────────────

/**
 * Compute SHA-256 of a UTF-8 string using Web Crypto API.
 * Requires Node >= 20 (globalThis.crypto.subtle available).
 */
async function sha256(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return bufferToHex(hashBuffer);
}

/**
 * Compute HMAC-SHA-256 of a UTF-8 string using Web Crypto API.
 * @param input   The message to sign.
 * @param key     Raw key bytes.
 */
async function hmacSha256(input: string, key: Uint8Array): Promise<string> {
  // Ensure we have a plain ArrayBuffer (SharedArrayBuffer is not accepted by importKey)
  const keyBuffer =
    key.buffer instanceof ArrayBuffer
      ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength)
      : new Uint8Array(key).buffer;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = new TextEncoder().encode(input);
  const sigBuffer = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, encoded);
  return bufferToHex(sigBuffer);
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Redaction helpers ────────────────────────────────────────────────────────

/**
 * Deep-redact piiFields and optionally piiDetector from an object.
 * Returns a new object — never mutates input.
 */
function deepRedact(
  value: unknown,
  piiFields: ReadonlySet<string>,
  piiDetector: PIIDetector | undefined,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => deepRedact(item, piiFields, piiDetector));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (piiFields.has(k)) {
      result[k] = "[REDACTED]";
    } else if (piiDetector?.(v)) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = deepRedact(v, piiFields, piiDetector);
    }
  }
  return result;
}

// ─── payloadHash ─────────────────────────────────────────────────────────────

/**
 * Result of applying a PayloadPolicy to a value.
 * @public
 */
export interface PayloadHashResult {
  /** Hex-encoded SHA-256 of canonical(processed_value). */
  hash: string;
  /** The effective policy kind that was applied. */
  policy: PayloadPolicy["kind"];
  /**
   * The processed payload to store inline in the trace step.
   * undefined for 'hmac' and 'hash-only' policies.
   */
  storedValue?: unknown;
  /**
   * HMAC-SHA-256(canonical(original), key).
   * Present only when policy is 'hmac'.
   */
  hmac?: string;
}

/**
 * Compute SHA-256(canonical(processed_value)) according to a PayloadPolicy.
 *
 * - include:   stores the full value; hash = SHA-256(canonical(value))
 * - redact:    stores redacted value; hash = SHA-256(canonical(redacted))
 * - hmac:      stores nothing; hash = SHA-256(canonical(value)); hmac = HMAC(canonical(value), key)
 * - hash-only: stores nothing; hash = SHA-256(canonical(value))
 * @public
 */
export async function payloadHash(
  value: unknown,
  policy: PayloadPolicy,
): Promise<PayloadHashResult> {
  const canonical = canonicalize(value);

  switch (policy.kind) {
    case "include": {
      const hash = await sha256(canonical);
      return { hash, policy: "include", storedValue: value };
    }

    case "redact": {
      const piiSet = new Set(policy.piiFields);
      const redacted = deepRedact(value, piiSet, policy.piiDetector);
      const redactedCanonical = canonicalize(redacted);
      const hash = await sha256(redactedCanonical);
      return { hash, policy: "redact", storedValue: redacted };
    }

    case "hmac": {
      const hash = await sha256(canonical);
      const key = await policy.keyProvider.getKey(policy.keyId);
      const hmac = await hmacSha256(canonical, key);
      return { hash, policy: "hmac", hmac };
    }

    case "hash-only": {
      const hash = await sha256(canonical);
      return { hash, policy: "hash-only" };
    }
  }
}

// ─── defaultPolicy ───────────────────────────────────────────────────────────

/**
 * Factory for sensible default PayloadPolicies.
 *
 * Fail-closed production contract (CH2):
 *   - Calling defaultPolicy('prod') without piiFields throws immediately.
 *     This forces the caller to declare what PII exists — silence is not
 *     consent in a production compliance context.
 *   - To explicitly opt out of redaction in prod, use { kind: 'include' }
 *     directly and accept the WARNING that will be logged at boot.
 *
 * STRICT_PII_DETECTOR is NOT activated by this function (R8-I3).
 * Activate it explicitly: { kind: 'redact', piiFields: [...], piiDetector: STRICT_PII_DETECTOR }
 *
 * @param env        'dev' or 'prod'
 * @param piiFields  Required in prod. Field names to structurally redact.
 * @public
 */
export function defaultPolicy(env: "dev" | "prod", piiFields?: readonly string[]): PayloadPolicy {
  if (env === "prod") {
    if (!piiFields || piiFields.length === 0) {
      throw new Error(
        "PRODUCTION_PII_FIELDS_REQUIRED: production policy requires non-empty piiFields. " +
          "Use { kind: 'include' } explicitly to opt out (will log a WARNING at boot).",
      );
    }
    // piiDetector intentionally absent by default (R8-I3)
    return { kind: "redact", piiFields };
  }
  return { kind: "include" };
}
