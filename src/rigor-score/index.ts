/**
 * rigor-score : RigorBench-inspired (arXiv:2606.22678) process-discipline
 * scoring for a single agent turn (wave-2 MOVE#9). Deterministic, zero LLM,
 * zero I/O, zero infra ; folds a turn's already-observed tool calls and
 * verify-before-done outcome into a 0-100 composite.
 *
 * HONEST SCOPE: scores 3 of RigorBench's published 5 pillars (Verification
 * Coverage, Recovery Efficiency, Atomic Transition Integrity) ; Planning
 * Fidelity and Abstention Quality are deliberately NOT scored (no honest
 * proxy in a plain CLI turn). Every {@link RigorScoreResult} carries
 * `pillarsScored`/`pillarsTotal` so a consumer can never present the
 * composite as a bare number ; see types.ts's module doc for the full
 * rationale.
 * @public @experimental
 */
export {
  RIGOR_PILLAR_WEIGHTS,
  RIGORBENCH_PILLARS_SCORED,
  RIGORBENCH_PILLARS_TOTAL,
} from "./types.js";
export type {
  PillarScores,
  RigorScoreInput,
  RigorScoreResult,
  RigorWeights,
  ScoredToolCall,
} from "./types.js";
export {
  atomicTransitionIntegrity,
  recoveryEfficiency,
  verificationCoverage,
} from "./pillars.js";
export { scoreRigor } from "./score.js";
