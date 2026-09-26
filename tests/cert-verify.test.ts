/**
 * Tests for packages/agent-sdk/src/proof/cert-verify.ts
 *
 * Coverage:
 *   CERT_MARKER_FELT — is a 0x-prefixed hex string
 *   computeCertHashFelt252 — deterministic, strips signature field, -0 normalization
 *   publicKeyFromSpkiB64 — throws on empty, throws on non-Ed25519, success
 *   verifyRunCertificate — missing_signature, wrong_alg, hash_mismatch, kid_mismatch,
 *                          malformed_signature (too short), signature_invalid,
 *                          valid end-to-end with real Ed25519 keypair
 *
 * Ref: test coverage for agent-sdk/proof/cert-verify.ts (no prior tests)
 */

import { createHash, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { describe, expect, it } from "vitest";
import {
  CERT_MARKER_FELT,
  ML_DSA44_CONTEXT,
  computeCertHashFelt252,
  publicKeyFromSpkiB64,
  verifyRunCertificate,
} from "../src/proof/cert-verify.js";

/** Sign the felt252 message for an ML-DSA-44 test cert, mirroring the CC server signer. */
function signMlDsa44(
  cert: Record<string, unknown>,
  secretKey: Uint8Array,
  context: Uint8Array = ML_DSA44_CONTEXT,
): { recomputed: string; sigB64: string } {
  const recomputed = computeCertHashFelt252(cert);
  const hex = recomputed.replace(/^0x/, "").padStart(64, "0");
  const msgBytes = Buffer.from(hex, "hex");
  const sigBytes = ml_dsa44.sign(msgBytes, secretKey, { context });
  return { recomputed, sigB64: Buffer.from(sigBytes).toString("base64") };
}

// ─── CERT_MARKER_FELT ─────────────────────────────────────────────────────────

describe("CERT_MARKER_FELT", () => {
  it("is a 0x-prefixed hex string of length 64", () => {
    expect(CERT_MARKER_FELT).toMatch(/^0x[0-9a-f]{62}$/);
  });
});

// ─── computeCertHashFelt252 ───────────────────────────────────────────────────

describe("computeCertHashFelt252", () => {
  it("returns a 0x-prefixed felt252 string", () => {
    const hash = computeCertHashFelt252({ runId: "run-1", steps: [] });
    expect(hash).toMatch(/^0x[0-9a-f]+$/);
  });

  it("is deterministic for the same cert", () => {
    const cert = { runId: "run-1", agentId: "forge", steps: [] };
    expect(computeCertHashFelt252(cert)).toBe(computeCertHashFelt252(cert));
  });

  it("differs for different cert content", () => {
    const h1 = computeCertHashFelt252({ runId: "run-1" });
    const h2 = computeCertHashFelt252({ runId: "run-2" });
    expect(h1).not.toBe(h2);
  });

  it("strips embedded signature field before hashing", () => {
    const base = { runId: "run-1", agentId: "forge" };
    const withSig = {
      ...base,
      signature: { alg: "Ed25519", value: "fakesig" },
    };
    expect(computeCertHashFelt252(base)).toBe(computeCertHashFelt252(withSig));
  });

  it("normalizes -0 to 0 (RFC 8785 JCS)", () => {
    const h1 = computeCertHashFelt252({ v: -0 });
    const h2 = computeCertHashFelt252({ v: 0 });
    expect(h1).toBe(h2);
  });

  it("sorts object keys deterministically", () => {
    const h1 = computeCertHashFelt252({ b: 2, a: 1 });
    const h2 = computeCertHashFelt252({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });
});

// ─── publicKeyFromSpkiB64 ─────────────────────────────────────────────────────

describe("publicKeyFromSpkiB64", () => {
  it("throws on empty input", () => {
    expect(() => publicKeyFromSpkiB64("")).toThrow("empty SPKI");
  });

  it("throws when SPKI is not Ed25519", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(() => publicKeyFromSpkiB64(spki.toString("base64"))).toThrow("not Ed25519");
  });

  it("returns an Ed25519 public key for valid SPKI", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const key = publicKeyFromSpkiB64(spki.toString("base64"));
    expect(key.asymmetricKeyType).toBe("ed25519");
  });
});

// ─── verifyRunCertificate ─────────────────────────────────────────────────────

describe("verifyRunCertificate", () => {
  it("returns missing_signature when no signature field", () => {
    const r = verifyRunCertificate({ runId: "run-1" });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("missing_signature");
    expect(typeof r.recomputed_cert_hash_felt252).toBe("string");
  });

  it("returns wrong_alg for non-Ed25519 algorithm", () => {
    const r = verifyRunCertificate({
      runId: "run-1",
      signature: {
        alg: "RSA",
        kid: "k1",
        value: "sig",
        pubkey_spki_b64: "x",
        cert_hash_felt252: "0x0",
        signed_at: "",
      } as never,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("wrong_alg");
  });

  it("returns hash_mismatch when embedded hash doesn't match recomputed", () => {
    const cert = { runId: "run-1" };
    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "Ed25519",
        kid: "k1",
        value: "c2ln",
        pubkey_spki_b64: "x",
        cert_hash_felt252: "0xdeadbeef",
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("hash_mismatch");
  });

  it("returns kid_mismatch when expectedKid doesn't match", () => {
    const cert = { runId: "run-1" };
    const recomputed = computeCertHashFelt252(cert);
    const r = verifyRunCertificate(
      {
        ...cert,
        signature: {
          alg: "Ed25519",
          kid: "k-actual",
          value: "c2ln",
          pubkey_spki_b64: "x",
          cert_hash_felt252: recomputed,
          signed_at: "",
        },
      },
      { expectedKid: "k-expected" },
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("kid_mismatch");
  });

  it("returns malformed_signature when sig.value is not 64-byte base64", () => {
    const cert = { runId: "run-1" };
    const recomputed = computeCertHashFelt252(cert);
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "Ed25519",
        kid: "k1",
        value: Buffer.from("tooshort").toString("base64"), // only 8 bytes
        pubkey_spki_b64: spki,
        cert_hash_felt252: recomputed,
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed_signature");
  });

  it("valid end-to-end: sign cert then verify", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spki = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");

    const cert = { runId: "run-e2e", agentId: "forge", steps: 3 };
    const recomputed = computeCertHashFelt252(cert);

    // Convert felt to 32-byte buffer for signing (mirrors server signer)
    const hex = recomputed.replace(/^0x/, "").padStart(64, "0");
    const msgBytes = Buffer.from(hex, "hex");
    const sigBytes = cryptoSign(null, msgBytes, privateKey);
    const sigB64 = sigBytes.toString("base64");

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "Ed25519",
        kid: "k-test",
        value: sigB64,
        pubkey_spki_b64: spki,
        cert_hash_felt252: recomputed,
        signed_at: new Date().toISOString(),
      },
    });
    expect(r.valid).toBe(true);
    expect(r.recomputed_cert_hash_felt252).toBe(recomputed);
  });
});

