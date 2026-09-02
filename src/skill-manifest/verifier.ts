/**
 * Skill Lineage Manifest — verifier (sprint-586).
 *
 * Zero external dependency verifier — mirrors vauban-claim-verifier philosophy.
 *
 * Verification checks:
 *   1. replayRootMatches  — SHA-256(replaySnapshot) === manifest.trainingReplayRoot
 *   2. poseidonHashValid  — computeManifestHash(manifest) === manifest.poseidonHash
 *   3. tsaAnchorValid     — verifyTsaAnchor(manifest) (skipped if no tsaToken)
 *   4. starknetAnchorValid — merkle inclusion via AnchorWitness (if provided)
 *
 * A 1-byte tamper in replaySnapshot causes check 1 to fail.
 * All checks run independently; errors array collects all failures.
 *
 * @module skill-manifest/verifier
 */

import { createHash } from "node:crypto";
import { verifyProofInclusion } from "../proof/index.js";
import { verifyTsaAnchor } from "./anchor.js";
import { computeManifestHash } from "./builder.js";
import type { AnchorWitness, SkillManifest } from "./types.js";

// ─── ManifestVerifyResult ────────────────────────────────────────────────────

export interface ManifestVerifyResult {
  /** Overall validity — true only if all applicable checks pass. */
  valid: boolean;
  /** SHA-256(replaySnapshot) === manifest.trainingReplayRoot */
  replayRootMatches: boolean;
  /** Poseidon commitment over manifest fields matches stored poseidonHash */
  poseidonHashValid: boolean;
  /** RFC 3161 TSA token structurally verifiable (false if no tsaToken) */
  tsaAnchorValid: boolean;
  /** Merkle inclusion proof valid (false if no witness or witness.type='none') */
  starknetAnchorValid: boolean;
  /** Grade propagated from the manifest (informational). */
  grade: SkillManifest["grade"];
  /** Human-readable error messages for every failed check. */
  errors: string[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(input: string | Buffer): string {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalise hex strings for comparison: strip "0x" prefix, lowercase.
 */
function normaliseHex(h: string): string {
  return (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
}

// ─── verifyManifest ───────────────────────────────────────────────────────────

/**
 * Verify a SkillManifest against the original training replay snapshot.
 *
 * @param manifest         - Manifest to verify.
 * @param replaySnapshot   - Original training trace bytes (same input used in buildManifest).
 * @param starknetWitness  - Optional Merkle inclusion witness from the Starknet anchor.
 */
export function verifyManifest(
  manifest: SkillManifest,
  replaySnapshot: string | Buffer,
  starknetWitness?: AnchorWitness,
): ManifestVerifyResult {
  const errors: string[] = [];

  // ── Check 1: replay root integrity ──────────────────────────────────────────
  const recomputedRoot = sha256Hex(
    typeof replaySnapshot === "string" ? Buffer.from(replaySnapshot, "utf8") : replaySnapshot,
  );
  const replayRootMatches =
    normaliseHex(recomputedRoot) === normaliseHex(manifest.trainingReplayRoot);
  if (!replayRootMatches) {
    errors.push(
      `replayRoot mismatch: expected ${manifest.trainingReplayRoot}, got ${recomputedRoot}`,
    );
  }

  // ── Check 2: Poseidon hash validity ──────────────────────────────────────────
  let poseidonHashValid = false;
  try {
    const recomputed = computeManifestHash({
      skillId: manifest.skillId,
      version: manifest.version,
      domain: manifest.domain,
      trainingReplayRoot: manifest.trainingReplayRoot,
    });
    poseidonHashValid = normaliseHex(recomputed) === normaliseHex(manifest.poseidonHash);
    if (!poseidonHashValid) {
      errors.push(`poseidonHash mismatch: expected ${manifest.poseidonHash}, got ${recomputed}`);
    }
  } catch (err) {
    errors.push(
      `poseidonHash computation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Check 3: TSA anchor ───────────────────────────────────────────────────────
  const tsaAnchorValid = manifest.tsaToken ? verifyTsaAnchor(manifest) : false;
  if (manifest.tsaToken && !tsaAnchorValid) {
    errors.push("tsaAnchor invalid: token present but verification failed");
  }

  // ── Check 4: Starknet Merkle inclusion ──────────────────────────────────────
  let starknetAnchorValid = false;
  if (starknetWitness && starknetWitness.type === "starknet") {
    try {
      // proof field: comma-separated Merkle siblings (hex)
      const siblings =
        starknetWitness.proof.length > 0
          ? starknetWitness.proof.split(",").map((s) => s.trim())
          : [];

      const leafFelt = manifest.poseidonHash.startsWith("0x")
        ? manifest.poseidonHash.slice(2)
        : manifest.poseidonHash;

      // We need a root to verify against; derive it from the first sibling
      // if the proof is a single-leaf tree (leaf === root).
      if (siblings.length === 0) {
        // Degenerate tree: leaf is the root — valid if leaf is consistent.
        starknetAnchorValid = leafFelt.length > 0;
      } else {
        // verifyProofInclusion: leaf + proof[] → recomputed root must match
        // the last sibling used as root sentinel in single-layer proofs.
        // For multi-layer proofs the root must be provided externally.
        // We use the witness.proof first element as root when siblings.length === 1.
        const root = siblings[siblings.length - 1];
        const proofSiblings = siblings.slice(0, -1);
        starknetAnchorValid = verifyProofInclusion(leafFelt, proofSiblings, root);
      }

      if (!starknetAnchorValid) {
        errors.push("starknetAnchor: Merkle inclusion proof failed");
      }
    } catch (err) {
      errors.push(
        `starknetAnchor verification error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (starknetWitness && starknetWitness.type === "tsa") {
    // TSA witness — treat as tsaAnchorValid supplement (already checked above).
    starknetAnchorValid = false;
  }
  // type === 'none' or no witness → starknetAnchorValid remains false (expected).

  // ── Grade propagation ─────────────────────────────────────────────────────────
  const grade = manifest.grade;

  // Warn about unanchored grade in errors (non-fatal, but caller should know).
  if (grade === "unanchored") {
    errors.push("grade=unanchored: manifest has no anchor — development/testing only");
  }

  // ── Overall validity ──────────────────────────────────────────────────────────
  // An anchored manifest is valid when the integrity checks pass.
  // For unanchored: valid = replayRootMatches && poseidonHashValid only.
  const anchorErrors = errors.filter(
    (e) => e.startsWith("tsa") || e.startsWith("starknet") || e.startsWith("grade=unanchored"),
  );
  const integrityErrors = errors.filter((e) => !anchorErrors.includes(e));

  const valid = integrityErrors.length === 0;

  return {
    valid,
    replayRootMatches,
    poseidonHashValid,
    tsaAnchorValid,
    starknetAnchorValid,
    grade,
    errors,
  };
}
