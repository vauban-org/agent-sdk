/**
 * src/compute/strategies/best-of-n.ts
 *
 * Best-of-N (BoN) compute strategy.
 *
 * Samples N candidates from the generator, scores each via either a
 * caller-supplied {@link Verifier} OR a {@link BestOfNRewardModel}, and
 * returns the highest-scoring candidate.
 *
 * Caller MUST supply exactly one of `verifier` or `rewardModel`. Supplying
 * both, or neither, throws at strategy-construction time.
 *
 * Tie-break: stable — the first candidate (by sampling order) wins among ties.
 */

import type { ComputeContext, Strategy, StrategyResult } from "../types.js";
import type { Verifier } from "../verifier.js";

const STRATEGY_NAME = "best-of-n";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lightweight reward-model interface — score a candidate output in [0, 1].
 *
 * Distinct from {@link Verifier}: a reward model returns only a scalar score,
 * with no rationale. Use a {@link Verifier} when audit trails / rationales
 * are required; use a reward model when only ranking matters.
 * @public
 */
export interface BestOfNRewardModel<TOutput> {
  /** Score the candidate. `[0, 1]` is preferred but not enforced — higher is better. */
  score(output: TOutput): Promise<number> | number;
}

/** @public */
export interface BestOfNOptions<_TInput, TOutput> {
  /** Number of candidates to sample. `n >= 1`. */
  n: number;
  /** Domain-specific verifier (mutually exclusive with `rewardModel`). */
  verifier?: Verifier<TOutput>;
  /** Reward model (mutually exclusive with `verifier`). */
  rewardModel?: BestOfNRewardModel<TOutput>;
  /** Sample candidates concurrently via `Promise.all` (default `true`). */
  parallel?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Returns a {@link Strategy} that samples N candidates and returns the
 * highest-scoring one.
 *
 * @throws RangeError when `n < 1`.
 * @throws Error when neither or both of `verifier`/`rewardModel` are supplied.
 * @public
 */
export function bestOfNStrategy<TInput, TOutput>(
  opts: BestOfNOptions<TInput, TOutput>,
): Strategy<TInput, TOutput> {
  if (!Number.isInteger(opts.n) || opts.n < 1) {
    throw new RangeError(`bestOfNStrategy: n must be an integer >= 1, got ${String(opts.n)}`);
  }

  const hasVerifier = opts.verifier !== undefined;
  const hasReward = opts.rewardModel !== undefined;
  if (hasVerifier === hasReward) {
    throw new Error("BestOfN requires exactly one of verifier|rewardModel");
  }

  const n = opts.n;
  const parallel = opts.parallel ?? true;
  const verifier = opts.verifier;
  const rewardModel = opts.rewardModel;

  const scoreOne = async (candidate: TOutput): Promise<number> => {
    if (verifier !== undefined) {
      const r = await verifier.evaluate(candidate);
      return r.score;
    }
    // rewardModel guaranteed defined by XOR check above.
    return await (rewardModel as BestOfNRewardModel<TOutput>).score(candidate);
  };

  return {
    name: STRATEGY_NAME,

    async run(
      input: TInput,
      generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>,
      ctx: ComputeContext = {},
    ): Promise<StrategyResult<TOutput>> {
      const start = performance.now();
      const signal = ctx.signal;

      const throwIfAborted = (): void => {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
      };

      throwIfAborted();

      // ── Phase 1: sample N candidates ────────────────────────────────────
      let candidates: TOutput[];
      if (parallel) {
        const tasks: Promise<TOutput>[] = [];
        for (let i = 0; i < n; i++) {
          tasks.push(generator(input, ctx));
        }
        // If any rejects, Promise.all rejects with the first rejection.
        // We do not abort siblings (no internal AbortController by design):
        // the caller's signal — if any — propagates via ctx.
        candidates = await Promise.all(tasks);
      } else {
        candidates = [];
        for (let i = 0; i < n; i++) {
          throwIfAborted();
          candidates.push(await generator(input, ctx));
        }
      }

      throwIfAborted();

      // ── Phase 2: score every candidate ─────────────────────────────────
      const scores: number[] = parallel
        ? await Promise.all(candidates.map((c) => Promise.resolve(scoreOne(c))))
        : await (async () => {
            const out: number[] = [];
            for (const c of candidates) {
              out.push(await scoreOne(c));
            }
            return out;
          })();

      // ── Phase 3: pick best (stable, first-occurrence tie-break) ────────
      let bestIdx = 0;
      let bestScore = scores[0] ?? Number.NEGATIVE_INFINITY;
      for (let i = 1; i < scores.length; i++) {
        const s = scores[i] as number;
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }

      const latency_ms = performance.now() - start;

      return {
        result: candidates[bestIdx] as TOutput,
        metadata: {
          strategy: STRATEGY_NAME,
          candidates: candidates.length,
          verifier_scores: scores,
          cost: { calls: candidates.length },
          latency_ms,
        },
      };
    },
  };
}
