/**
 * rigor-score/score : the composite RigorBench-inspired process-discipline
 * score (wave-2 MOVE#9). Pure, deterministic, zero LLM ; folds the 3 pillar
 * scores (pillars.ts) through the renormalized weights (types.ts).
 *
 * @module rigor-score/score
 * @public @experimental
 */

import { atomicTransitionIntegrity, recoveryEfficiency, verificationCoverage } from "./pillars.js";
import {
  RIGORBENCH_PILLARS_SCORED,
  RIGORBENCH_PILLARS_TOTAL,
  RIGOR_PILLAR_WEIGHTS,
} from "./types.js";
import type { PillarScores, RigorScoreInput, RigorScoreResult } from "./types.js";

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Score one turn's process discipline. Deterministic: identical input always
 * yields an identical result (no clock, no randomness, no I/O).
 *
 * HONEST FRAMING: `composite` is 0-100 over the 3 pillars this module scores,
 * NEVER a full RigorBench score. Every result carries `pillarsScored` (3),
 * `pillarsTotal` (5), and a `rationale` naming the 3/5 scope explicitly ; a
 * caller MUST surface the fraction alongside `composite` (never a bare
 * "N/100"), per the module's non-negotiable honesty requirement.
 * @public @experimental
 */
export function scoreRigor(input: RigorScoreInput): RigorScoreResult {
  const pillars: PillarScores = {
    verificationCoverage: verificationCoverage(input.evidenceCount, input.gapCount),
    recoveryEfficiency: recoveryEfficiency(input.toolCalls),
    atomicTransitionIntegrity: atomicTransitionIntegrity(input.toolCalls),
  };

  const composite01 =
    pillars.verificationCoverage * RIGOR_PILLAR_WEIGHTS.verificationCoverage +
    pillars.recoveryEfficiency * RIGOR_PILLAR_WEIGHTS.recoveryEfficiency +
    pillars.atomicTransitionIntegrity * RIGOR_PILLAR_WEIGHTS.atomicTransitionIntegrity;

  const composite = Math.round(clamp01(composite01) * 100);

  const rationale = `VC ${pillars.verificationCoverage.toFixed(2)} · RE ${pillars.recoveryEfficiency.toFixed(2)} · ATI ${pillars.atomicTransitionIntegrity.toFixed(2)} (${RIGORBENCH_PILLARS_SCORED}/${RIGORBENCH_PILLARS_TOTAL} pillars scored ; Planning Fidelity + Abstention Quality excluded, no honest proxy in a CLI turn)`;

  return {
    composite,
    pillars,
    pillarsScored: RIGORBENCH_PILLARS_SCORED,
    pillarsTotal: RIGORBENCH_PILLARS_TOTAL,
    rationale,
  };
}
