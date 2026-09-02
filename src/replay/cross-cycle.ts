/**
 * Cross-cycle replay propagation.
 *
 * When a parent cycle spawns a child cycle (via mesh.delegate or compute
 * strategy), the child must inherit a deterministic-replay context that — on
 * replay — reproduces the SAME outputs as the original chain.
 *
 * Design:
 *   ChainedReplayContext extends ReplayContext with chain-ancestry metadata.
 *   propagateContext() derives a child ctx from a parent ctx:
 *     - Clock: cloned at the parent's current cursor position (child picks up
 *       where parent left off — continuous, non-resetting).
 *     - Random: cloned at the parent's current cursor positions.
 *     - LLMCache: composite (withParent) — child looks up parent on miss,
 *       writes disabled in replay mode.
 *   replayChain() drives a multi-cycle chain replay end-to-end.
 *
 * Invariant:
 *   A child cycle replayed with propagateContext(parentCtx, childRunId) produces
 *   the same rootHash as the original child cycle IF AND ONLY IF the parent ctx
 *   has consumed the same number of clock/random values that the original parent
 *   had consumed at the point it spawned the child.
 *
 * @module replay/cross-cycle
 */

import type { Trace } from "../trace/schema.js";
import { RecordedClock } from "./clock.js";
import type { LLMResponseCache } from "./llm-cache.js";
import { withParent } from "./llm-cache.js";
import { RecordedRandom } from "./random.js";
import type {
  ReplayContext,
  ReplayLoader,
  ReplayMode,
  ReplayResult,
  ReplayRunner,
} from "./replay.js";
import { replayFrom } from "./replay.js";

// ─── ChainedReplayContext ─────────────────────────────────────────────────────

/**
 * Extends ReplayContext with chain-ancestry metadata for cross-cycle replay.
 *
 * Chain invariant:
 *   chainRootRunId is constant across all cycles in the chain.
 *   chainDepth is 0 for the root cycle, 1 for direct children, etc.
 *   parentRunId is undefined only for the root cycle (depth === 0).
 */
export interface ChainedReplayContext extends ReplayContext {
  /**
   * runId of the direct parent cycle.
   * Undefined for the root cycle (chainDepth === 0).
   */
  readonly parentRunId?: string;

  /**
   * Zero-based depth in the spawning chain.
   * Root cycle = 0. Each delegation increments by 1.
   */
  readonly chainDepth: number;

  /**
   * runId of the root (depth-0) cycle in this chain.
   * Same for all cycles in a chain — used as the chain correlation key.
   */
  readonly chainRootRunId: string;
}

// ─── ChainCorrelation ─────────────────────────────────────────────────────────

/**
 * Summary of all cycles replayed in a chain.
 * Used by callers to verify the full ancestry post-replay.
 */
export interface ChainCorrelation {
  /** runId of the root (depth-0) cycle. */
  rootRunId: string;
  /** Each cycle entry in replay order (root first, deepest child last). */
  chain: {
    runId: string;
    parentRunId?: string;
    depth: number;
    /** rootHash produced by this cycle's replay. */
    rootHash: string;
  }[];
}

// ─── ChainReplayResult ────────────────────────────────────────────────────────

/**
 * Result of replaying an entire chain of N cycles.
 *
 * match === true iff ALL cycles in the chain matched their original rootHash.
 * results contains individual ReplayResult per cycle (in chain order).
 * correlation contains the ancestry summary.
 */
export interface ChainReplayResult {
  /** True iff every cycle in the chain is byte-identical to its original. */
  match: boolean;
  /** Per-cycle replay results in chain order (root first). */
  results: ReplayResult[];
  /** Chain correlation summary. */
  correlation: ChainCorrelation;
}

// ─── MissingParentRunError ────────────────────────────────────────────────────

/**
 * Thrown by replayChain when a non-root cycle references a parentRunId that
 * is not present in the runIds list.
 */
export class MissingParentRunError extends Error {
  constructor(
    public readonly runId: string,
    public readonly parentRunId: string,
  ) {
    super(
      `Cross-cycle replay: cycle "${runId}" references parent "${parentRunId}" which is not in the provided runIds list. Ensure all cycles in the chain are loaded in order.`,
    );
    this.name = "MissingParentRunError";
  }
}

// ─── propagateContext ─────────────────────────────────────────────────────────

/**
 * Derive a child ChainedReplayContext from a parent ChainedReplayContext.
 *
 * - clock: cloned at parent's current cursor position (child inherits NEXT timestamps).
 * - random: cloned at parent's current cursor positions (continuous stream).
 * - cache: composite cache — child looks up parent on miss, writes disabled.
 * - chainDepth: parent.chainDepth + 1.
 * - chainRootRunId: inherited unchanged from parent.
 *
 * IMPORTANT: call this AFTER the parent runner has finished executing (so the
 * parent's clock/random cursors reflect all timestamps consumed during the
 * parent cycle). If called mid-parent-execution the cursors will be wrong.
 *
 * @param parentCtx   The finished parent cycle's ChainedReplayContext.
 * @param childRunId  The originalRunId of the child cycle being replayed.
 */
