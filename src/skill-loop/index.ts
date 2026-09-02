/**
 * src/skill-loop/index.ts
 *
 * Barrel export for the skill-loop module.
 *
 * Pipeline: candidate → evaluator → ab-runner → sign-off → adoption
 * Supporting: versioning, value-metric, reflexion-replay
 *
 * @module skill-loop
 */

// ── Candidate extraction ──────────────────────────────────────────────────────
export { extractCandidate } from "./candidate.js";
export type { SkillCandidate } from "./candidate.js";

// ── Evaluator ─────────────────────────────────────────────────────────────────
export { evaluateCandidate } from "./evaluator.js";
export type { VerifierExample, EvalResult } from "./evaluator.js";

// ── A/B runner ────────────────────────────────────────────────────────────────
export { ABRunner } from "./ab-runner.js";
export type { ABConfig, ABSlot } from "./ab-runner.js";

// ── Sign-off (Art. 14 human oversight) ────────────────────────────────────────
export { SignOffManager } from "./sign-off.js";
export type {
  SignOffDecision,
  SignOffRecord,
  PendingRequest,
} from "./sign-off.js";

// ── Adoption ──────────────────────────────────────────────────────────────────
export {
  promoteCandidate,
  rejectCandidate,
  deprecateUnderperformers,
  PromotionWithoutSignOffError,
} from "./adoption.js";
export type { AdoptionStatus, AdoptionRecord } from "./adoption.js";

// ── Versioning ────────────────────────────────────────────────────────────────
export { bumpVersion } from "./versioning.js";
export type { SkillVersion } from "./versioning.js";

// ── Value metric ──────────────────────────────────────────────────────────────
export { computeSkillValue, rankSkillsByValue } from "./value-metric.js";
export type { UsageEvent, SkillValueResult } from "./value-metric.js";

// ── Reflexion replay ──────────────────────────────────────────────────────────
export { ReflexionStore } from "./reflexion-replay.js";
export type { ReflexionEntry, ReplayResult } from "./reflexion-replay.js";