// ─── v1 legacy compat (pre-VULN-001 certs stay verifiable forever) ─────────

describe("verifyRunCertificate v1 legacy", () => {
  it("accepts a v1 cert (SHA-256 digest + hex pubkey + hex sig over raw canonical bytes)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .subarray(-32)
      .toString("hex");
    expect(pubHex).toMatch(/^[0-9a-f]{64}$/);

    const cert = { runId: "run-v1", agentId: "forge", steps: 2 };
    // v1 signed the raw canonical UTF-8 bytes (JCS, signature stripped).
    const stripped = { runId: "run-v1", agentId: "forge", steps: 2 };
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(stripped).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    const sigHex = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("hex");

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "Ed25519",
        // v1 payloads carry NO v2 fields (kid / pubkey_spki_b64 / cert_hash_felt252)
        value: sigHex,
        pubkey: pubHex,
        digest,
        signed_at: "2026-07-03T19:01:55.683Z",
      } as never,
    });
    expect(r.valid).toBe(true);
    expect(r.recomputed_cert_hash_felt252).toBe(digest);
  });

  it("returns hash_mismatch when v1 digest is tampered", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .subarray(-32)
      .toString("hex");
    const cert = { runId: "run-v1", agentId: "forge", steps: 2 };
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(cert).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
    const sigHex = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("hex");
    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "Ed25519",
        value: sigHex,
        pubkey: pubHex,
        digest: "0".repeat(64),
        signed_at: "",
      } as never,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("hash_mismatch");
  });

  it("returns pubkey_unresolvable when v1 pubkey is malformed", () => {
    const digest = createHash("sha256").update('{"runId":"run-v1"}', "utf8").digest("hex");
    const r = verifyRunCertificate({
      runId: "run-v1",
      signature: {
        alg: "Ed25519",
        value: "00".repeat(64),
        pubkey: "not-hex",
        digest,
        signed_at: "",
      } as never,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("pubkey_unresolvable");
  });

  it("returns kid_mismatch when expectedKid is set on a v1 cert", () => {
    const r = verifyRunCertificate(
      {
        runId: "run-v1",
        signature: {
          alg: "Ed25519",
          value: "00".repeat(64),
          pubkey: "00".repeat(32),
          digest: "0".repeat(64),
          signed_at: "",
        } as never,
      },
      { expectedKid: "k-expected" },
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("kid_mismatch");
  });

  it("returns signature_invalid when v1 signature is tampered", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .subarray(-32)
      .toString("hex");
    const cert = { runId: "run-v1", agentId: "forge", steps: 2 };
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(cert).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "Ed25519",
        value: "00".repeat(64), // wrong signature
        pubkey: pubHex,
        digest,
        signed_at: "",
      } as never,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_invalid");
  });
});

