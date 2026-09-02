/**
 * src/constitution/index.ts
 *
 * Barrel export for the constitution module.
 * Provides 5-axiom signal detection, constitutional scoring, hard-gate rules,
 * and Brain episodic signal publishing.
 *
 * @module constitution
 */

// Types
export type {
  AxiomId,
  GateSeverity,
  GateViolation,
  SignalPoint,
  CycleStep,
  CycleMetadata,
  CycleSnapshot,
} from "./types.js";
export { cycleSnapshotSchema } from "./types.js";

// Axioms
export type { Axiom } from "./axioms.js";
export {
  INSTITUTIONNEL,
  SOTA,
  ROBUSTE,
  ANTI_FRAGILE,
  PROFITABLE,
  BUILT_IN_AXIOMS,
  SECRET_PATTERN,
} from "./axioms.js";

// Scorer
export type { ScoringResult, ScoringFunction, RegisteredScorer } from "./scorer.js";
export {
  institutionnelScorer,
  sotaScorer,
  robusteScorer,
  antiFragileScorer,
  profitableScorer,
  ScorerRegistry,
  defaultScorerRegistry,
} from "./scorer.js";

// Gate
export type { ParentCycleContext, GateResult } from "./gate.js";
export { HardGate, hardGate } from "./gate.js";

// Signal
export type { SignalBrainPort, AxiomScoreEntry } from "./signal.js";
export { publishSignal, publishAllSignals } from "./signal.js";
