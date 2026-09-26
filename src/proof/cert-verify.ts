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
import { createRequire } from "node:module";
import { hash } from "starknet";

// ─── ML-DSA-44 (FIPS 204) types (type-only, optional peer dep) ────────────────

// Type-only import — erased at compile time. The actual module is loaded
// lazily via createRequire (see `loadMlDsa44` below) so this file works even
// when `@noble/post-quantum` is not installed: an Ed25519 certificate never
// needs it, and an ML-DSA-44 certificate without it fails closed with
// `pq_verifier_unavailable` rather than throwing or silently accepting.
type MlDsa44Module = typeof import("@noble/post-quantum/ml-dsa.js");
type MlDsa44Signer = MlDsa44Module["ml_dsa44"];

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Signature payload embedded in `SignedRunProofCertificate`.
 *
 * Three generations coexist, all self-describing (mirrors the CLI store):
 * - v2 (Ed25519, CANONICAL until D-K 2026-09-26): `kid` + `pubkey_spki_b64` +
 *   `cert_hash_felt252` (Poseidon felt252, draft-vauban-skill-attestation-00
 *   §5). Ed25519 signs the 32-byte felt252 projection of the JCS-canonical
 *   unsigned cert.
 * - ML-DSA-44 (FIPS 204, D-K 2026-09-26 — see `docs/attestation.md`): same
 *   hashing pipeline as v2 (JCS → SHA-256 → Poseidon → felt252), but signed
 *   with ML-DSA-44 over the same 32-byte felt252 message, under the fixed
 *   FIPS 204 context `ML_DSA44_CONTEXT`. Public key is carried raw (base64)
 *   in `pubkey_b64` rather than SPKI-wrapped — see `docs/attestation.md` for
 *   why `pubkey_spki_b64` is not reused.
 * - v1 (LEGACY, read-only compat): `pubkey` (hex) + `digest` (SHA-256 hex),
 *   Ed25519 over the raw canonical UTF-8 bytes. Pre-dates the Poseidon
 *   alignment (VULN-001 audit 2026-08-01) ; kept verifiable forever.
 *
 * Detection: `alg` selects Ed25519-v2 vs ML-DSA-44 directly; within
 * Ed25519, presence of `cert_hash_felt252` ⇒ v2, else `digest` ⇒ v1.
 */
