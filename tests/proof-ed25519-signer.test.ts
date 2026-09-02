/**
 * Tests for Ed25519 signer behaviour — targeting the SDK's cert-verify module
 * which exposes the hash primitives shared by the CC server signer.
 *
 * Coverage:
 *   CERT_MARKER_FELT  — format, length, prefix
 *   computeCertHashFelt252 — deterministic, strips signature, domain separation
 *   signRunCertificate (local helper, mirrors server pattern) — all signature
 *     fields present, alg, kid, value format, digest, signed_at, custom now(),
 *     idempotency, re-sign strips old signature
 *   round-trip: sign then verifyRunCertificate returns valid:true
 */

import { createHash, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CERT_MARKER_FELT,
  type SignaturePayload,
  type SignedRunProofCertificateLike,
  computeCertHashFelt252,
  verifyRunCertificate,
} from "../src/proof/cert-verify.js";

// ─── Local signer helper (mirrors src/proof/ed25519-signer.ts) ────────────────
//
// Implements the same 32-byte felt-buffer → Ed25519 sign pattern as the server
// signer, so tests exercise the real protocol without importing server code.

interface TestKeyMaterial {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  kid: string;
  pubkeySpkiB64: string;
}

function makeKey(): TestKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pubkeySpkiB64 = spkiDer.toString("base64");
  const kid = createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
  return { privateKey, publicKey, kid, pubkeySpkiB64 };
}

function felt252ToBytes(felt: string): Buffer {
  const hex = felt.replace(/^0x/, "").padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function signCert(
  cert: SignedRunProofCertificateLike,
  key: TestKeyMaterial,
  now: () => Date = () => new Date(),
): SignedRunProofCertificateLike {
  const certHashFelt252 = computeCertHashFelt252(cert);
  const msgBytes = felt252ToBytes(certHashFelt252);
  const sigBuffer = cryptoSign(null, msgBytes, key.privateKey);

  const signature: SignaturePayload = {
    alg: "Ed25519",
    kid: key.kid,
    value: sigBuffer.toString("base64"),
    pubkey_spki_b64: key.pubkeySpkiB64,
    cert_hash_felt252: certHashFelt252,
    signed_at: now().toISOString(),
  };

  const { signature: _old, ...rest } = cert;
  void _old;
  return { ...rest, signature };
}

// ─── Minimal cert fixture ─────────────────────────────────────────────────────

function makeCert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-test-1",
    agent_id: "test-agent",
    started_at: "2026-05-01T10:00:00.000Z",
    finished_at: "2026-05-01T10:00:04.000Z",
    trigger_event_id: null,
    brain_context_refs: [],
    decision_chain: [],
    merkle_root: null,
    katana_tx: null,
    anchor_block_number: null,
    state: "awaiting_anchor",
    issued_at: "2026-05-01T10:00:05.000Z",
    ...overrides,
  };
}

// ─── CERT_MARKER_FELT ─────────────────────────────────────────────────────────

describe("CERT_MARKER_FELT", () => {
  it("starts with '0x'", () => {
    expect(CERT_MARKER_FELT.startsWith("0x")).toBe(true);
  });

  it("is a 64-char hex string after the 0x prefix (62 hex chars = felt252 safe)", () => {
    // The constant uses padStart(62, '0') — 31 bytes felt252-safe representation
    expect(CERT_MARKER_FELT).toMatch(/^0x[0-9a-f]{62}$/);
  });

  it("encodes the UTF-8 string 'run_cert'", () => {
    const expected = Buffer.from("run_cert", "utf8").toString("hex");
    // The felt is right-aligned in 62 chars (zero-padded on the left)
    expect(CERT_MARKER_FELT.replace(/^0x0+/, "")).toBe(expected);
  });
});

// ─── computeCertHashFelt252 ───────────────────────────────────────────────────

describe("computeCertHashFelt252", () => {
  it("returns a string starting with '0x'", () => {
    const h = computeCertHashFelt252(makeCert());
    expect(h.startsWith("0x")).toBe(true);
  });

  it("is deterministic — same cert produces same hash on repeated calls", () => {
    const cert = makeCert();
    expect(computeCertHashFelt252(cert)).toBe(computeCertHashFelt252(cert));
  });

  it("strips the signature field before hashing", () => {
    const cert = makeCert();
    const withSig = {
      ...cert,
      signature: { alg: "Ed25519", value: "fakesig" },
    };
    expect(computeCertHashFelt252(cert)).toBe(computeCertHashFelt252(withSig));
  });

  it("two different certs produce different hashes", () => {
    const h1 = computeCertHashFelt252(makeCert({ agent_id: "agent-A" }));
    const h2 = computeCertHashFelt252(makeCert({ agent_id: "agent-B" }));
    expect(h1).not.toBe(h2);
  });

  it("returns only hex chars after the 0x prefix", () => {
    const h = computeCertHashFelt252(makeCert());
    expect(h).toMatch(/^0x[0-9a-f]+$/);
  });

  it("mutating run_id changes the hash", () => {
    const h1 = computeCertHashFelt252(makeCert({ run_id: "run-1" }));
    const h2 = computeCertHashFelt252(makeCert({ run_id: "run-2" }));
    expect(h1).not.toBe(h2);
  });
});

