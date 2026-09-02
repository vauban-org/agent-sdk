/**
 * src/skill-loop/candidate.ts
 *
 * Reflexion-style deterministic skill candidate extraction.
 *
 * Key invariant: extraction is deterministic — SHA-256(cycleId + domain) is the
 * sole source of entropy. No LLM calls. Replay produces bit-identical output.
 *
 * @module skill-loop/candidate
 */

import { sha256 } from "../proof/sha256.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @public */
export interface SkillCandidate {
  /** Unique candidate ID: SHA-256(cycleId + domain) hex. */
  id: string;
  /** The cycle ID from which this candidate was extracted. */
  extractedFrom: string;
  /** Domain key e.g. "vault_rebalance", "cairo_audit". */
  domain: string;
  /** Extracted skill text — deterministic, NOT LLM-paraphrase. */
  instructions: string;
  /** Constitutional axiom score from the source cycle [0, 1]. */
  constitutionalScore: number;
  /** Outcome quality score from the source cycle [0, 1]. */
  outcomeScore: number;
  /** Semantic version, e.g. "1.0.0". */
  version: string;
  /** SHA-256 of the source cycle trace (replay root). */
  replayRoot: string;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a SkillCandidate from a high-scoring cycle's outcome text.
 *
 * Deterministic: SHA-256(cycleId + domain) seeded extraction, no LLM calls.
 * Replay with the same arguments produces bit-identical output.
 *
 * @param cycleId      - Source cycle identifier.
 * @param instructions - Raw skill instructions text extracted from the cycle.
 * @param domain       - Domain key for the skill.
 * @param scores       - Constitutional and outcome scores from the cycle.
 * @returns            - Fully populated SkillCandidate (async due to SHA-256).
 */
export async function extractCandidate(
  cycleId: string,
  instructions: string,
  domain: string,
  scores: { constitutional: number; outcome: number },
): Promise<SkillCandidate> {
  // Deterministic id: SHA-256(cycleId + ":" + domain)
  const id = await sha256(`${cycleId}:${domain}`);

  // replayRoot: SHA-256 of the full source context (cycle trace)
  const replayRoot = await sha256(`${cycleId}:${domain}:${instructions}`);

  return {
    id,
    extractedFrom: cycleId,
    domain,
    instructions,
    constitutionalScore: scores.constitutional,
    outcomeScore: scores.outcome,
    version: "1.0.0",
    replayRoot,
  };
}
