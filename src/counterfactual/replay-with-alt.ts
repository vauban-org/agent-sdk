/**
 * OFFLINE TOOL. NOT a centerpiece. Use for ex-post analysis only —
 * never wire into live runtime.
 *
 * replayCounterfactual — counterfactual replay primitive.
 *
 * Given an original runId, replays the same cycle with an alternative compute
 * strategy (or verifier / temperature override). The original run's
 * clock/random/cache are kept fixed — only the compute strategy is swapped.
 *
 * Purpose: offline "what-if" analysis. E.g. "what if this cycle had used
 * best-of-n instead of single-shot?"
 *
 * Design invariants:
 *   - Does NOT mutate the original trace or any live execution path.
 *   - ReplayRunner.run() receives a ReplayContext augmented with strategyOverride
 *     injected into the runner's compute config.
 *   - "outputsCoherent" = same runtime type AND same top-level keys (for objects).
 *   - "outputsIdentical" = deep structural equality via JSON serialisation.
 *
 * @module counterfactual/replay-with-alt
 */

import type { Verifier } from "../compute/verifier.js";
import { RecordedClock } from "../replay/clock.js";
import { RecordedRandom } from "../replay/random.js";
import type { ReplayContext, ReplayLoader, ReplayRunner } from "../replay/replay.js";

// ─── ComputeStrategyName ──────────────────────────────────────────────────────

/**
 * Canonical strategy names accepted by the runner's strategyOverride field.
 * Callers passing an unknown name will get an InvalidStrategyNameError.
 */
export type ComputeStrategyName = "single-shot" | "best-of-n" | "bon-mav";

/** All valid strategy names as a frozen set for runtime validation. */
const VALID_STRATEGY_NAMES: ReadonlySet<ComputeStrategyName> = new Set<ComputeStrategyName>([
  "single-shot",
  "best-of-n",
  "bon-mav",
]);

// ─── CounterfactualOptions ────────────────────────────────────────────────────

/**
 * Options for replayCounterfactual.
 * At least one of alt_strategy, alt_verifier, or alt_temperature should differ
 * from the original run to produce a meaningful counterfactual.
 */
export interface CounterfactualOptions {
  /** Swap the compute strategy (e.g. "best-of-n" instead of "single-shot"). */
  alt_strategy?: ComputeStrategyName;
  /** Replace the verifier used by the strategy (e.g. swap to a stricter judge). */
  alt_verifier?: Verifier;
  /** Replace the generation temperature (0–2 range; host-interpreted). */
  alt_temperature?: number;
}

// ─── CounterfactualResult ─────────────────────────────────────────────────────

/**
 * Result of a counterfactual replay run.
 *
 * outputsCoherent:
 *   true when both outputs have the same runtime type AND, if both are plain
 *   objects, the same set of top-level keys. This is a structural compatibility
 *   check — not a value comparison.
 *
 * outputsIdentical:
 *   true when JSON.stringify(original) === JSON.stringify(counterfactual).
 *   Guarantees deep value equality for JSON-serialisable outputs.
 */
export interface CounterfactualResult {
  /** runId of the original run that was replayed. */
  originalRunId: string;
  /** runId assigned to the counterfactual replay run. */
  counterfactualRunId: string;
  /** Output produced by replaying with the original strategy / settings. */
  originalOutput: unknown;
  /** Output produced by replaying with the altered strategy / settings. */
  counterfactualOutput: unknown;
  /**
   * true iff both outputs are structurally compatible:
   *   - Same typeof (or both null).
   *   - If both are plain objects: same set of top-level keys (order-independent).
   */
  outputsCoherent: boolean;
  /**
   * true iff both outputs are byte-identical under JSON serialisation.
   * Implies outputsCoherent === true.
   */
  outputsIdentical: boolean;
  metadata: {
    /** Strategy swap details, present when alt_strategy was supplied. */
    strategySwapped?: {
      from: string;
      to: ComputeStrategyName;
    };
    /**
     * Difference in reported cost_usd between the two runs.
     * Positive = counterfactual was more expensive.
     * undefined when the runner does not populate cost_usd.
     */
    cost_delta_usd?: number;
    /**
     * Difference in wall-clock latency in milliseconds.
     * Positive = counterfactual was slower.
     */
    latency_delta_ms?: number;
    /** Number of LLM cache hits during the counterfactual run. */
    cacheHits: number;
    /** Number of LLM cache misses during the counterfactual run. */
    cacheMisses: number;
  };
}

