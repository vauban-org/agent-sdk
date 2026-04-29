/**
 * verifyProofCertificate — pure client-side verification of RunProofCertificate.
 *
 * Recomputes the Poseidon Merkle root from decision_chain leaf hashes and
 * compares against cert.merkle_root. No network call, no server trust needed.
 *
 * sprint-521 Bloc 1.
 */

import type { RunProofCertificate } from "./types.js";
import { computeMerkleRoot } from "./poseidon.js";

/** Valid CertState values for enum validation. */
const VALID_CERT_STATES: ReadonlySet<string> = new Set([
  "awaiting_anchor",
  "anchored",
  "verified_on_chain",
]);

/**
 * Minimum hex length for a leaf hash (excluding "0x" prefix).
 *
 * Poseidon felt252 values are ≤ 252 bits → at most 63 hex chars.
 * A non-trivial leaf hash will be 62 or 63 hex chars.
 * We accept anything ≥ 62 hex chars to accommodate both lengths.
 */
const MIN_FELT_HEX_LEN = 62;

/**
 * Validate a hex felt252 leaf hash.
 * Must start with "0x" and have at least 62 lowercase hex chars after the prefix.
 */
function isValidLeaf(leaf: string): boolean {
  return (
    typeof leaf === "string" &&
    leaf.startsWith("0x") &&
    /^[0-9a-f]+$/i.test(leaf.slice(2)) &&
    leaf.length >= MIN_FELT_HEX_LEN + 2
  );
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify a RunProofCertificate by recomputing its Merkle root.
 *
 * Checks:
 *   1. cert.state is a valid CertState enum value.
 *   2. All leaf hashes in decision_chain have valid hex felt252 format.
 *   3. If decision_chain is non-empty, recompute the Merkle root and compare
 *      against cert.merkle_root. Mismatch → merkle_mismatch.
 *   4. Empty decision_chain + null merkle_root → valid (degenerate case).
 *
 * @param cert - RunProofCertificate to verify (typically fetched from /api/runs/:id/proof-certificate).
 * @returns { valid: boolean; reason?: string }
 */
export function verifyProofCertificate(cert: RunProofCertificate): VerifyResult {
  // ─── 1. State enum validation ─────────────────────────────────────────────
  if (!VALID_CERT_STATES.has(cert.state)) {
    return { valid: false, reason: "invalid_state" };
  }

  // ─── 2. Degenerate case: empty decision_chain ─────────────────────────────
  if (cert.decision_chain.length === 0) {
    return { valid: true };
  }

  // ─── 3. Leaf format validation ────────────────────────────────────────────
  const leaves = cert.decision_chain.map((s) => s.leaf_hash_poseidon);
  for (const leaf of leaves) {
    if (!isValidLeaf(leaf)) {
      return { valid: false, reason: "invalid_leaf_format" };
    }
  }

  // ─── 4. Merkle root recomputation ─────────────────────────────────────────
  const recomputed = computeMerkleRoot(leaves);

  if (cert.merkle_root === null || recomputed !== cert.merkle_root) {
    return { valid: false, reason: "merkle_mismatch" };
  }

  return { valid: true };
}
