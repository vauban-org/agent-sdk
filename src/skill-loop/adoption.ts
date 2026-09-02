/**
 * src/skill-loop/adoption.ts
 *
 * Skill adoption — auto-promote and deprecate logic gated by sign-off.
 *
 * Promotion conditions (ALL must hold):
 *   1. EvalResult.pValue < 0.05  (statistical significance)
 *   2. EvalResult.deltaVsIncumbent >= 0.10  (>=10% improvement)
 *   3. A valid approved SignOffRecord exists for the candidateId
 *
 * Violation of condition 3 → throws PromotionWithoutSignOffError.
 *
 * Underperformers (deltaVsIncumbent < -0.05 OR pValue > 0.5) are
 * automatically deprecated via deprecateUnderperformers().
 *
 * @module skill-loop/adoption
 */

import type { SkillCandidate } from "./candidate.js";
import type { EvalResult } from "./evaluator.js";
import type { SignOffRecord } from "./sign-off.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PromotionWithoutSignOffError extends Error {
  readonly candidateId: string;

  constructor(candidateId: string) {
    super(
      `adoption: cannot promote candidate "${candidateId}" without a valid approved sign-off. Request human approval via SignOffManager.requestSignOff() first.`,
    );
    this.name = "PromotionWithoutSignOffError";
    this.candidateId = candidateId;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @public */
export type AdoptionStatus =
  | "promoted"
  | "rejected"
  | "deprecated"
  | "pending_signoff"
  | "insufficient_signal";

/** @public */
export interface AdoptionRecord {
  candidateId: string;
  status: AdoptionStatus;
  evalResult: EvalResult;
  signOff: SignOffRecord | null;
  promotedAt: Date | null;
  deprecatedAt: Date | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Adoption helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to promote a candidate to production.
 *
 * @param candidate  - The skill candidate.
 * @param evalResult - Evaluation result against the verifier set.
 * @param signOff    - Approved sign-off record (must be decision === 'approved').
 * @param nowDate    - Optional date override for deterministic testing.
 *
 * @throws PromotionWithoutSignOffError if signOff is null or not approved.
 */
export function promoteCandidate(
  candidate: SkillCandidate,
  evalResult: EvalResult,
  signOff: SignOffRecord | null,
  nowDate?: Date,
): AdoptionRecord {
  // Gate 1: sign-off required — never auto-promote without human approval
  if (!signOff || signOff.decision !== "approved") {
    throw new PromotionWithoutSignOffError(candidate.id);
  }

  // Gate 2: statistical significance
  if (!evalResult.significant) {
    return {
      candidateId: candidate.id,
      status: "insufficient_signal",
      evalResult,
      signOff,
      promotedAt: null,
      deprecatedAt: null,
      reason: `insufficient signal: p=${evalResult.pValue.toFixed(
        4,
      )} delta=${evalResult.deltaVsIncumbent.toFixed(4)} (need p<0.05 AND delta>=0.10)`,
    };
  }

  // All gates passed → promote
  return {
    candidateId: candidate.id,
    status: "promoted",
    evalResult,
    signOff,
    promotedAt: nowDate ?? new Date(),
    deprecatedAt: null,
    reason: `promoted: p=${evalResult.pValue.toFixed(4)} delta=${(
      evalResult.deltaVsIncumbent * 100
    ).toFixed(1)}% sign-off by ${signOff.approverId}`,
  };
}

/**
 * Reject a candidate explicitly (e.g. sign-off decision = rejected).
 */
export function rejectCandidate(
  candidate: SkillCandidate,
  evalResult: EvalResult,
  signOff: SignOffRecord | null,
  reason: string,
): AdoptionRecord {
  return {
    candidateId: candidate.id,
    status: "rejected",
    evalResult,
    signOff,
    promotedAt: null,
    deprecatedAt: null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Underperformer deprecation
// ---------------------------------------------------------------------------

/**
 * Deprecation threshold: candidate's delta < -5% OR p-value > 0.5 with negative delta.
 */
const UNDERPERFORMER_DELTA_THRESHOLD = -0.05;
const UNDERPERFORMER_PVALUE_THRESHOLD = 0.5;

/**
 * Automatically deprecate underperforming candidates from a pool.
 *
 * A candidate is an underperformer if:
 *   - deltaVsIncumbent < -0.05 (degrades by more than 5%)
 *   - OR (deltaVsIncumbent < 0 AND pValue > 0.5) — statistically noisy & negative
 *
 * Deprecation is automatic — no sign-off required (sign-off is only for promotion).
 *
 * @param candidates  - Pool of (candidate, evalResult) pairs to assess.
 * @param nowDate     - Optional date override.
 * @returns AdoptionRecords for every deprecated candidate.
 */
export function deprecateUnderperformers(
  candidates: Array<{ candidate: SkillCandidate; evalResult: EvalResult }>,
  nowDate?: Date,
): AdoptionRecord[] {
  const deprecated: AdoptionRecord[] = [];

  for (const { candidate, evalResult } of candidates) {
    const isUnderperformer =
      evalResult.deltaVsIncumbent < UNDERPERFORMER_DELTA_THRESHOLD ||
      (evalResult.deltaVsIncumbent < 0 && evalResult.pValue > UNDERPERFORMER_PVALUE_THRESHOLD);

    if (isUnderperformer) {
      deprecated.push({
        candidateId: candidate.id,
        status: "deprecated",
        evalResult,
        signOff: null,
        promotedAt: null,
        deprecatedAt: nowDate ?? new Date(),
        reason: `auto-deprecated: delta=${(evalResult.deltaVsIncumbent * 100).toFixed(
          1,
        )}% p=${evalResult.pValue.toFixed(4)}`,
      });
    }
  }

  return deprecated;
}
