/**
 * Poseidon helpers for SDK consumers — sprint-521 Bloc 1.
 *
 * Pure wrappers over starknet.js Poseidon primitives.
 * starknet is declared as a peerDependency (~500 KB); consumers opt in.
 *
 * computeLeafHash  — generic alias for computeStepLeafHash (SDK ergonomics)
 * computeMerkleRoot — alias for computePoseidonMerkleRoot
 *
 * Algorithm (computeLeafHash):
 *   1. JCS-canonicalize the payload (RFC 8785 subset — keys sorted recursively, -0 → 0)
 *   2. SHA-256 the UTF-8 bytes → 32-byte digest
 *   3. Take first 31 bytes (62 hex chars) as sha256_felt (felt252-safe truncation)
 *   4. Poseidon([0x1, sha256_felt, run_step_marker]) → felt252 leaf
 *
 * Merkle construction:
 *   - Leaves sorted lexicographically for determinism
 *   - Padded to next power of 2 with NULL_LEAF = Poseidon(["0x0","0x0"])
 *   - Commutative pair-sort at each merge level (order-independent)
 *
 * All returned values are lowercase hex strings prefixed with "0x".
 */

import { createHash } from "node:crypto";
import { hash } from "starknet";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Domain separator for run_step leaves: UTF-8 "run_step" right-padded as felt252.
 */
const STEP_MARKER_FELT: string =
  "0x" + Buffer.from("run_step", "utf8").toString("hex").padStart(62, "0");

/**
 * Null leaf for padding: Poseidon(["0x0", "0x0"]).
 */
const NULL_LEAF: string = hash.computePoseidonHashOnElements(["0x0", "0x0"]);

// ─── JCS canonicalization (RFC 8785 subset) ───────────────────────────────────

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

function jcsCanonicalize(data: Record<string, unknown>): string {
  return JSON.stringify(normalizeValue(data));
}

// ─── Felt252 helpers ──────────────────────────────────────────────────────────

function sha256To31Felt(hexStr: string): string {
  return "0x" + hexStr.substring(0, 62);
}

// ─── Merkle helpers ───────────────────────────────────────────────────────────

function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function buildBaseLayer(leaves: string[]): string[] {
  const sorted = [...leaves].sort();
  const target = nextPowerOf2(sorted.length);
  while (sorted.length < target) {
    sorted.push(NULL_LEAF);
  }
  return sorted;
}

function buildTreeLayers(baseLayer: string[]): string[][] {
  const tree: string[][] = [baseLayer];
  let current = baseLayer;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const [a, b] =
        current[i]! <= current[i + 1]!
          ? [current[i]!, current[i + 1]!]
          : [current[i + 1]!, current[i]!];
      next.push(hash.computePoseidonHashOnElements([a, b]));
    }
    tree.push(next);
    current = next;
  }
  return tree;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a Poseidon leaf hash for a run_step payload.
 *
 * Generic SDK alias for computeStepLeafHash (server-side name).
 * Algorithm identical: JCS → SHA-256 truncated felt → Poseidon([version, sha_felt, marker]).
 *
 * @param payload - Arbitrary JSON-serializable record.
 * @returns Lowercase hex felt252 string prefixed with "0x".
 */
export function computeLeafHash(payload: Record<string, unknown>): string {
  const canonical = jcsCanonicalize(payload);
  const sha = createHash("sha256").update(canonical, "utf8").digest("hex");
  return hash.computePoseidonHashOnElements([
    "0x1",
    sha256To31Felt(sha),
    STEP_MARKER_FELT,
  ]);
}

/**
 * Compute a Poseidon Merkle root from a set of leaves.
 *
 * Leaves are sorted lexicographically and padded with NULL_LEAF to the next
 * power of 2 before tree construction. Each pair is merged with a commutative
 * sort so the root is invariant to input ordering.
 *
 * @param leaves - At least 1 leaf (lowercase hex "0x" strings).
 * @returns Lowercase hex felt252 root string prefixed with "0x".
 */
export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    throw new Error(
      "[agent-sdk/proof] computeMerkleRoot: at least 1 leaf required",
    );
  }
  const base = buildBaseLayer(leaves);
  const tree = buildTreeLayers(base);
  return tree[tree.length - 1]![0]!;
}

export { NULL_LEAF };
