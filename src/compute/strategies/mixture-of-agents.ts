/**
 * src/compute/strategies/mixture-of-agents.ts
 *
 * Mixture-of-Agents (MoA) compute strategy.
 *
 * Reference: Wang et al. 2024, "Mixture of Agents", arXiv:2406.04692.
 *
 * Algorithm:
 *   - L rounds (layers). Each round runs M proposers (independent parallel calls).
 *   - After each round, an aggregator synthesizes the M outputs into ONE result.
 *   - The synthesized result becomes the seed for the next round (currently
 *     opaque to the generator — synthesis is purely on the output side; the
 *     same input is used each round, but the aggregated state is returned).
 *   - Final aggregated output is the answer.
 *
 * Budget: M × L total generator calls.
 *
 * Default aggregation:
 *   - string outputs : concatenate with "\n---\n" then take first non-empty
 *   - number outputs : median
 *   - other          : first element
 *
 * @experimental Public-experimental API per `contract-stability.md` (sprint-582).
 */

import type { ComputeContext, Strategy, StrategyResult } from "../types.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** @public */
export interface MoAConfig<TOutput> {
  /** Number of rounds (L). Default: 2. */
  rounds: number;
  /** Proposers per round (M). Default: 3. */
  proposersPerRound: number;
  /** Aggregation function: M outputs → 1 synthesized output. */
  aggregate?: (outputs: TOutput[]) => TOutput;
}

const STRATEGY_NAME = "mixture-of-agents";

// ─── Default aggregator ──────────────────────────────────────────────────────

function defaultAggregator<T>(outputs: T[]): T {
  if (outputs.length === 0) {
    throw new Error("mixtureOfAgentsStrategy: aggregator called with 0 outputs");
  }
  const first = outputs[0];

  // Strings: concat for traceability, then return first non-empty after concat header.
  // Per spec: "if outputs are strings, concatenate with '\n---\n' prefix and take
  // the first non-empty (simple but correct for MVP)."
  if (typeof first === "string") {
    const nonEmpty = outputs.find((o) => typeof o === "string" && (o as string).length > 0);
    return (nonEmpty ?? first) as T;
  }

  // Numbers: median.
  if (typeof first === "number") {
    const nums = (outputs as unknown as number[]).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return first;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return median as unknown as T;
  }

  // Other types: return first (identity fallback).
  return first;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

// ─── Strategy factory ────────────────────────────────────────────────────────

/**
 * Construct a Mixture-of-Agents {@link Strategy}.
 *
 * @throws RangeError when `rounds` or `proposersPerRound` < 1.
 * @public
 */
export function mixtureOfAgentsStrategy<TInput, TOutput>(
  config?: Partial<MoAConfig<TOutput>>,
): Strategy<TInput, TOutput> {
  const rounds = config?.rounds ?? 2;
  const proposersPerRound = config?.proposersPerRound ?? 3;
  const aggregate = config?.aggregate ?? defaultAggregator;

  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new RangeError(`mixtureOfAgentsStrategy: rounds must be >=1, got ${rounds}`);
  }
  if (!Number.isInteger(proposersPerRound) || proposersPerRound < 1) {
    throw new RangeError(
      `mixtureOfAgentsStrategy: proposersPerRound must be >=1, got ${proposersPerRound}`,
    );
  }

  return {
    name: STRATEGY_NAME,

    async run(
      input: TInput,
      generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>,
      ctx: ComputeContext = {},
    ): Promise<StrategyResult<TOutput>> {
      const start = performance.now();
      const signal = ctx.signal;
      throwIfAborted(signal);

      const childCtx: ComputeContext = signal ? { signal } : {};

      let aggregated: TOutput | undefined;
      let totalCalls = 0;

      for (let r = 0; r < rounds; r++) {
        throwIfAborted(signal);
        const outputs = await Promise.all(
          Array.from({ length: proposersPerRound }, () => generator(input, childCtx)),
        );
        totalCalls += proposersPerRound;
        throwIfAborted(signal);
        aggregated = aggregate(outputs);
      }

      const latency_ms = performance.now() - start;

      if (aggregated === undefined) {
        // Unreachable: rounds >= 1 guarantees aggregated is set.
        throw new Error("mixtureOfAgentsStrategy: no aggregated result");
      }

      return {
        result: aggregated,
        metadata: {
          strategy: STRATEGY_NAME,
          candidates: totalCalls,
          verifier_scores: [],
          cost: { calls: totalCalls },
          latency_ms,
        },
      };
    },
  };
}
