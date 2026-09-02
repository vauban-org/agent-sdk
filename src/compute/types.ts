/**
 * src/compute/types.ts
 *
 * Shared types for compute strategies.
 * Minimal surface — only what single-shot (and future strategies) need.
 * @public
 */

export interface ComputeContext {
  signal?: AbortSignal;
}

/** @public */
export interface StrategyResult<T> {
  result: T;
  metadata: {
    strategy: string;
    /** Number of candidates generated (1 for single-shot). */
    candidates: number;
    /** Verifier scores per candidate (empty for single-shot). */
    verifier_scores: number[];
    cost: {
      /** Number of generator calls made. */
      calls: number;
    };
    /** Wall-clock latency in milliseconds. */
    latency_ms: number;
  };
}

/** @public */
export interface Strategy<TInput, TOutput> {
  readonly name: string;
  run(
    input: TInput,
    generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>,
    ctx?: ComputeContext,
  ): Promise<StrategyResult<TOutput>>;
}
