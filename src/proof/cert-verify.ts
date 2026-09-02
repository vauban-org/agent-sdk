/**
 * Run Certificate verifier — standalone surface for external clients (CLI, dashboards).
 *
 * This module is the **single source of truth** for offline verification of a
 * `SignedRunProofCertificate`. The CC server (`src/proof/ed25519-{signer,verifier}.ts`)
 * holds the signing side (DB-coupled assembly + signing); this module holds the
 * verification side, which is intentionally dependency-free (no DB, no MCP).
 *
 * Pipeline (mirrors server signer):
 *   1. Strip embedded `signature` field
 *   2. JCS-canonicalize (RFC 8785 subset: sorted keys, -0 → 0)
 *   3. SHA-256 → first 31 bytes → felt252-safe
 *   4. Poseidon([0x1, sha_felt, CERT_MARKER_FELT]) → cert_hash_felt252
 *   5. Felt → 32-byte buffer → Ed25519 verify
 *
 * Domain separator: `CERT_MARKER_FELT` = UTF-8 "run_cert" felt252 (right-aligned).
 *
 * The signer half lives server-side ; this module is the verifier half and
 * depends on nothing but `node:crypto` and `starknet`.
 * @public
 */

import { type KeyObject, createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { hash } from "starknet";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Ed25519 signature payload embedded in `SignedRunProofCertificate`.
 *
 * Two generations coexist, both self-describing (mirrors the CLI store):
 * - v2 (CANONICAL, current): `kid` + `pubkey_spki_b64` + `cert_hash_felt252`
 *   (Poseidon felt252, draft-vauban-skill-attestation-00 §5). Ed25519 signs
 *   the 32-byte felt252 projection of the JCS-canonical unsigned cert.
 * - v1 (LEGACY, read-only compat): `pubkey` (hex) + `digest` (SHA-256 hex),
 *   Ed25519 over the raw canonical UTF-8 bytes. Pre-dates the Poseidon
 *   alignment (VULN-001 audit 2026-08-01) ; kept verifiable forever.
 *
 * Detection: presence of `cert_hash_felt252` ⇒ v2, else `digest` ⇒ v1.
 */
export interface SignaturePayload {
  alg: "Ed25519";
  /** v2: stable key id = sha256(SPKI DER).slice(0,16) hex (matches CC server). */
  kid: string;
  /** Ed25519 signature — base64 (v2) or hex (v1). */
  value: string;
  /** v2: base64 SPKI DER public key (matches CC server `pubkey_spki_b64`). */
  pubkey_spki_b64: string;
  /** v2: Poseidon([0x1, sha_felt, CERT_MARKER_FELT]) felt252 of unsigned cert. */
  cert_hash_felt252: string;
  /** v1 (legacy): hex-encoded public key (32 bytes). */
  pubkey?: string;
  /** v1 (legacy): SHA-256 hex digest of the canonical unsigned cert. */
  digest?: string;
  signed_at: string;
}

export type CertPayloadGen = "v1" | "v2";

/** Detect the payload generation from the self-describing signature fields. */
export function detectPayloadGen(sig: SignaturePayload): CertPayloadGen {
  return typeof sig.cert_hash_felt252 === "string" ? "v2" : "v1";
}

/**
 * A `SignedRunProofCertificate` for verification purposes — only the fields
 * the verifier touches are typed. The cert may carry additional fields
 * (decision_chain, merkle_root, etc.) which the verifier preserves but does
 * not inspect.
 */
export interface SignedRunProofCertificateLike {
  signature?: SignaturePayload;
  // ... plus arbitrary other fields, opaque to the verifier
  [key: string]: unknown;
}

export type CertVerifyFailReason =
  | "missing_signature"
  | "wrong_alg"
  | "hash_mismatch"
  | "pubkey_unresolvable"
  | "kid_mismatch"
  | "signature_invalid"
  | "malformed_signature";

export interface CertVerifyResult {
  valid: boolean;
  reason?: CertVerifyFailReason;
  details?: string;
  recomputed_cert_hash_felt252: string;
}

export interface CertVerifyOptions {
  expectedPublicKey?: KeyObject;
  expectedKid?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Domain separator: UTF-8 "run_cert" → felt252 right-aligned, zero-padded. */
export const CERT_MARKER_FELT: string = `0x${Buffer.from("run_cert", "utf8").toString("hex").padStart(62, "0")}`;

// ─── JCS canonicalization (RFC 8785 subset) ──────────────────────────────────

function normalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = normalizeValue(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * RFC 8785 subset canonicalization (sorted keys, -0 → 0). Exported so other
 * commitment surfaces (e.g. `pay/authorization-policy.ts`) hash over the same
 * canonical bytes as the Run Certificate pipeline — one canonicalizer, one
 * byte-for-byte commitment grammar.
 */
export function canonicalizeJcs(data: Record<string, unknown>): string {
  return JSON.stringify(normalizeValue(data));
}

// ─── Felt helpers ─────────────────────────────────────────────────────────────

function felt252ToBytes(felt: string): Buffer {
  const hex = felt.replace(/^0x/, "").padStart(64, "0");
  return Buffer.from(hex, "hex");
}

/**
 * Compute the felt252 hash that Ed25519 signs over for a Run Certificate.
 * Strips any embedded `signature` field before hashing — verification is
 * idempotent.
 */
export function computeCertHashFelt252(cert: SignedRunProofCertificateLike): string {
  const { signature: _stripped, ...unsigned } = cert;
  void _stripped;
  const canonical = canonicalizeJcs(unsigned as Record<string, unknown>);
  const sha = createHash("sha256").update(canonical, "utf8").digest("hex");
  const shaFelt = `0x${sha.substring(0, 62)}`;
  return hash.computePoseidonHashOnElements(["0x1", shaFelt, CERT_MARKER_FELT]);
}

/**
 * Compute the v1 legacy SHA-256 digest of the JCS-canonical unsigned cert.
 * Strips any embedded `signature` field before hashing — idempotent.
 */
export function computeCertDigestSha256(cert: SignedRunProofCertificateLike): string {
  const { signature: _stripped, ...unsigned } = cert;
  void _stripped;
  const canonical = canonicalizeJcs(unsigned as Record<string, unknown>);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── Public-key reconstruction ────────────────────────────────────────────────

/**
 * Reconstruct an Ed25519 `KeyObject` from base64 SPKI DER (as embedded in
 * `signature.pubkey_spki_b64`).
 *
 * @throws if base64 is malformed or the key is not Ed25519.
 */
export function publicKeyFromSpkiB64(pubkeySpkiB64: string): KeyObject {
  const der = Buffer.from(pubkeySpkiB64, "base64");
  if (der.length === 0) {
    throw new Error("[cert-verify] empty SPKI buffer");
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`[cert-verify] SPKI is not Ed25519 (got ${key.asymmetricKeyType})`);
  }
  return key;
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

/**
 * Verify a signed Run Certificate. Returns a structured result — never throws
 * on verification failure (only on malformed input).
 *
 * The 7 possible failure reasons are typed via `CertVerifyFailReason` so callers
 * can branch precisely. `recomputed_cert_hash_felt252` is always returned for
 * audit trail / debug inspection.
 */
export function verifyRunCertificate(
  cert: SignedRunProofCertificateLike,
  opts: CertVerifyOptions = {},
): CertVerifyResult {
  const sig = cert.signature;
  if (!sig) {
    return {
      valid: false,
      reason: "missing_signature",
      recomputed_cert_hash_felt252: "",
    };
  }
  if (sig.alg !== "Ed25519") {
    return {
      valid: false,
      reason: "wrong_alg",
      details: `expected Ed25519, got ${String(sig.alg)}`,
      recomputed_cert_hash_felt252: "",
    };
  }

  // Self-describing payload: v2 (Poseidon) if cert_hash_felt252 present,
  // else v1 (legacy SHA-256 digest). Both remain verifiable forever.
  if (detectPayloadGen(sig) === "v1") {
    return verifyRunCertificateV1(cert, sig, opts);
  }

  const recomputed = computeCertHashFelt252(cert);

  if (sig.cert_hash_felt252 !== recomputed) {
    return {
      valid: false,
      reason: "hash_mismatch",
      details: `embedded=${sig.cert_hash_felt252} recomputed=${recomputed}`,
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  if (opts.expectedKid && opts.expectedKid !== sig.kid) {
    return {
      valid: false,
      reason: "kid_mismatch",
      details: `expected kid=${opts.expectedKid}, got ${sig.kid}`,
      recomputed_cert_hash_felt252: recomputed,
    };
  }

  let pubkey: KeyObject;
  if (opts.expectedPublicKey) {
    pubkey = opts.expectedPublicKey;
  } else {
    try {
      pubkey = publicKeyFromSpkiB64(sig.pubkey_spki_b64);
    } catch (err) {
      return {
        valid: false,
        reason: "pubkey_unresolvable",
        details: err instanceof Error ? err.message : String(err),
        recomputed_cert_hash_felt252: recomputed,
      };
    }
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sig.value, "base64");
  } catch {
    return {
      valid: false,
      reason: "malformed_signature",
      details: "signature.value is not valid base64",
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  if (sigBytes.length !== 64) {
    return {
      valid: false,
      reason: "malformed_signature",
      details: `Ed25519 signature must be 64 bytes (got ${sigBytes.length})`,
      recomputed_cert_hash_felt252: recomputed,
    };
  }

  const msgBytes = felt252ToBytes(recomputed);
  const ok = cryptoVerify(null, msgBytes, pubkey, sigBytes);
  if (!ok) {
    return {
      valid: false,
      reason: "signature_invalid",
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  return { valid: true, recomputed_cert_hash_felt252: recomputed };
}

/**
 * Verify a v1 legacy certificate (SHA-256 digest + hex pubkey + hex sig).
 * Pre-dates the Poseidon alignment (VULN-001) — kept verifiable forever so
 * existing attestations never silently invalidate.
 */
function verifyRunCertificateV1(
  cert: SignedRunProofCertificateLike,
  sig: SignaturePayload,
  opts: CertVerifyOptions,
): CertVerifyResult {
  if (opts.expectedKid) {
    return {
      valid: false,
      reason: "kid_mismatch",
      details: `expected kid=${opts.expectedKid}, but v1 legacy certs carry no kid`,
      recomputed_cert_hash_felt252: "",
    };
  }

  const recomputed = computeCertDigestSha256(cert);
  if (sig.digest && sig.digest !== recomputed) {
    return {
      valid: false,
      reason: "hash_mismatch",
      details: `embedded=${sig.digest} recomputed=${recomputed}`,
      recomputed_cert_hash_felt252: recomputed,
    };
  }

  let pubkey: KeyObject;
  if (opts.expectedPublicKey) {
    pubkey = opts.expectedPublicKey;
  } else {
    if (!sig.pubkey || !/^[0-9a-f]{64}$/.test(sig.pubkey)) {
      return {
        valid: false,
        reason: "pubkey_unresolvable",
        details: "v1 cert missing a valid 64-char hex pubkey",
        recomputed_cert_hash_felt252: recomputed,
      };
    }
    // Convert raw 32-byte hex pubkey → SPKI DER (Ed25519 SubjectPublicKeyInfo).
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(sig.pubkey, "hex"),
    ]);
    try {
      pubkey = createPublicKey({ key: der, format: "der", type: "spki" });
    } catch (err) {
      return {
        valid: false,
        reason: "pubkey_unresolvable",
        details: err instanceof Error ? err.message : String(err),
        recomputed_cert_hash_felt252: recomputed,
      };
    }
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sig.value, "hex");
  } catch {
    return {
      valid: false,
      reason: "malformed_signature",
      details: "signature.value is not valid hex",
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  if (sigBytes.length !== 64) {
    return {
      valid: false,
      reason: "malformed_signature",
      details: `Ed25519 signature must be 64 bytes (got ${sigBytes.length})`,
      recomputed_cert_hash_felt252: recomputed,
    };
  }

  // v1 signed the raw canonical UTF-8 bytes (not the felt252 projection).
  const { signature: _stripped, ...unsigned } = cert;
  void _stripped;
  const canonical = canonicalizeJcs(unsigned as Record<string, unknown>);
  const ok = cryptoVerify(null, Buffer.from(canonical, "utf8"), pubkey, sigBytes);
  if (!ok) {
    return {
      valid: false,
      reason: "signature_invalid",
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  return { valid: true, recomputed_cert_hash_felt252: recomputed };
}
