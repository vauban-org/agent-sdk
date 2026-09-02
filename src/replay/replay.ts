/**
 * replayFrom — deterministic agent run replay.
 *
 * Given a runId, a ReplayLoader (fetches original trace + recorded artifacts),
 * and a ReplayRunner (re-executes the agent with virtualized dependencies),
 * replayFrom produces a ReplayResult containing:
 *   - The replayed trace.
 *   - A match flag: true iff rootHash of replay === rootHash of original.
 *   - A diff array listing step-level field mismatches (when match is false).
 *
 * Design invariant:
 *   Replay proves byte-identical traces when ClockPort, RandomPort, and
 *   LLMResponseCache are virtualized. It does NOT prove LLM provider-side
 *   determinism — the provider may return different tokens under identical
 *   inputs (temperature, context window, batching).
 *
 * @module replay/replay
 */

import type { Trace, TraceStep } from "../trace/schema.js";
import type { ClockPort } from "./clock.js";
import type { LLMResponseCache } from "./llm-cache.js";
import type { RandomPort } from "./random.js";

// ─── ReplayMode ───────────────────────────────────────────────────────────────

/**
 * Controls strictness of the replay session.
 *
 * - 'strict': crypto()/cryptoUuid() throws CryptoRandomDuringReplayError.
 *             Any non-deterministic call is surfaced immediately.
 * - 'tolerant': crypto()/cryptoUuid() returns fresh bytes (non-fatal).
 *               Useful for runs that legitimately mix deterministic + crypto calls.
 * @public
 */
export type ReplayMode = "strict" | "tolerant";

// ─── ReplayContext ────────────────────────────────────────────────────────────

/**
 * Virtualised execution context for a replay run.
 * Pass this to ReplayRunner.run() in place of the production context.
 * @public
 */
export interface ReplayContext {
  /** runId of the original run being replayed. */
  readonly originalRunId: string;
  /**
   * A distinct runId for this replay run.
   * Must differ from originalRunId — replay runs are traceable separately.
   */
  readonly replayRunId: string;
  /** Strictness mode for crypto calls. */
  readonly mode: ReplayMode;
  /** Virtualized clock replaying the original run's timestamps. */
  readonly clock: ClockPort;
  /** Virtualized PRNG replaying the original run's random values. */
  readonly random: RandomPort;
  /** Virtualized LLM cache replaying the original run's responses. */
  readonly cache: LLMResponseCache;
}

// ─── ReplayResult ─────────────────────────────────────────────────────────────

/**
 * Result of a replay execution.
 *
 * match === true  → replay is byte-identical to the original (rootHash matches).
 * match === false → at least one step diverged; see diff for details.
 * @public
 */
export interface ReplayResult {
  /** The replay run identifier. */
  replayRunId: string;
  /** The trace produced by the replay run. */
  trace: Trace;
  /**
   * True iff the rootHash of the replay trace equals the rootHash of the
   * original trace. This is the primary audit assertion.
   */
  match: boolean;
  /**
   * Step-level field mismatches, populated when match is false.
   * Empty array when match is true.
   */
  diff?: {
    stepIndex: number;
    field: keyof TraceStep;
    original: unknown;
    replayed: unknown;
  }[];
}

// ─── ReplayLoader ─────────────────────────────────────────────────────────────

/**
 * Port for loading the artifacts needed to replay a run.
 * The host provides a concrete implementation (e.g. pgsql, file system).
 * @public
 */
export interface ReplayLoader {
  /**
   * Fetch the original Trace for the given runId.
   * Throws if the run is not found.
   */
  loadOriginalTrace(runId: string): Promise<Trace>;

  /**
   * Fetch all recorded artifacts for the given runId:
   *   - recordedTs: timestamps array for RecordedClock
   *   - recordedNext: float array for RecordedRandom.next()
   *   - recordedUuids: UUID array for RecordedRandom.uuid()
   *   - cache: LLMResponseCache populated with the original run's responses
   */
  loadCacheEntries(runId: string): Promise<{
    recordedTs: number[];
    recordedNext: number[];
    recordedUuids: string[];
    cache: LLMResponseCache;
  }>;
}

// ─── ReplayRunner ─────────────────────────────────────────────────────────────

/**
 * Port for re-executing the agent with a virtualised context.
 * The host provides a concrete implementation that wires the agent
 * to the virtualised ClockPort, RandomPort, and LLMResponseCache.
 *
 * Extended contract (counterfactual support):
 *   Implementations MAY inspect `(ctx as { strategyOverride?: string }).strategyOverride`
 *   to swap their compute strategy for offline counterfactual analysis.
 *   This field is injected exclusively by `replayCounterfactual` (offline tool) —
 *   it is never present in production replay contexts.
 * @public
 */