// ─── InvalidStrategyNameError ─────────────────────────────────────────────────

/**
 * Thrown when alt_strategy is not one of the known ComputeStrategyName values.
 */
export class InvalidStrategyNameError extends Error {
  constructor(public readonly name: string) {
    super(
      `replayCounterfactual: unknown alt_strategy "${name}". ` +
        `Valid values: ${[...VALID_STRATEGY_NAMES].join(", ")}.`,
    );
    this.name = "InvalidStrategyNameError";
  }
}

// ─── CounterfactualReplayContext ──────────────────────────────────────────────

/**
 * Internal extension of ReplayContext carrying counterfactual overrides.
 * Passed to ReplayRunner.run() — the runner inspects these fields to swap
 * its compute configuration for the counterfactual execution.
 */
export interface CounterfactualReplayContext extends ReplayContext {
  /** When present, the runner MUST override its compute strategy with this name. */
  readonly strategyOverride?: ComputeStrategyName;
  /** When present, the runner SHOULD swap its verifier with this instance. */
  readonly verifierOverride?: Verifier;
  /** When present, the runner SHOULD apply this temperature value. */
  readonly temperatureOverride?: number;
}

// ─── RunOutput (internal contract) ───────────────────────────────────────────

/**
 * Extended Trace type that the runner may annotate with output metadata.
 * These fields are OPTIONAL — runners that do not populate them cause the
 * corresponding CounterfactualResult.metadata fields to be undefined.
 */
interface TraceWithExtras {
  rootHash: string;
  steps: unknown[];
  /** The agent's final output value, if the runner chose to attach it. */
  output?: unknown;
  /** Reported USD cost of this run (generator calls × per-call cost). */
  cost_usd?: number;
  /** Wall-clock latency of this run in milliseconds. */
  latency_ms?: number;
  /** Number of LLM cache hits during this run. */
  cacheHits?: number;
  /** Number of LLM cache misses during this run. */
  cacheMisses?: number;
}

// ─── Coherence check ─────────────────────────────────────────────────────────

/**
 * Determine structural coherence between two outputs.
 *
 * Two outputs are "coherent" when:
 *   1. Both have the same typeof (e.g. both "string", both "object").
 *   2. If both are non-null plain objects: same set of top-level keys
 *      (set equality, order-independent).
 *   3. Special case: both null → coherent (typeof null === "object" in JS,
 *      but we treat null explicitly).
 */
function areCoherent(a: unknown, b: unknown): boolean {
  // Handle null explicitly (typeof null === "object" would be misleading)
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;

  // Both non-null objects: compare top-level key sets
  if (ta === "object") {
    const keysA = Object.keys(a as Record<string, unknown>).sort();
    const keysB = Object.keys(b as Record<string, unknown>).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
    }
    return true;
  }

  // Primitives (string, number, boolean, etc.) — same typeof is sufficient
  return true;
}

// ─── replayCounterfactual ─────────────────────────────────────────────────────

/**
 * Replay the original cycle twice — once with its original config, once with
 * the alt overrides — and compare outputs.
 *
 * Both runs use the SAME virtualized clock, random, and LLM cache derived from
 * the original run's recorded artifacts. Only the compute strategy (and optional
 * verifier / temperature) differs.
 *
 * OFFLINE TOOL. Do NOT call from any live execution path.
 *
 * @param originalRunId  runId of the run to analyse counterfactually.
 * @param loader         Loader for the original trace + recorded artifacts.
 * @param runner         Runner that accepts CounterfactualReplayContext.
 *                       Contract: runner.run() MUST honour ctx.strategyOverride
 *                       when present.
 * @param opts           Counterfactual overrides (at least one should differ
 *                       from the original to be meaningful).
 */