// ─── verifyRunCertificate ML-DSA-44 (FIPS 204, D-K 2026-09-26) ─────────────────

describe("verifyRunCertificate ML-DSA-44", () => {
  it("accepts a valid ML-DSA-44 cert end-to-end", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-1", agentId: "forge", steps: 4 };
    const { recomputed, sigB64 } = signMlDsa44(cert, secretKey);

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq-test",
        value: sigB64,
        pubkey_b64: Buffer.from(publicKey).toString("base64"),
        cert_hash_felt252: recomputed,
        signed_at: new Date().toISOString(),
      },
    });
    expect(r.valid).toBe(true);
    expect(r.recomputed_cert_hash_felt252).toBe(recomputed);
  });

  it("returns hash_mismatch when the embedded felt252 does not match recomputed", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-2" };
    const { sigB64 } = signMlDsa44(cert, secretKey);

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq",
        value: sigB64,
        pubkey_b64: Buffer.from(publicKey).toString("base64"),
        cert_hash_felt252: "0xdeadbeef",
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("hash_mismatch");
  });

  it("returns signature_invalid when the signature bytes are tampered", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-3" };
    const { recomputed, sigB64 } = signMlDsa44(cert, secretKey);
    const tampered = Buffer.from(sigB64, "base64");
    tampered[0] ^= 0xff;

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq",
        value: tampered.toString("base64"),
        pubkey_b64: Buffer.from(publicKey).toString("base64"),
        cert_hash_felt252: recomputed,
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_invalid");
  });

  it("returns signature_invalid when the FIPS 204 context differs from ML_DSA44_CONTEXT", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-4" };
    const { recomputed, sigB64 } = signMlDsa44(cert, secretKey, new TextEncoder().encode("wrong-context"));

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq",
        value: sigB64,
        pubkey_b64: Buffer.from(publicKey).toString("base64"),
        cert_hash_felt252: recomputed,
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_invalid");
  });

  it("returns pubkey_unresolvable when the public key has the wrong size", () => {
    const { secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-5" };
    const { recomputed, sigB64 } = signMlDsa44(cert, secretKey);

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq",
        value: sigB64,
        pubkey_b64: Buffer.from(new Uint8Array(32)).toString("base64"), // wrong size
        cert_hash_felt252: recomputed,
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("pubkey_unresolvable");
  });

  it("returns malformed_signature when the signature has the wrong size", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-6" };
    const { recomputed } = signMlDsa44(cert, secretKey);

    const r = verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq",
        value: Buffer.from("tooshort").toString("base64"),
        pubkey_b64: Buffer.from(publicKey).toString("base64"),
        cert_hash_felt252: recomputed,
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed_signature");
  });

  it("returns kid_mismatch when expectedKid does not match on an ML-DSA-44 cert", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const cert = { runId: "run-pq-7" };
    const { recomputed, sigB64 } = signMlDsa44(cert, secretKey);

    const r = verifyRunCertificate(
      {
        ...cert,
        signature: {
          alg: "ML-DSA-44",
          kid: "k-actual",
          value: sigB64,
          pubkey_b64: Buffer.from(publicKey).toString("base64"),
          cert_hash_felt252: recomputed,
          signed_at: "",
        },
      },
      { expectedKid: "k-expected" },
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("kid_mismatch");
  });

  it("pins to expectedMlDsa44PublicKey, ignoring embedded pubkey_b64", () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const attacker = ml_dsa44.keygen();
    const cert = { runId: "run-pq-8" };
    const { recomputed, sigB64 } = signMlDsa44(cert, secretKey);

    const r = verifyRunCertificate(
      {
        ...cert,
        signature: {
          alg: "ML-DSA-44",
          kid: "k-pq",
          value: sigB64,
          pubkey_b64: Buffer.from(attacker.publicKey).toString("base64"), // attacker's key embedded
          cert_hash_felt252: recomputed,
          signed_at: "",
        },
      },
      { expectedMlDsa44PublicKey: publicKey }, // pin to the real signer
    );
    expect(r.valid).toBe(true);
  });

  // `pq_verifier_unavailable` (module-not-installed) is covered in its own
  // test file, cert-verify-pq-unavailable.test.ts: this file already holds a
  // real module-level cache of `@noble/post-quantum` (loaded once, memoized)
  // from the tests above, so mocking `node:module` here would not be
  // observed by the already-cached loader.
});
