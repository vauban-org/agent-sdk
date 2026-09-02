/**
 * src/compute/with-compute.ts
 *
 * Public `withCompute()` API — caller-explicit strategy entry point.
 *
 * Contract (Sprint A):
 * - Strategy is REQUIRED and explicit (no auto-routing).
 * - Returns `StrategyResult<O>` whose `metadata.strategy` equals the strategy's `name`.
 * - Pre-flight guards run BEFORE invoking the generator:
 *     1. `strategy` must be a non-null object with a usable `run` function.
 *     2. `budget.maxCalls === 0` → throw `BudgetExhaustedError`.
 *     3. `deadline` already past → throw `DeadlineExceededError`.
 *     4. `signal` already aborted → throw the signal's `reason` (DOMException 'AbortError' by default).
 * - Generator rejections bubble up unchanged.
 */

import type { ComputeContext, Strategy, StrategyResult } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** @public */
export class InvalidStrategyError extends Error {
  override readonly name = "InvalidStrategyError";
  constructor(message = "withCompute: `strategy` is required and must implement Strategy<I,O>") {
    super(message);
  }
}

/** @public */
export class BudgetExhaustedError extends Error {
  override readonly name = "BudgetExhaustedError";
  constructor(message = "withCompute: budget exhausted (maxCalls=0)") {
    super(message);
  }
}

/** @public */
export class DeadlineExceededError extends Error {
  override readonly name = "DeadlineExceededError";
  constructor(message = "withCompute: deadline exceeded before invocation") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ComputeBudget {
  /** Maximum number of generator calls allowed. `0` halts immediately. */
  maxCalls?: number;
}

/** @public */
export interface WithComputeOptions<TInput, TOutput> {
  /** Caller-explicit strategy. No auto-routing. */
  strategy: Strategy<TInput, TOutput>;
  /** Generator invoked by the strategy. */
  generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>;
  /** Optional cost cap. */
  budget?: ComputeBudget;
  /** Epoch milliseconds. If `Date.now() >= deadline` at entry, throws. */
  deadline?: number;
  /** Optional cancellation signal — wired into ComputeContext. */
  signal?: AbortSignal;
}

/** @public */
export type WithComputeResult<TOutput> = StrategyResult<TOutput>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function isStrategyLike<I, O>(value: unknown): value is Strategy<I, O> {
  if (value === null || typeof value !== "object") return false;
  const v = value as { name?: unknown; run?: unknown };
  return typeof v.name === "string" && typeof v.run === "function";
}

/**
 * Run a compute task under an explicit strategy with pre-flight budget/deadline/abort guards.
 * @public
 */
export async function withCompute<TInput, TOutput>(
  input: TInput,
  options: WithComputeOptions<TInput, TOutput>,
): Promise<WithComputeResult<TOutput>> {
  // Guard 1: strategy must be valid (runtime guard for JS callers).
  if (!options || !isStrategyLike<TInput, TOutput>(options.strategy)) {
    throw new InvalidStrategyError();
  }

  // Guard 2: budget zero → halt before any work.
  if (options.budget?.maxCalls === 0) {
    throw new BudgetExhaustedError();
  }

  // Guard 3: deadline already past.
  if (typeof options.deadline === "number" && Date.now() >= options.deadline) {
    throw new DeadlineExceededError();
  }

  // Guard 4: abort signal already triggered.
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const ctx: ComputeContext = options.signal ? { signal: options.signal } : {};

  return options.strategy.run(input, options.generator, ctx);
}