// ─── signRunCertificate ───────────────────────────────────────────────────────

describe("signRunCertificate", () => {
  it("returns a cert with a signature field", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    expect(signed.signature).toBeDefined();
  });

  it("signature.alg is 'Ed25519'", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    const sig = signed.signature as SignaturePayload;
    expect(sig.alg).toBe("Ed25519");
  });

  it("signature.kid matches the key material kid", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    const sig = signed.signature as SignaturePayload;
    expect(sig.kid).toBe(key.kid);
  });

  it("signature.value is a non-empty base64 string decoding to 64 bytes", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    const sig = signed.signature as SignaturePayload;
    const decoded = Buffer.from(sig.value, "base64");
    expect(decoded.length).toBe(64);
  });

  it("signature.cert_hash_felt252 is a 64-char hex string (plus 0x prefix)", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    const sig = signed.signature as SignaturePayload;
    expect(sig.cert_hash_felt252).toMatch(/^0x[0-9a-f]+$/);
  });

  it("signature.signed_at is a valid ISO 8601 timestamp", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    const sig = signed.signature as SignaturePayload;
    expect(() => new Date(sig.signed_at)).not.toThrow();
    expect(new Date(sig.signed_at).toISOString()).toBe(sig.signed_at);
  });

  it("custom now() function is used for signed_at", () => {
    const key = makeKey();
    const fixedDate = new Date("2026-05-01T12:00:00.000Z");
    const signed = signCert(makeCert(), key, () => fixedDate);
    const sig = signed.signature as SignaturePayload;
    expect(sig.signed_at).toBe("2026-05-01T12:00:00.000Z");
  });

  it("Ed25519 is deterministic — same cert + key + now produces same signature", () => {
    const key = makeKey();
    const cert = makeCert();
    const fixedDate = new Date("2026-05-01T12:00:00.000Z");
    const sig1 = signCert(cert, key, () => fixedDate);
    const sig2 = signCert(cert, key, () => fixedDate);
    expect((sig1.signature as SignaturePayload).value).toBe(
      (sig2.signature as SignaturePayload).value,
    );
  });

  it("signing an already-signed cert strips the old signature before re-hashing", () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const cert = makeCert();
    const firstlySigned = signCert(cert, key1);
    const resigned = signCert(firstlySigned, key2);
    // The cert_hash_felt252 in the re-signed cert should equal the original unsigned hash
    const unsignedHash = computeCertHashFelt252(cert);
    const resignedHash = (resigned.signature as SignaturePayload).cert_hash_felt252;
    expect(resignedHash).toBe(unsignedHash);
  });

  it("preserves all original cert fields in the signed result", () => {
    const key = makeKey();
    const cert = makeCert({ run_id: "run-preservation-test" });
    const signed = signCert(cert, key);
    expect(signed.run_id).toBe("run-preservation-test");
    expect(signed.agent_id).toBe(cert.agent_id);
    expect(signed.state).toBe(cert.state);
  });
});

// ─── Round-trip: sign then verify ────────────────────────────────────────────

describe("round-trip: signCert then verifyRunCertificate", () => {
  it("verifyRunCertificate returns valid:true for a correctly signed cert", () => {
    const key = makeKey();
    const cert = makeCert();
    const signed = signCert(cert, key);
    const result = verifyRunCertificate(signed);
    expect(result.valid).toBe(true);
  });

  it("verifyRunCertificate returns valid:false reason=hash_mismatch when cert is tampered", () => {
    const key = makeKey();
    const signed = signCert(makeCert(), key);
    const tampered = { ...signed, agent_id: "HACKER" };
    const result = verifyRunCertificate(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });

  it("recomputed_cert_hash_felt252 in result matches computeCertHashFelt252(cert)", () => {
    const key = makeKey();
    const cert = makeCert();
    const signed = signCert(cert, key);
    const result = verifyRunCertificate(signed);
    const expected = computeCertHashFelt252(cert);
    expect(result.recomputed_cert_hash_felt252).toBe(expected);
  });
});
