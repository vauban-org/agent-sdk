/**
 * rigor-score : RigorBench-inspired process-discipline scoring types (wave-2
 * MOVE#9). A turn's own already-logged tool calls yield a deterministic,
 * zero-LLM 0-100 process-discipline score.
 *
 * HONEST SCOPE (non-negotiable ; see design
 * docs/superpowers/specs/2026-06-22-wave2-move9-rigor-design.md): RigorBench
 * (arXiv:2606.22678) defines 5 pillars. This module scores exactly 3 of them
 * from data a CLI turn already has (Verification Coverage, Recovery
 * Efficiency, Atomic Transition Integrity). Planning Fidelity and Abstention
 * Quality are NOT scored ; there is no honest proxy for either without a plan
 * artifact or a task-impossibility ground truth, neither of which exists in a
 * plain chat turn. {@link RIGORBENCH_PILLARS_SCORED} and
 * {@link RIGORBENCH_PILLARS_TOTAL} exist so every consumer can present the
 * fraction (e.g. "62/100 (3/5 pillars)") instead of a bare composite that
 * could be misread as a full RigorBench score.
 *
 * @module rigor-score/types
 * @public @experimental
 */

/**
 * The renormalized weight of each of the 3 pillars this module scores.
 * Derived from RigorBench's published full-5-pillar weights (Verification
 * Coverage 0.25, Recovery Efficiency 0.25, Atomic Transition Integrity 0.15 ;
 * Planning Fidelity 0.20 and Abstention Quality 0.15 excluded) renormalized
 * over the 0.65 scored subset: 0.25/0.65 = 5/13, 0.15/0.65 = 3/13. The 3
 * values below sum to exactly 1 ({@link RIGOR_PILLAR_WEIGHTS} guard-tested).
 * @public @experimental
 */
export interface RigorWeights {
  readonly verificationCoverage: number;
  readonly recoveryEfficiency: number;
  readonly atomicTransitionIntegrity: number;
}

/** @public @experimental */
export const RIGOR_PILLAR_WEIGHTS: RigorWeights = {
  verificationCoverage: 0.3846,
  recoveryEfficiency: 0.3846,
  atomicTransitionIntegrity: 0.2308,
};

/** Of RigorBench's published 5 pillars, this module honestly scores 3. @public @experimental */
export const RIGORBENCH_PILLARS_SCORED = 3;

/** RigorBench's total published pillar count (Planning Fidelity + Abstention Quality excluded here). @public @experimental */
export const RIGORBENCH_PILLARS_TOTAL = 5;

/**
 * One observed tool call, scored for process discipline. Structurally
 * identical to the CLI's `ToolCallRecord` (packages/cli/src/turn-verifier.ts)
 * ; any array of that shape (e.g. a turn's own `turnToolCalls`) passes here
 * with zero adapter.
 * @public @experimental
 */
export interface ScoredToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly observedExitCode?: number;
}

/** Each pillar's own score in [0, 1], before the renormalized weighting is applied. @public @experimental */
export interface PillarScores {
  readonly verificationCoverage: number;
  readonly recoveryEfficiency: number;
  readonly atomicTransitionIntegrity: number;
}

/**
 * Input to {@link scoreRigor}. `evidenceCount`/`gapCount` come from the
 * turn's own verify-before-done outcome (turn-verifier.ts's
 * `RunChecksResult.evidence.length` / `.gaps.length`) ; `toolCalls` is the
 * turn's own observed tool-call sequence.
 * @public @experimental
 */
export interface RigorScoreInput {
  readonly toolCalls: readonly ScoredToolCall[];
  readonly evidenceCount: number;
  readonly gapCount: number;
}

/**
 * The composite process-discipline outcome. `composite` is 0-100 over the 3
 * scored pillars ONLY ; `pillarsScored`/`pillarsTotal` are carried on every
 * result so a consumer can never present `composite` as a bare number (see
 * module doc's HONEST SCOPE).
 * @public @experimental
 */
export interface RigorScoreResult {
  readonly composite: number;
  readonly pillars: PillarScores;
  readonly pillarsScored: number;
  readonly pillarsTotal: number;
  readonly rationale: string;
}
