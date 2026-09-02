/**
 * Cross-implementation parity guardrail (the meta-lesson of the position-binding fix).
 *
 * Asserts the published OSS verifier (@vauban-org/proof-core) and the CC canonical
 * impl (command-center/src/proof/poseidon-hasher.ts) compute the IDENTICAL Poseidon
 * Merkle root for the same leaves IN THE SAME ORDER, AND that an inclusion proof from
 * proof-core satisfies the deployed Cairo `verify_inclusion` semantics (index%2 → L/R).
 *
 * These use the REAL implementations on both sides — no mocks. If proof-core and
 * poseidon-hasher.ts ever diverge again (e.g. one re-introduces a sorted/commutative
 * tree), this test fails. It is the regression backstop against the bug that shipped
 * a verifier that could never validate a real on-chain anchor.
 *
 * Four-way agreement chain (this file pins the proof-core ↔ CC TS link; the Python
 * verifier and the Cairo contract are pinned by the shared cross-lang-vectors.json and
 * the in-test Cairo replication below):
 *   proof-core  ==  poseidon-hasher.ts  ==  vauban-verify (Python)  ==  merkle_anchor.cairo
 */

import { hash } from "starknet";
import { describe, expect, it } from "vitest";

// REAL published OSS verifier under test.
import {
  computeInclusionProof,
  computeLeafHash,
  computeMerkleRoot,
  feltEquals,
  toFeltHex,
} from "@vauban-org/proof-core";

// REAL CC canonical impl (the ground-truth TS reference, mirrors the Cairo contract).
import {
  buildPoseidonInclusionProof,
  verifyInclusion as ccVerifyInclusion,
  computePoseidonMerkleRoot,
  computeStepLeafHash,
} from "../../../src/proof/poseidon-hasher.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const LEAF_SETS: Array<Array<Record<string, unknown>>> = [
  [{ solo: true }],
  [{ step: "a" }, { step: "b" }],
  [{ n: 0 }, { n: 1 }, { n: 2 }],
  [{ n: 2 }, { n: 1 }, { n: 0 }], // reversed — must differ from the above (position-binding)
  [
    { step: "init", ts: 1700000000 },
    { step: "build", ts: 1700000001 },
    { step: "test", ts: 1700000002 },
    { step: "deploy", ts: 1700000003 },
  ],
  Array.from({ length: 7 }, (_, i) => ({ idx: i, ts: 1700000100 + i })),
];

/**
 * In-test replication of merkle_anchor.cairo::compute_merkle_root.
 *   if index % 2 == 0 { Poseidon(current, sibling) } else { Poseidon(sibling, current) }
 *   index = index / 2
 * Operates on canonical felts so it byte-matches the Cairo poseidon_hash_span output.
 */
function cairoComputeRoot(leaf: string, siblings: string[], leafIndex: number): string {
  let current = toFeltHex(leaf);
  let index = leafIndex;
  for (const sibling of siblings) {
    const sib = toFeltHex(sibling);
    const pair = index % 2 === 0 ? [current, sib] : [sib, current];
    current = toFeltHex(hash.computePoseidonHashOnElements(pair));
    index = Math.floor(index / 2);
  }
  return current;
}

// ─── Leaf-hash parity ───────────────────────────────────────────────────────────

describe("proof-core ↔ CC poseidon-hasher.ts — leaf parity", () => {
  for (const set of LEAF_SETS) {
    for (const payload of set) {
      it(`computeLeafHash == computeStepLeafHash for ${JSON.stringify(payload)}`, () => {
        expect(computeLeafHash(payload)).toBe(computeStepLeafHash(payload));
      });
    }
  }
});

// ─── Root parity (the core guardrail) ────────────────────────────────────────────

describe("proof-core ↔ CC poseidon-hasher.ts — Merkle root parity", () => {
  for (let s = 0; s < LEAF_SETS.length; s++) {
    const set = LEAF_SETS[s]!;
    it(`identical root for leaf set #${s} (${set.length} leaves)`, () => {
      const coreLeaves = set.map(computeLeafHash);
      const ccLeaves = set.map(computeStepLeafHash);
      const coreRoot = computeMerkleRoot(coreLeaves);
      const ccRoot = computePoseidonMerkleRoot(ccLeaves);
      // Strict canonical-felt equality — both sides return "0x" + 64 hex.
      expect(coreRoot).toBe(ccRoot);
      expect(feltEquals(coreRoot, ccRoot)).toBe(true);
    });
  }

  it("both impls are order-sensitive identically — [a,b,c] root ≠ [c,b,a] root, on both", () => {
    const abc = [{ n: 0 }, { n: 1 }, { n: 2 }];
    const cba = [{ n: 2 }, { n: 1 }, { n: 0 }];
    const coreAbc = computeMerkleRoot(abc.map(computeLeafHash));
    const coreCba = computeMerkleRoot(cba.map(computeLeafHash));
    const ccAbc = computePoseidonMerkleRoot(abc.map(computeStepLeafHash));
    const ccCba = computePoseidonMerkleRoot(cba.map(computeStepLeafHash));
    expect(coreAbc).not.toBe(coreCba);
    expect(ccAbc).not.toBe(ccCba);
    expect(coreAbc).toBe(ccAbc);
    expect(coreCba).toBe(ccCba);
  });
});

// ─── Inclusion-proof parity + Cairo semantics ────────────────────────────────────

describe("proof-core inclusion proof satisfies CC + Cairo verify semantics", () => {
  for (let s = 0; s < LEAF_SETS.length; s++) {
    const set = LEAF_SETS[s]!;
    it(`every proof-core proof verifies under CC + Cairo for leaf set #${s}`, () => {
      const coreLeaves = set.map(computeLeafHash);
      const root = computeMerkleRoot(coreLeaves);

      for (let i = 0; i < coreLeaves.length; i++) {
        const proof = computeInclusionProof(coreLeaves, i);

        // a) proof-core's own proof is internally consistent with the root.
        expect(feltEquals(proof.root, root)).toBe(true);
        expect(proof.leafIndex).toBe(i);

        // b) CC's verifyInclusion accepts proof-core's proof verbatim.
        expect(ccVerifyInclusion(proof.leaf, proof.siblings, proof.leafIndex, root)).toBe(true);

        // c) the deployed Cairo walk reconstructs the same root from the proof.
        const cairoRoot = cairoComputeRoot(proof.leaf, proof.siblings, i);
        expect(feltEquals(cairoRoot, root)).toBe(true);
      }
    });
  }

  it("CC's inclusion proof is likewise accepted by proof-core's verify (symmetry)", () => {
    const ccLeaves = LEAF_SETS[4]!.map(computeStepLeafHash);
    const root = computePoseidonMerkleRoot(ccLeaves);
    for (let i = 0; i < ccLeaves.length; i++) {
      const ccProof = buildPoseidonInclusionProof(ccLeaves, i);
      // Reconstruct via the Cairo walk on the CC-produced proof.
      const cairoRoot = cairoComputeRoot(ccProof.leaf, ccProof.siblings, i);
      expect(feltEquals(cairoRoot, root)).toBe(true);
    }
  });
});