export async function replayCounterfactual(
  originalRunId: string,
  loader: ReplayLoader,
  runner: ReplayRunner,
  opts: CounterfactualOptions,
): Promise<CounterfactualResult> {
  // ── Validate alt_strategy early ────────────────────────────────────────────
  if (opts.alt_strategy !== undefined && !VALID_STRATEGY_NAMES.has(opts.alt_strategy)) {
    throw new InvalidStrategyNameError(opts.alt_strategy);
  }

  // ── Load original artifacts ─────────────────────────────────────────────────
  const [originalTrace, artifacts] = await Promise.all([
    loader.loadOriginalTrace(originalRunId),
    loader.loadCacheEntries(originalRunId),
  ]);

  // ── Determine original strategy from trace metadata (best-effort) ──────────
  // Runners may embed the strategy name in trace steps or config.
  // We look for it in originalTrace.config as a convention.
  const traceConfig = originalTrace.config as Record<string, unknown> | undefined;
  const originalStrategyName: string =
    typeof traceConfig?.strategy === "string" ? traceConfig.strategy : "unknown";

  // ── Build two independent virtualised contexts ──────────────────────────────
  // Each gets a fresh RecordedClock/RecordedRandom so they don't share cursors.

  const buildCtx = (
    replayRunId: string,
    overrides: {
      strategyOverride?: ComputeStrategyName;
      verifierOverride?: Verifier;
      temperatureOverride?: number;
    },
  ): CounterfactualReplayContext => {
    const clock = new RecordedClock([...artifacts.recordedTs]);
    const random = new RecordedRandom(
      [...artifacts.recordedNext],
      [...artifacts.recordedUuids],
      "strict",
    );
    return {
      originalRunId,
      replayRunId,
      mode: "strict",
      clock,
      random,
      cache: artifacts.cache,
      ...overrides,
    };
  };

  const originalReplayRunId = globalThis.crypto.randomUUID();
  const counterfactualRunId = globalThis.crypto.randomUUID();

  const originalCtx = buildCtx(originalReplayRunId, {
    // No overrides — reproduce original behaviour
  });

  const counterfactualCtx = buildCtx(counterfactualRunId, {
    strategyOverride: opts.alt_strategy,
    verifierOverride: opts.alt_verifier,
    temperatureOverride: opts.alt_temperature,
  });

  // ── Run both scenarios ──────────────────────────────────────────────────────
  const t0Original = performance.now();
  const originalReplayTrace = (await runner.run(originalCtx, originalTrace)) as TraceWithExtras;
  const originalLatency = performance.now() - t0Original;

  const t0Cf = performance.now();
  const counterfactualTrace = (await runner.run(
    counterfactualCtx,
    originalTrace,
  )) as TraceWithExtras;
  const cfLatency = performance.now() - t0Cf;

  // ── Extract outputs ─────────────────────────────────────────────────────────
  const originalOutput: unknown = originalReplayTrace.output ?? originalReplayTrace;
  const counterfactualOutput: unknown = counterfactualTrace.output ?? counterfactualTrace;

  // ── Compute comparisons ─────────────────────────────────────────────────────
  const outputsIdentical = JSON.stringify(originalOutput) === JSON.stringify(counterfactualOutput);
  const outputsCoherent = outputsIdentical || areCoherent(originalOutput, counterfactualOutput);

  // ── Build metadata ──────────────────────────────────────────────────────────
  const strategySwapped =
    opts.alt_strategy !== undefined
      ? { from: originalStrategyName, to: opts.alt_strategy }
      : undefined;

  const originalCostUsd = originalReplayTrace.cost_usd;
  const cfCostUsd = counterfactualTrace.cost_usd;
  const cost_delta_usd =
    typeof originalCostUsd === "number" && typeof cfCostUsd === "number"
      ? cfCostUsd - originalCostUsd
      : undefined;

  // Use runner-reported latency when available, fall back to wall-clock
  const origLatencyMs =
    typeof originalReplayTrace.latency_ms === "number"
      ? originalReplayTrace.latency_ms
      : originalLatency;
  const cfLatencyMs =
    typeof counterfactualTrace.latency_ms === "number" ? counterfactualTrace.latency_ms : cfLatency;

  const latency_delta_ms = cfLatencyMs - origLatencyMs;

  const cacheHits =
    typeof counterfactualTrace.cacheHits === "number" ? counterfactualTrace.cacheHits : 0;
  const cacheMisses =
    typeof counterfactualTrace.cacheMisses === "number" ? counterfactualTrace.cacheMisses : 0;

  return {
    originalRunId,
    counterfactualRunId,
    originalOutput,
    counterfactualOutput,
    outputsCoherent,
    outputsIdentical,
    metadata: {
      strategySwapped,
      cost_delta_usd,
      latency_delta_ms,
      cacheHits,
      cacheMisses,
    },
  };
}
