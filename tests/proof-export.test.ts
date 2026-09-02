/**
 * Tests for the T6e proof-claim export. The contract is small but load-bearing:
 *   - exportProofClaim mirrors the right Trace fields into a compact summary;
 *   - claimSignature is over the canonical bytes (sig excluded);
 *   - verifyProofClaim catches every failure mode (no sig, wrong sig, wrong
 *     trace bytes, unsupported version).
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Trace } from "../src/index.js";
import {
  PROOF_CLAIM_VERSION,
  type ProofClaim,
  canonicalClaimString,
  createEd25519Signer,
  createEd25519Verifier,
  exportProofClaim,
  sha256Hex,
  verifyProofClaim,
} from "../src/remote/index.js";

function makeTrace(over: Partial<Trace> = {}): Trace {
  return {
    schemaVersion: "1.0.0",
    runId: "11111111-2222-3333-4444-555555555555",
    agentId: "ASSISTANT",
    agentVersion: "3.1.0",
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    status: "completed",
    steps: [],
    totalSteps: 0,
    rootHash: "deadbeef".repeat(8),
    config: { task: "Polish the docs" },
    configHash: "ch",
    ...over,
  } as unknown as Trace;
}

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    sign: createEd25519Signer(privateKey),
    verify: createEd25519Verifier(publicKey),
  };
}

// ─── sha256Hex ───────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  it("produces the expected hex digest for a known input", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// ─── canonicalClaimString ────────────────────────────────────────────────────

describe("canonicalClaimString", () => {
  it("excludes claimSignature and is stable across the same input", () => {
    const trace = makeTrace();
    const a = exportProofClaim(trace, "x");
    const withSig: ProofClaim = { ...a, claimSignature: "doesntmatter" };
    expect(canonicalClaimString(a)).toBe(canonicalClaimString(withSig));
  });
});

// ─── exportProofClaim ────────────────────────────────────────────────────────

describe("exportProofClaim", () => {
  it("mirrors the Trace's identity, status, step count, hashes", () => {
    const trace = makeTrace({ totalSteps: 12, status: "completed" });
    const claim = exportProofClaim(trace, "TRACE_BYTES");

    expect(claim.type).toBe("preste-proof-claim");
    expect(claim.version).toBe(PROOF_CLAIM_VERSION);
    expect(claim.runId).toBe(trace.runId);
    expect(claim.agent).toEqual({
      id: trace.agentId,
      version: trace.agentVersion,
    });
    expect(claim.task).toBe("Polish the docs");
    expect(claim.status).toBe("completed");
    expect(claim.stepCount).toBe(12);
    expect(claim.rootHash).toBe(trace.rootHash);
    expect(claim.traceSha256).toBe(sha256Hex("TRACE_BYTES"));
    expect(claim.claimSignature).toBeUndefined();
  });

  it("omits `task` when the trace has none", () => {
    const trace = makeTrace({ config: {} as Record<string, unknown> });
    const claim = exportProofClaim(trace, "x");
    expect(claim.task).toBeUndefined();
  });

  it("seals the claim with claimSignature when a signer is provided", () => {
    const { sign } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign);
    expect(typeof claim.claimSignature).toBe("string");
    expect((claim.claimSignature ?? "").length).toBeGreaterThan(0);
  });

  it("forwards an agentSignature when the Trace carries one", () => {
    const trace = makeTrace({ agentSignature: "agent-sig-bytes" });
    const claim = exportProofClaim(trace, "x");
    expect(claim.agentSignature).toBe("agent-sig-bytes");
  });
});

// ─── verifyProofClaim ────────────────────────────────────────────────────────

describe("verifyProofClaim", () => {
  it("accepts a well-formed signed claim", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign);
    const v = verifyProofClaim(claim, verify);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("rejects a claim with no claimSignature", () => {
    const { verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1");
    const v = verifyProofClaim(claim, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toContain("missing claimSignature");
  });

  it("rejects a claim signed by the wrong key", () => {
    const a = ed25519();
    const b = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", a.sign);
    const v = verifyProofClaim(claim, b.verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toContain("does not verify");
  });

  it("rejects when the supplied trace bytes do not match traceSha256", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-original", sign);
    const v = verifyProofClaim(claim, verify, "trace-tampered");
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toContain("traceSha256 mismatch");
  });

  it("accepts when the supplied trace bytes match traceSha256", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign);
    const v = verifyProofClaim(claim, verify, "trace-1");
    expect(v.valid).toBe(true);
  });

  it("rejects an unsupported version", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign);
    const tampered = { ...claim, version: "999" } as unknown as ProofClaim;
    const v = verifyProofClaim(tampered, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("unsupported version"))).toBe(true);
  });

  it("rejects a tampered field (payload mutated post-sign)", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign);
    const tampered: ProofClaim = { ...claim, stepCount: 99 };
    const v = verifyProofClaim(tampered, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("does not verify"))).toBe(true);
  });
});

// ─── P10 — settlement receipt embedding ───────────────────────────────────

import type { SettlementReceipt } from "../src/remote/index.js";
import { withPaymentReceipt } from "../src/remote/index.js";

function makeReceipt(over: Partial<SettlementReceipt> = {}): SettlementReceipt {
  return {
    network: "starknet-sepolia",
    txHash: `0x${"ab".repeat(32)}`,
    blockNumber: 12345,
    blockTime: "2026-05-23T10:00:00.000Z",
    amount: "1000000000000000000",
    token: "STRK20",
    decimals: 18,
    to: `0x${"cd".repeat(20)}`,
    from: `0x${"ef".repeat(20)}`,
    proofCommitment: `0x${"12".repeat(32)}`,
    ...over,
  };
}

describe("exportProofClaim — paymentReceipt embedding", () => {
  it("embeds the receipt in the claim when supplied via opts", () => {
    const receipt = makeReceipt();
    const claim = exportProofClaim(makeTrace(), "trace-bytes", undefined, {
      paymentReceipt: receipt,
    });
    expect(claim.paymentReceipt).toEqual(receipt);
  });

  it("omits paymentReceipt when not supplied (backward compat)", () => {
    const claim = exportProofClaim(makeTrace(), "trace-bytes");
    expect(claim.paymentReceipt).toBeUndefined();
  });

  it("signs over the receipt — tampering breaks the signature", () => {
    const { sign, verify } = ed25519();
    const receipt = makeReceipt();
    const claim = exportProofClaim(makeTrace(), "trace-bytes", sign, {
      paymentReceipt: receipt,
    });
    // Original verifies.
    const v1 = verifyProofClaim(claim, verify);
    expect(v1.valid).toBe(true);
    // Mutate the receipt's amount → signature must break.
    const tampered: ProofClaim = {
      ...claim,
      paymentReceipt: { ...receipt, amount: "9999999999999999999" },
    };
    const v2 = verifyProofClaim(tampered, verify);
    expect(v2.valid).toBe(false);
    expect(v2.reasons.some((r) => r.includes("does not verify"))).toBe(true);
  });
});

describe("withPaymentReceipt — late-bind receipt to existing claim", () => {
  it("adds the receipt + re-signs when a signer is supplied", () => {
    const { sign, verify } = ed25519();
    const unsigned = exportProofClaim(makeTrace(), "trace-bytes");
    expect(unsigned.paymentReceipt).toBeUndefined();
    const receipt = makeReceipt();
    const updated = withPaymentReceipt(unsigned, receipt, sign);
    expect(updated.paymentReceipt).toEqual(receipt);
    expect(updated.claimSignature).toBeDefined();
    // The updated claim verifies cleanly.
    const v = verifyProofClaim(updated, verify);
    expect(v.valid).toBe(true);
  });

  it("drops the prior signature when no signer is supplied (caller's choice)", () => {
    const { sign } = ed25519();
    const signed = exportProofClaim(makeTrace(), "trace-bytes", sign);
    expect(signed.claimSignature).toBeDefined();
    const receipt = makeReceipt();
    const updated = withPaymentReceipt(signed, receipt);
    expect(updated.paymentReceipt).toEqual(receipt);
    expect(updated.claimSignature).toBeUndefined();
  });

  it("re-signing makes the prior signature invalid for the new surface", () => {
    const { sign, verify } = ed25519();
    const signed = exportProofClaim(makeTrace(), "trace-bytes", sign);
    const receipt = makeReceipt();
    // Manually graft the receipt WITHOUT re-signing — should fail verify.
    const grafted: ProofClaim = { ...signed, paymentReceipt: receipt };
    const v = verifyProofClaim(grafted, verify);
    expect(v.valid).toBe(false);
  });

  it("preserves runId and stepCount from the original claim", () => {
    const { sign } = ed25519();
    const original = exportProofClaim(makeTrace({ totalSteps: 7 }), "tb", sign);
    const updated = withPaymentReceipt(original, makeReceipt(), sign);
    expect(updated.runId).toBe(original.runId);
    expect(updated.stepCount).toBe(original.stepCount);
    expect(updated.traceSha256).toBe(original.traceSha256);
  });
});

// ─── PaymentAuthorizationPolicy v1 — signed paymentAuthorization field ───────

import type { PaymentAuthorization } from "../src/remote/index.js";

function makeAuthorization(over: Partial<PaymentAuthorization> = {}): PaymentAuthorization {
  return {
    policyId: "vauban:marketplace:v1",
    policyVersion: 1,
    commitmentSha256: "ab".repeat(32),
    evaluatedAt: "2026-08-01T10:00:00.000Z",
    authorized: true,
    ...over,
  };
}

describe("exportProofClaim — paymentAuthorization embedding", () => {
  it("embeds the authorization in the claim when supplied via opts", () => {
    const authz = makeAuthorization();
    const claim = exportProofClaim(makeTrace(), "trace-bytes", undefined, {
      paymentAuthorization: authz,
    });
    expect(claim.paymentAuthorization).toEqual(authz);
  });

  it("omits paymentAuthorization when not supplied (backward compat)", () => {
    const claim = exportProofClaim(makeTrace(), "trace-bytes");
    expect(claim.paymentAuthorization).toBeUndefined();
  });

  it("signs over the authorization — tampering breaks the signature", () => {
    const { sign, verify } = ed25519();
    const authz = makeAuthorization();
    const claim = exportProofClaim(makeTrace(), "trace-bytes", sign, {
      paymentAuthorization: authz,
    });
    // Original verifies.
    const v1 = verifyProofClaim(claim, verify);
    expect(v1.valid).toBe(true);
    // Mutate the commitment → signature must break (signed surface).
    const tampered: ProofClaim = {
      ...claim,
      paymentAuthorization: { ...authz, commitmentSha256: "ff".repeat(32) },
    };
    const v2 = verifyProofClaim(tampered, verify);
    expect(v2.valid).toBe(false);
    expect(v2.reasons.some((r) => r.includes("does not verify"))).toBe(true);
  });
});

// ─── Unsigned metadata tolerance (auto-embed payment_receipt) ────────────────

describe("verifyProofClaim — unsigned auto-embed metadata tolerance", () => {
  it("a claim written with the unsigned payment_receipt field still verifies", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign, {
      paymentAuthorization: makeAuthorization(),
    });
    // Simulate `preste attest claim` auto-embed: the Pay MCP cross-check
    // result is grafted onto the JSON AFTER signing, as `payment_receipt`
    // (snake_case, intentionally NOT in the signed surface).
    const onDisk = {
      ...claim,
      payment_receipt: {
        txHash: claim.runId,
        network: "sepolia",
        check_status: "UNCHECKED",
      },
    } as unknown as ProofClaim;

    const v = verifyProofClaim(onDisk, verify, "trace-1");
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("tampering with the UNSIGNED metadata does not invalidate the claim", () => {
    const { sign, verify } = ed25519();
    const claim = exportProofClaim(makeTrace(), "trace-1", sign);
    const onDisk = {
      ...claim,
      payment_receipt: { check_status: "PASS" },
    } as unknown as ProofClaim;
    // Graft a DIFFERENT unsigned metadata — the signed surface is untouched.
    const tampered = {
      ...onDisk,
      payment_receipt: { check_status: "FAIL" },
    } as unknown as ProofClaim;
    const v = verifyProofClaim(tampered, verify, "trace-1");
    expect(v.valid).toBe(true);
  });
});
