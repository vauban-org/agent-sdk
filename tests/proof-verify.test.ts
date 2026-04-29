/**
 * verifyProofCertificate tests — sprint-521 Bloc 1.
 *
 * Reference values:
 *   4-leaf root: 0x553705d38a32cf531ca2ae343abf9e85d3ab515f63bc158c7cd20c66a4a2c8c
 *   NULL_LEAF:   0x1fb7169b936dd880cb7ebc50e932a495a60e0084cdab94a681040cb4006e1a0
 *
 * Cross-language vectors: loaded from
 *   tools/vauban-verify/tests/cross-lang-vectors.json (quick-11 shipped).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeLeafHash, computeMerkleRoot } from "../src/proof/poseidon.js";
import { verifyProofCertificate } from "../src/proof/verify.js";
import type { RunProofCertificate } from "../src/proof/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCert(
  overrides: Partial<RunProofCertificate> = {},
): RunProofCertificate {
  return {
    run_id: "11111111-1111-1111-1111-111111111111",
    agent_id: "BUILDER",
    started_at: "2026-04-28T10:00:00.000Z",
    finished_at: "2026-04-28T10:01:00.000Z",
    trigger_event_id: null,
    brain_context_refs: [],
    decision_chain: [],
    merkle_root: null,
    katana_tx: null,
    anchor_block_number: null,
    state: "awaiting_anchor",
    issued_at: "2026-04-28T10:01:01.000Z",
    ...overrides,
  };
}

function makeChainEntry(payload: Record<string, unknown>): {
  step_id: string;
  step_index: number;
  type: string;
  phase: string | null;
  leaf_hash_poseidon: string;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
} {
  return {
    step_id: crypto.randomUUID(),
    step_index: 0,
    type: "decision",
    phase: null,
    leaf_hash_poseidon: computeLeafHash(payload),
    started_at: "2026-04-28T10:00:00.000Z",
    finished_at: "2026-04-28T10:00:01.000Z",
    duration_ms: 1000,
  };
}

// ─── Pinned reference values ──────────────────────────────────────────────────

const FOUR_LEAF_PAYLOADS = [
  { step: "init", ts: 1700000000 },
  { step: "build", ts: 1700000001 },
  { step: "test", ts: 1700000002 },
  { step: "deploy", ts: 1700000003 },
];

const FOUR_LEAF_HASHES = FOUR_LEAF_PAYLOADS.map(computeLeafHash);
const FOUR_LEAF_ROOT =
  "0x553705d38a32cf531ca2ae343abf9e85d3ab515f63bc158c7cd20c66a4a2c8c";

// ─── verifyProofCertificate ───────────────────────────────────────────────────

describe("verifyProofCertificate", () => {
  it("valid cert: leaves recompute matching root → valid=true", () => {
    const chain = FOUR_LEAF_PAYLOADS.map((p, i) => ({
      ...makeChainEntry(p),
      step_index: i,
    }));
    const cert = makeCert({
      decision_chain: chain,
      merkle_root: FOUR_LEAF_ROOT,
      state: "anchored",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("tampered leaf → valid=false, reason=merkle_mismatch", () => {
    const chain = FOUR_LEAF_PAYLOADS.map((p, i) => ({
      ...makeChainEntry(p),
      step_index: i,
    }));
    // Tamper the first leaf
    chain[0] = {
      ...chain[0]!,
      leaf_hash_poseidon: computeLeafHash({ step: "tampered", ts: 9999 }),
    };
    const cert = makeCert({
      decision_chain: chain,
      merkle_root: FOUR_LEAF_ROOT,
      state: "anchored",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("merkle_mismatch");
  });

  it("empty decision_chain + null merkle_root → valid=true (degenerate case)", () => {
    const cert = makeCert({
      decision_chain: [],
      merkle_root: null,
      state: "awaiting_anchor",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(true);
  });

  it("invalid leaf format (not 0x hex) → valid=false, reason=invalid_leaf_format", () => {
    const chain = [
      {
        step_id: "step-1",
        step_index: 0,
        type: "decision",
        phase: null,
        leaf_hash_poseidon: "NOT_A_HEX_FELT",
        started_at: "2026-04-28T10:00:00.000Z",
        finished_at: "2026-04-28T10:00:01.000Z",
        duration_ms: null,
      },
    ];
    const cert = makeCert({
      decision_chain: chain,
      merkle_root: "0x1234",
      state: "awaiting_anchor",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_leaf_format");
  });

  it("leaf too short (only 0x + 2 hex chars) → valid=false, reason=invalid_leaf_format", () => {
    const chain = [
      {
        step_id: "step-1",
        step_index: 0,
        type: "decision",
        phase: null,
        leaf_hash_poseidon: "0xab",
        started_at: "2026-04-28T10:00:00.000Z",
        finished_at: "2026-04-28T10:00:01.000Z",
        duration_ms: null,
      },
    ];
    const cert = makeCert({
      decision_chain: chain,
      merkle_root: "0x1234",
      state: "awaiting_anchor",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_leaf_format");
  });

  it("invalid state value → valid=false, reason=invalid_state", () => {
    const cert = makeCert({
      state: "unknown_state" as "awaiting_anchor",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_state");
  });

  it("merkle_root mismatch (cert has wrong root) → valid=false, reason=merkle_mismatch", () => {
    const chain = FOUR_LEAF_PAYLOADS.map((p, i) => ({
      ...makeChainEntry(p),
      step_index: i,
    }));
    const cert = makeCert({
      decision_chain: chain,
      // Wrong root — any other value
      merkle_root: computeLeafHash({ wrong: true }),
      state: "anchored",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("merkle_mismatch");
  });

  it("cert.merkle_root is null but chain is non-empty → valid=false, reason=merkle_mismatch", () => {
    const chain = [{ ...makeChainEntry({ step: "init" }), step_index: 0 }];
    const cert = makeCert({
      decision_chain: chain,
      merkle_root: null,
      state: "awaiting_anchor",
    });
    const result = verifyProofCertificate(cert);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("merkle_mismatch");
  });

  it("single leaf cert: root equals the leaf itself", () => {
    const leaf = computeLeafHash({ step: "only", ts: 1 });
    const root = computeMerkleRoot([leaf]);
    const chain = [
      {
        step_id: "step-1",
        step_index: 0,
        type: "decision",
        phase: null,
        leaf_hash_poseidon: leaf,
        started_at: "2026-04-28T10:00:00.000Z",
        finished_at: "2026-04-28T10:00:01.000Z",
        duration_ms: null,
      },
    ];
    const cert = makeCert({
      decision_chain: chain,
      merkle_root: root,
      state: "verified_on_chain",
    });
    expect(verifyProofCertificate(cert).valid).toBe(true);
  });

  it("uses pinned 4-leaf reference root (regression guard)", () => {
    const recomputed = computeMerkleRoot(FOUR_LEAF_HASHES);
    expect(recomputed).toBe(FOUR_LEAF_ROOT);
  });
});

// ─── Cross-language vectors ───────────────────────────────────────────────────

// tools/vauban-verify/tests/cross-lang-vectors.json was shipped by quick-11.
const VECTORS_PATH = join(
  // Walk up from packages/agent-sdk/ to repo root
  new URL("../../..", import.meta.url).pathname,
  "tools/vauban-verify/tests/cross-lang-vectors.json",
);

interface Vector {
  name: string;
  kind: "step_leaf" | "merkle_root";
  input: { payloads?: Array<Record<string, unknown>> } & Record<string, unknown>;
  expected_hash: string;
}

let vectors: Vector[] = [];
let vectorsLoaded = false;
try {
  vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vector[];
  vectorsLoaded = true;
} catch {
  // File absent — tests skipped below
}

describe("cross-language vectors (quick-11)", () => {
  if (!vectorsLoaded) {
    it.skip(
      "cross-lang-vectors.json not found — skipping (quick-11 not yet in tree)",
      () => {},
    );
    return;
  }

  const stepLeafVectors = vectors.filter((v) => v.kind === "step_leaf");
  const merkleVectors = vectors.filter((v) => v.kind === "merkle_root");

  for (const vec of stepLeafVectors) {
    it(`step_leaf: ${vec.name}`, () => {
      const result = computeLeafHash(vec.input as Record<string, unknown>);
      expect(result).toBe(vec.expected_hash);
    });
  }

  for (const vec of merkleVectors) {
    it(`merkle_root: ${vec.name}`, () => {
      const payloads = vec.input["payloads"] as Array<Record<string, unknown>>;
      const leaves = payloads.map(computeLeafHash);
      const result = computeMerkleRoot(leaves);
      expect(result).toBe(vec.expected_hash);
    });
  }
});