export interface ReplayRunner {
  /**
   * Re-execute the agent using ctx (virtual clock/random/cache)
   * starting from the state described in originalTrace.
   *
   * Returns the new Trace produced by the replay.
   *
   * @param ctx           Virtualised execution context. When ctx carries a
   *                      `strategyOverride` field (injected by replayCounterfactual),
   *                      the implementation SHOULD honour it by swapping its
   *                      compute strategy accordingly. This parameter is optional
   *                      on the interface — existing implementations that do not
   *                      inspect it remain fully compatible.
   * @param originalTrace Original trace providing the starting state.
   */
  run(ctx: ReplayContext, originalTrace: Trace): Promise<Trace>;
}

// ─── NonDeterministicReplayError ─────────────────────────────────────────────

/**
 * Thrown when strict-mode replay detects a non-deterministic deviation
 * that cannot be represented as a diff (e.g. step count mismatch, missing steps).
 *
 * For field-level mismatches, see ReplayResult.diff instead.
 * @public
 */
export class NonDeterministicReplayError extends Error {
  constructor(
    public readonly stepIndex: number,
    public readonly reason: string,
  ) {
    super(`Non-deterministic replay at step ${stepIndex}: ${reason}`);
    this.name = "NonDeterministicReplayError";
  }
}

// ─── diffTraces ───────────────────────────────────────────────────────────────

/**
 * Compute a step-level diff between two traces.
 * Returns an empty array if the traces are identical at the step level.
 */
function diffTraces(original: Trace, replayed: Trace): ReplayResult["diff"] {
  const diffs: NonNullable<ReplayResult["diff"]> = [];

  const minLen = Math.min(original.steps.length, replayed.steps.length);
  for (let i = 0; i < minLen; i++) {
    const origStep = original.steps[i];
    const repStep = replayed.steps[i];
    for (const field of Object.keys(origStep) as (keyof TraceStep)[]) {
      const ov = origStep[field];
      const rv = repStep[field];
      // Compare via JSON serialization to handle nested objects correctly
      if (JSON.stringify(ov) !== JSON.stringify(rv)) {
        diffs.push({ stepIndex: i, field, original: ov, replayed: rv });
      }
    }
  }

  // If step counts differ, flag the extra/missing steps
  if (original.steps.length !== replayed.steps.length) {
    diffs.push({
      stepIndex: minLen,
      field: "index" as keyof TraceStep,
      original: original.steps.length,
      replayed: replayed.steps.length,
    });
  }

  return diffs;
}

// ─── replayFrom ───────────────────────────────────────────────────────────────

/**
 * Main replay entry point.
 *
 * 1. Loads the original trace and recorded artifacts via ReplayLoader.
 * 2. Builds a ReplayContext with RecordedClock, RecordedRandom, and LLM cache.
 * 3. Re-executes the agent via ReplayRunner.run().
 * 4. Compares rootHashes and computes a step-level diff if they differ.
 *
 * @param runId   The original run identifier to replay.
 * @param loader  Host-provided loader for trace + artifacts.
 * @param runner  Host-provided runner that wires the agent to virtualised deps.
 * @param opts    Optional overrides: replay mode, step index to replay from.
 * @public
 */
export async function replayFrom(
  runId: string,
  loader: ReplayLoader,
  runner: ReplayRunner,
  opts?: { mode?: ReplayMode; fromStepIndex?: number },
): Promise<ReplayResult> {
  const mode = opts?.mode ?? "strict";

  // 1. Load original artifacts
  const [rawTrace, artifacts] = await Promise.all([
    loader.loadOriginalTrace(runId),
    loader.loadCacheEntries(runId),
  ]);

  // Auto-migrate traces recorded under the draft schema to the frozen 1.0.0
  const originalTrace =
    (rawTrace.schemaVersion as string) === "0.1.0-draft"
      ? { ...rawTrace, schemaVersion: "1.0.0" as const }
      : rawTrace;

  // 2. Import concrete implementations lazily to avoid circular references
  const { RecordedClock } = await import("./clock.js");
  const { RecordedRandom } = await import("./random.js");

  const clock = new RecordedClock(artifacts.recordedTs);
  const random = new RecordedRandom(artifacts.recordedNext, artifacts.recordedUuids, mode);

  // 3. Build the replay context
  const replayRunId = globalThis.crypto.randomUUID();
  const ctx: ReplayContext = {
    originalRunId: runId,
    replayRunId,
    mode,
    clock,
    random,
    cache: artifacts.cache,
  };

  // 4. Re-execute
  const replayTrace = await runner.run(ctx, originalTrace);

  // 5. Compare
  const match = originalTrace.rootHash === replayTrace.rootHash;
  const diff = match ? [] : diffTraces(originalTrace, replayTrace);

  return {
    replayRunId,
    trace: replayTrace,
    match,
    diff,
  };
}
