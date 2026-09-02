/**
 * src/compute/strategies/single-shot.ts
 *
 * Passthrough baseline strategy: calls the generator exactly once, no retries, no scoring.
 */

import type { ComputeContext, Strategy, StrategyResult } from "../types.js";

const STRATEGY_NAME = "single-shot";

/**
 * Returns a {@link Strategy} that invokes the generator once and returns its result.
 *
 * Metadata:
 * - `candidates`: 1
 * - `verifier_scores`: []
 * - `cost.calls`: 1
 * - `latency_ms`: wall-clock duration via `performance.now()`
 * @public
 */
export function singleShotStrategy<TInput, TOutput>(): Strategy<TInput, TOutput> {
  return {
    name: STRATEGY_NAME,

    async run(
      input: TInput,
      generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>,
      ctx: ComputeContext = {},
    ): Promise<StrategyResult<TOutput>> {
      const start = performance.now();
      const result = await generator(input, ctx);
      const latency_ms = performance.now() - start;

      return {
        result,
        metadata: {
          strategy: STRATEGY_NAME,
          candidates: 1,
          verifier_scores: [],
          cost: { calls: 1 },
          latency_ms,
        },
      };
    },
  };
}