export function propagateContext(
  parentCtx: ChainedReplayContext,
  childRunId: string,
): ChainedReplayContext {
  // Obtain concrete RecordedClock/RecordedRandom for cloning.
  // The parent ctx.clock/random are ClockPort/RandomPort interfaces; we must
  // narrow them to the concrete recording types to call clone().
  // If the caller provides a non-RecordedClock (e.g. RealClock) in a
  // ChainedReplayContext, it is a mis-use — surface it clearly.
  if (!(parentCtx.clock instanceof RecordedClock)) {
    throw new TypeError(
      "propagateContext: parentCtx.clock must be a RecordedClock instance. " +
        "Chained replay requires virtualized clocks.",
    );
  }
  if (!(parentCtx.random instanceof RecordedRandom)) {
    throw new TypeError(
      "propagateContext: parentCtx.random must be a RecordedRandom instance. " +
        "Chained replay requires virtualized randoms.",
    );
  }

  const childClock = parentCtx.clock.clone();
  const childRandom = parentCtx.random.clone();
  const childCache: LLMResponseCache = withParent(parentCtx.cache, true);

  return {
    originalRunId: childRunId,
    replayRunId: globalThis.crypto.randomUUID(),
    mode: parentCtx.mode,
    clock: childClock,
    random: childRandom,
    cache: childCache,
    parentRunId: parentCtx.originalRunId,
    chainDepth: parentCtx.chainDepth + 1,
    chainRootRunId: parentCtx.chainRootRunId,
  };
}

// ─── buildRootContext ─────────────────────────────────────────────────────────

/**
 * Build a root ChainedReplayContext (depth === 0, no parent).
 * This is the equivalent of the per-cycle context built inside replayFrom,
 * but typed as ChainedReplayContext so it can be passed to propagateContext.
 */
async function buildRootContext(
  rootRunId: string,
  loader: ReplayLoader,
  mode: ReplayMode,
): Promise<{ ctx: ChainedReplayContext; originalTrace: Trace }> {
  const [originalTrace, artifacts] = await Promise.all([
    loader.loadOriginalTrace(rootRunId),
    loader.loadCacheEntries(rootRunId),
  ]);

  const clock = new RecordedClock(artifacts.recordedTs);
  const random = new RecordedRandom(artifacts.recordedNext, artifacts.recordedUuids, mode);

  const ctx: ChainedReplayContext = {
    originalRunId: rootRunId,
    replayRunId: globalThis.crypto.randomUUID(),
    mode,
    clock,
    random,
    cache: artifacts.cache,
    parentRunId: undefined,
    chainDepth: 0,
    chainRootRunId: rootRunId,
  };

  return { ctx, originalTrace };
}

// ─── replayChain ──────────────────────────────────────────────────────────────

/**
 * Replay a chain of N cycles using shared virtualized dependencies.
 *
 * Cycles are replayed in the order provided by `runIds`. Each cycle after the
 * first inherits its context from the preceding cycle via `propagateContext`.
 *
 * The chain structure is: runIds[0] is the root (depth 0), runIds[1] is its
 * direct child (depth 1), etc. This matches linear delegation chains. For
 * tree-shaped chains (one parent spawning multiple children) call replayChain
 * once per branch.
 *
 * @param runIds   Ordered list of original runIds — root first.
 * @param loader   Loader for traces + artifacts. Must be able to load all runIds.
 * @param runner   Runner that executes each cycle with its virtualised context.
 * @param opts     Optional mode override (default: "strict").
 */
