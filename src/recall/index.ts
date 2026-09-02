/**
 * recall/ — public barrel for the BrainRecallPort SDK module.
 *
 * Promoted from apps/agents/forecaster/src/recall/ to shared SDK port per
 * ADR-ECO-065 (sprint-805 Stage 2). L1 prototype evidence:
 * docs/agentic-rag/L1-evidence-forecaster.md.
 *
 * Naming: the L1 prototype used `BrainChunk` for the HTTP DTO type.
 * In the SDK port it is `RecallChunk` to avoid collision with the SDK's
 * domain-level `BrainChunk` (orchestration/ooda/brain-context.ts).
 *
 * @public
 */

export type {
  RecallChunk,
  BrainRecallPort,
  FreshnessMarker,
  RecallOptions,
  RecallResult,
} from "./types.js";

export {
  parseRecallChunk,
  parseBrainChunk,
  parseFreshnessMarker,
  parseRecallOptions,
  parseRecallResult,
} from "./schema.js";

export {
  brainRecall,
  brainRecallImpl,
  createBrainRecallImpl,
  selectTier,
} from "./brain-recall.js";
export type { BrainRecallConfig } from "./brain-recall.js";

export { renderMemoryContext } from "./memory-context.js";

export { assertCacheSafe, CacheSafetyViolationError } from "./cache-safety.js";
