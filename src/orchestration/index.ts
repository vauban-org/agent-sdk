/**
 * Orchestration primitives — public barrel.
 *
 * Exports:
 *   - OODA agent loop (sprint-525 Bloc 5a)
 *   - Idempotency key utilities (sprint-468:idempotency-keys)
 *   - Bulkhead worker pool (sprint-468:bulkhead)
 *
 * @public
 */

export * from "./ooda/index.js";

// Idempotency key utilities (sprint-468:idempotency-keys)
export type {
  IdempotencyKeyPayload,
  WithIdempotencyOptions,
} from "./idempotency.js";
export {
  computeIdempotencyKey,
  withIdempotency,
  addIdempotencyHeader,
} from "./idempotency.js";

// Bulkhead worker pool (sprint-468:bulkhead)
export { BulkheadQueueFullError, createBulkhead } from "./bulkhead.js";
export type {
  BulkheadOptions as OrchestrationBulkheadOptions,
  BulkheadMetrics,
  BulkheadPool,
} from "./bulkhead.js";

// SOTA orchestration engine — result-driven DAG (Cap 1+2+3).
// The scheduler + pure port contracts so a consumer (preste) can inject a
// concrete NodeExecutor and run a dependency graph with maximal parallelism.
export { runDag, DagSchedulerError } from "./dag/scheduler.js";
export type {
  AdaptiveBestOfNPolicy,
  DagNodeSpec,
  DagRunInput,
  DagRunManifest,
  NodeExecutor,
  NodeInputs,
  NodeManifestEntry,
  NodeOutcome,
  NodeStatus,
  RePlanner,
  StepJournal,
  Verifier,
  VerifierVerdict,
  WorkflowProgressEvent,
  WorkflowProgressSink,
} from "./dag/contracts.js";
// Cap 1 — verifier-driven best-of-N adapters. Cap 1.5 — MoB selection policy.
export { bestOfN, batteryVerifier, mobSelectIndex } from "./dag/best-of-n.js";
export type {
  BatteryVerifierOptions,
  SelectionPolicy,
} from "./dag/best-of-n.js";
