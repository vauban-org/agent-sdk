/**
 * @vauban-org/agent-sdk — Replay module public API.
 *
 * Exports all public types and implementations for deterministic replay.
 *
 * @module replay
 */

// Clock virtualization
export {
  RealClock,
  RecordedClock,
  ClockExhaustedError,
} from "./clock.js";
export type { ClockPort } from "./clock.js";

// Random virtualization (CH4 dual API)
export {
  RealRandom,
  RecordedRandom,
  CryptoRandomDuringReplayError,
} from "./random.js";
export type { RandomPort } from "./random.js";

// LLM response cache
export {
  InMemoryLLMResponseCache,
  CompositeLLMResponseCache,
  hashLLMCacheKey,
  withParent,
} from "./llm-cache.js";
export type {
  LLMCacheKey,
  LLMCacheEntry,
  LLMResponseCache,
} from "./llm-cache.js";

// Replay orchestration
export {
  replayFrom,
  NonDeterministicReplayError,
} from "./replay.js";
export type {
  ReplayMode,
  ReplayContext,
  ReplayResult,
  ReplayLoader,
  ReplayRunner,
} from "./replay.js";

// Cross-cycle propagation
export {
  propagateContext,
  replayChain,
  replayFromWithParent,
  MissingParentRunError,
} from "./cross-cycle.js";
export type {
  ChainedReplayContext,
  ChainCorrelation,
  ChainReplayResult,
} from "./cross-cycle.js";