export interface SignaturePayload {
  alg: "Ed25519" | "ML-DSA-44";
  /** v2 / ML-DSA-44: stable key id (matches CC server). */
  kid: string;
  /** Signature — base64 (v2 Ed25519, ML-DSA-44) or hex (v1 Ed25519). */
  value: string;
  /** v2 Ed25519 only: base64 SPKI DER public key (matches CC server `pubkey_spki_b64`). */
  pubkey_spki_b64?: string;
  /** ML-DSA-44 only: raw 1312-byte public key, base64 (see `docs/attestation.md`). */
  pubkey_b64?: string;
  /** v2 / ML-DSA-44: Poseidon([0x1, sha_felt, CERT_MARKER_FELT]) felt252 of unsigned cert. */
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
  | "malformed_signature"
  | "pq_verifier_unavailable";

export interface CertVerifyResult {
  valid: boolean;
  reason?: CertVerifyFailReason;
  details?: string;
  recomputed_cert_hash_felt252: string;
}

export interface CertVerifyOptions {
  /** Pin the Ed25519 signing key (bypasses embedded `pubkey_spki_b64`). */
  expectedPublicKey?: KeyObject;
  /** Pin the ML-DSA-44 signing key, raw 1312-byte public key (bypasses embedded `pubkey_b64`). */
  expectedMlDsa44PublicKey?: Uint8Array | Buffer;
  /** Pin the key id — applies to both Ed25519-v2 and ML-DSA-44 certs. */
  expectedKid?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Domain separator: UTF-8 "run_cert" → felt252 right-aligned, zero-padded. */
export const CERT_MARKER_FELT: string = `0x${Buffer.from("run_cert", "utf8").toString("hex").padStart(62, "0")}`;

/**
 * FIPS 204 `ctx` fixed context for ML-DSA-44 run-certificate signatures
 * (D-K, 2026-09-26). Fixed and versioned in its own name (`-v1`) rather than
 * left empty, so a future format change cannot be replayed against this one
 * even though both would otherwise hash the same felt252 message. See
 * `docs/attestation.md`.
 */
export const ML_DSA44_CONTEXT: Uint8Array = new TextEncoder().encode("vauban-run-cert-v1");

/** ML-DSA-44 (FIPS 204) fixed byte lengths. */
const ML_DSA44_PUBKEY_LEN = 1312;
const ML_DSA44_SIGNATURE_LEN = 2420;

// ─── Lazy @noble/post-quantum loader (optional peer dep) ──────────────────────

let _mlDsa44: MlDsa44Signer | null | undefined;

/**
 * Load `@noble/post-quantum`'s `ml_dsa44` signer synchronously once, cache
 * the result. Returns `null` if the optional dependency is not installed (or
 * the require fails for any other reason) — callers must treat `null` as a
 * refusal (`pq_verifier_unavailable`), never as "no ML-DSA-44 certs exist".
 * Mirrors the `loadPromClient` pattern in `metrics/create-agent-metrics.ts`.
 */
function loadMlDsa44(): MlDsa44Signer | null {
  if (_mlDsa44 !== undefined) return _mlDsa44;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("@noble/post-quantum/ml-dsa.js") as MlDsa44Module;
    _mlDsa44 = mod.ml_dsa44;
  } catch {
    _mlDsa44 = null;
  }
  return _mlDsa44;
}

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
 * The failure reasons are typed via `CertVerifyFailReason` so callers can
 * branch precisely. `recomputed_cert_hash_felt252` is always returned for
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
  if (sig.alg === "ML-DSA-44") {
    return verifyRunCertificateMlDsa44(cert, sig, opts);
  }
  if (sig.alg !== "Ed25519") {
    return {
      valid: false,
      reason: "wrong_alg",
      details: `expected Ed25519 or ML-DSA-44, got ${String(sig.alg)}`,
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
  } else if (!sig.pubkey_spki_b64) {
    return {
      valid: false,
      reason: "pubkey_unresolvable",
      details: "v2 Ed25519 cert missing pubkey_spki_b64",
      recomputed_cert_hash_felt252: recomputed,
    };
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

/**
 * Verify an ML-DSA-44 (FIPS 204) certificate (D-K, 2026-09-26 — see
 * `docs/attestation.md`). Same hashing pipeline as Ed25519 v2 (JCS →
 * SHA-256 → Poseidon → felt252); the felt252 is signed under the fixed
 * `ML_DSA44_CONTEXT`. `@noble/post-quantum` is an optional peer dependency:
 * when it is not installed, this returns `pq_verifier_unavailable` — it
 * never falls back to accepting the certificate.
 */
function verifyRunCertificateMlDsa44(
  cert: SignedRunProofCertificateLike,
  sig: SignaturePayload,
  opts: CertVerifyOptions,
): CertVerifyResult {
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

  const mlDsa44 = loadMlDsa44();
  if (!mlDsa44) {
    return {
      valid: false,
      reason: "pq_verifier_unavailable",
      details:
        "@noble/post-quantum is not installed (optional peer dependency) — cannot verify ML-DSA-44 certificates",
      recomputed_cert_hash_felt252: recomputed,
    };
  }

  let pubkeyBytes: Uint8Array;
  if (opts.expectedMlDsa44PublicKey) {
    pubkeyBytes = opts.expectedMlDsa44PublicKey;
  } else if (!sig.pubkey_b64) {
    return {
      valid: false,
      reason: "pubkey_unresolvable",
      details: "ML-DSA-44 cert missing pubkey_b64",
      recomputed_cert_hash_felt252: recomputed,
    };
  } else {
    pubkeyBytes = Buffer.from(sig.pubkey_b64, "base64");
  }
  if (pubkeyBytes.length !== ML_DSA44_PUBKEY_LEN) {
    return {
      valid: false,
      reason: "pubkey_unresolvable",
      details: `ML-DSA-44 public key must be ${ML_DSA44_PUBKEY_LEN} bytes (got ${pubkeyBytes.length})`,
      recomputed_cert_hash_felt252: recomputed,
    };
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
  if (sigBytes.length !== ML_DSA44_SIGNATURE_LEN) {
    return {
      valid: false,
      reason: "malformed_signature",
      details: `ML-DSA-44 signature must be ${ML_DSA44_SIGNATURE_LEN} bytes (got ${sigBytes.length})`,
      recomputed_cert_hash_felt252: recomputed,
    };
  }

  const msgBytes = felt252ToBytes(recomputed);
  let ok: boolean;
  try {
    ok = mlDsa44.verify(sigBytes, msgBytes, pubkeyBytes, { context: ML_DSA44_CONTEXT });
  } catch (err) {
    return {
      valid: false,
      reason: "signature_invalid",
      details: err instanceof Error ? err.message : String(err),
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  if (!ok) {
    return {
      valid: false,
      reason: "signature_invalid",
      recomputed_cert_hash_felt252: recomputed,
    };
  }
  return { valid: true, recomputed_cert_hash_felt252: recomputed };
}
