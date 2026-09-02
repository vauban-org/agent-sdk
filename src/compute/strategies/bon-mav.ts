/**
 * src/compute/strategies/bon-mav.ts
 *
 * BoN-MAV — Best-of-N with Multi-Agent Verification.
 *
 * Reference: Lifshitz et al. 2025, "Multi-Agent Verification: Scaling
 * Test-Time Compute with Multiple Verifiers", arXiv:2502.20379.
 *
 * Algorithm (paper § 2.3):
 *   1. Sample N candidate outputs from the generator.
 *   2. For each candidate, run M aspect verifiers in parallel → score matrix [N][M].
 *   3. Aggregate per-candidate score (paper baseline: unweighted mean of binary votes,
 *      Eq. 1 § 2.2). We expose four modes: mean | median | min | majority-vote.
 *   4. Return argmax candidate (ties → first occurrence).
 *
 * See docs/papers/bon-mav-notes.md for the paper distillation.
 */

import type { ComputeContext, Strategy, StrategyResult } from "../types.js";
import type { Verifier } from "../verifier.js";
import { assertVerifierResult } from "../verifier.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** @public */
export type MAVAggregation = "mean" | "median" | "min" | "majority-vote";

/** @public */
export interface BonMavOptions<TOutput> {
  /** Candidate count (>= 1). */
  n: number;
  /** Aspect verifiers (M >= 1). All run on every candidate. */
  verifiers: readonly Verifier<TOutput>[];
  /** Aggregation across verifiers. Default "mean" (paper baseline on continuous scores). */
  aggregation?: MAVAggregation;
  /** Generate candidates concurrently. Default true. */
  parallel?: boolean;
  /**
   * Threshold for "majority-vote" aggregation: a verifier score >= threshold
   * counts as a "yes" vote. Default 0.5. Ignored for other aggregations.
   */
  voteThreshold?: number;
}

/**
 * BoN-MAV-specific metadata extension.
 * `verifier_scores[i]` = AGGREGATED score of candidate i (length N).
 * `mavMatrix[i][j]` = raw score from verifier j on candidate i (N × M).
 */
export interface BonMavMetadata {
  strategy: string;
  candidates: number;
  verifier_scores: number[];
  mavMatrix: number[][];
  aggregation: MAVAggregation;
  cost: { calls: number };
  latency_ms: number;
}

export interface BonMavResult<TOutput> extends StrategyResult<TOutput> {
  metadata: BonMavMetadata;
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

function aggregate(row: readonly number[], mode: MAVAggregation, voteThreshold: number): number {
  const m = row.length;
  if (m === 0) return 0;

  switch (mode) {
    case "mean": {
      let s = 0;
      for (const x of row) s += x;
      return s / m;
    }
    case "median": {
      const sorted = [...row].sort((a, b) => a - b);
      const mid = Math.floor(m / 2);
      return m % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
    case "min": {
      let lo = row[0];
      for (let i = 1; i < m; i++) if (row[i] < lo) lo = row[i];
      return lo;
    }
    case "majority-vote": {
      let votes = 0;
      for (const x of row) if (x >= voteThreshold) votes += 1;
      return votes / m;
    }
    default: {
      // Exhaustiveness — unreachable if MAVAggregation is honored.
      const _exhaustive: never = mode;
      throw new Error(`Unknown aggregation mode: ${String(_exhaustive)}`);
    }
  }
}

// ─── Strategy ────────────────────────────────────────────────────────────────

const STRATEGY_NAME = "bon-mav";

const VALID_AGGREGATIONS: ReadonlySet<string> = new Set(["mean", "median", "min", "majority-vote"]);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

/**
 * Construct a BoN-MAV {@link Strategy}.
 *
 * Validation:
 * - `n < 1` → RangeError
 * - `verifiers.length < 1` → Error
 * - unknown `aggregation` → Error
 * - `voteThreshold` out of [0,1] → RangeError
 * @public
 */
export function bonMavStrategy<TInput, TOutput>(
  opts: BonMavOptions<TOutput>,
): Strategy<TInput, TOutput> {
  const { n, verifiers, aggregation = "mean", parallel = true, voteThreshold = 0.5 } = opts;

  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`bonMavStrategy: n must be a positive integer, got ${n}`);
  }
  if (!verifiers || verifiers.length < 1) {
    throw new Error("BoN-MAV requires at least 1 verifier");
  }
  if (!VALID_AGGREGATIONS.has(aggregation)) {
    throw new Error(`bonMavStrategy: unknown aggregation "${aggregation}"`);
  }
  if (
    typeof voteThreshold !== "number" ||
    !Number.isFinite(voteThreshold) ||
    voteThreshold < 0 ||
    voteThreshold > 1
  ) {
    throw new RangeError(`bonMavStrategy: voteThreshold must be in [0,1], got ${voteThreshold}`);
  }

  const strategyLabel = `${STRATEGY_NAME}-${aggregation}`;

  return {
    name: strategyLabel,

    async run(
      input: TInput,
      generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>,
      ctx: ComputeContext = {},
    ): Promise<BonMavResult<TOutput>> {
      const start = performance.now();
      const signal = ctx.signal;
      throwIfAborted(signal);

      // ── Step 1: sample N candidates ──
      const childCtx: ComputeContext = { signal };
      let candidates: TOutput[];
      if (parallel) {
        candidates = await Promise.all(Array.from({ length: n }, () => generator(input, childCtx)));
      } else {
        candidates = [];
        for (let i = 0; i < n; i++) {
          throwIfAborted(signal);
          candidates.push(await generator(input, childCtx));
        }
      }
      throwIfAborted(signal);

      // ── Step 2: run M verifiers on each candidate (full N×M parallel) ──
      const flat = await Promise.all(
        candidates.flatMap((cand) =>
          verifiers.map(async (v) => {
            const r = await v.evaluate(cand);
            assertVerifierResult(r);
            return r.score;
          }),
        ),
      );
      throwIfAborted(signal);

      const m = verifiers.length;
      const mavMatrix: number[][] = [];
      for (let i = 0; i < n; i++) {
        mavMatrix.push(flat.slice(i * m, (i + 1) * m));
      }

      // ── Step 3: aggregate per-candidate ──
      const aggregated: number[] = mavMatrix.map((row) =>
        aggregate(row, aggregation, voteThreshold),
      );

      // ── Step 4: argmax (first occurrence on ties) ──
      let bestIdx = 0;
      let bestScore = aggregated[0];
      for (let i = 1; i < n; i++) {
        if (aggregated[i] > bestScore) {
          bestScore = aggregated[i];
          bestIdx = i;
        }
      }

      const latency_ms = performance.now() - start;

      return {
        result: candidates[bestIdx],
        metadata: {
          strategy: strategyLabel,
          candidates: n,
          verifier_scores: aggregated,
          mavMatrix,
          aggregation,
          // Paper compute accounting (§ 3): only generator calls billed.
          cost: { calls: n },
          latency_ms,
        },
      };
    },
  };
}