export async function replayChain(
  runIds: string[],
  loader: ReplayLoader,
  runner: ReplayRunner,
  opts?: { mode?: ReplayMode },
): Promise<ChainReplayResult> {
  if (runIds.length === 0) {
    throw new RangeError("replayChain: runIds must contain at least one runId.");
  }

  const mode: ReplayMode = opts?.mode ?? "strict";
  const results: ReplayResult[] = [];
  const correlationChain: ChainCorrelation["chain"] = [];

  // Validate that all runIds are unique and non-empty
  const seen = new Set<string>();
  for (const id of runIds) {
    if (!id) throw new RangeError("replayChain: runIds contains empty string.");
    if (seen.has(id)) {
      throw new RangeError(`replayChain: duplicate runId "${id}" in chain.`);
    }
    seen.add(id);
  }

  // Build root context
  const rootRunId = runIds[0];
  const { ctx: rootCtx, originalTrace: rootTrace } = await buildRootContext(
    rootRunId,
    loader,
    mode,
  );

  // Replay root cycle
  const rootReplayTrace = await runner.run(rootCtx, rootTrace);
  const rootMatch = rootTrace.rootHash === rootReplayTrace.rootHash;
  const rootResult: ReplayResult = {
    replayRunId: rootCtx.replayRunId,
    trace: rootReplayTrace,
    match: rootMatch,
    diff: rootMatch ? [] : computeDiff(rootTrace, rootReplayTrace),
  };
  results.push(rootResult);
  correlationChain.push({
    runId: rootRunId,
    parentRunId: undefined,
    depth: 0,
    rootHash: rootReplayTrace.rootHash,
  });

  // Replay child cycles using propagated contexts
  let prevCtx: ChainedReplayContext = rootCtx;

  for (let i = 1; i < runIds.length; i++) {
    const childRunId = runIds[i];
    const parentRunId = runIds[i - 1];

    // Validate parent is present in our tracked list (belt-and-suspenders)
    const parentIdx = runIds.indexOf(parentRunId);
    if (parentIdx === -1) {
      throw new MissingParentRunError(childRunId, parentRunId);
    }

    // Load child's original trace + artifacts for the loader
    // (propagateContext builds the ctx, but replayFrom also loads artifacts
    // internally — we bypass replayFrom here to use the propagated ctx directly)
    const [childOriginalTrace] = await Promise.all([loader.loadOriginalTrace(childRunId)]);

    const childCtx = propagateContext(prevCtx, childRunId);
    const childReplayTrace = await runner.run(childCtx, childOriginalTrace);
    const childMatch = childOriginalTrace.rootHash === childReplayTrace.rootHash;

    results.push({
      replayRunId: childCtx.replayRunId,
      trace: childReplayTrace,
      match: childMatch,
      diff: childMatch ? [] : computeDiff(childOriginalTrace, childReplayTrace),
    });

    correlationChain.push({
      runId: childRunId,
      parentRunId,
      depth: i,
      rootHash: childReplayTrace.rootHash,
    });

    prevCtx = childCtx;
  }

  const allMatch = results.every((r) => r.match);

  return {
    match: allMatch,
    results,
    correlation: {
      rootRunId,
      chain: correlationChain,
    },
  };
}

// ─── Internal: computeDiff ────────────────────────────────────────────────────

/**
 * Minimal step-level diff (mirrors diffTraces from replay.ts — inlined to
 * avoid circular import since replay.ts is not exported at module level).
 */
function computeDiff(original: Trace, replayed: Trace): ReplayResult["diff"] {
  type Diff = NonNullable<ReplayResult["diff"]>;
  const diffs: Diff = [];

  const minLen = Math.min(original.steps.length, replayed.steps.length);
  for (let i = 0; i < minLen; i++) {
    const o = original.steps[i];
    const r = replayed.steps[i];
    for (const field of Object.keys(o) as (keyof typeof o)[]) {
      if (JSON.stringify(o[field]) !== JSON.stringify(r[field])) {
        diffs.push({ stepIndex: i, field, original: o[field], replayed: r[field] });
      }
    }
  }
  if (original.steps.length !== replayed.steps.length) {
    diffs.push({
      stepIndex: minLen,
      field: "index",
      original: original.steps.length,
      replayed: replayed.steps.length,
    });
  }
  return diffs;
}

// ─── Re-export replayFrom with optional parentCtx ────────────────────────────

/**
 * Extended replayFrom that accepts an optional parentCtx.
 *
 * When parentCtx is supplied, the child run inherits clock/random/cache from
 * the parent via propagateContext instead of loading fresh artifacts.
 * This enables replaying a single child cycle in isolation when the parent
 * context is already available (e.g. for targeted debugging of a specific cycle).
 *
 * The loader is still called for the child's originalTrace.
 * loadCacheEntries is skipped — the parent ctx provides the cache.
 */
export async function replayFromWithParent(
  runId: string,
  loader: ReplayLoader,
  runner: ReplayRunner,
  opts?: { mode?: ReplayMode; parentCtx?: ChainedReplayContext },
): Promise<ReplayResult> {
  if (!opts?.parentCtx) {
    // Delegate to the standard single-cycle replayFrom
    return replayFrom(runId, loader, runner, { mode: opts?.mode });
  }

  const parentCtx = opts.parentCtx;
  const originalTrace = await loader.loadOriginalTrace(runId);
  const childCtx = propagateContext(parentCtx, runId);

  const replayTrace = await runner.run(childCtx, originalTrace);
  const match = originalTrace.rootHash === replayTrace.rootHash;

  return {
    replayRunId: childCtx.replayRunId,
    trace: replayTrace,
    match,
    diff: match ? [] : computeDiff(originalTrace, replayTrace),
  };
}
