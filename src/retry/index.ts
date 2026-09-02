/**
 * Retry primitives with exponential backoff and optional jitter.
 *
 * Provides three usage modes:
 *   - `retry(fn, opts)` — wrap an async call.
 *   - `RetryContext` — manual control flow for granular retry logic.
 *   - {@link ./presets.js} — 4 named configurations for common scenarios.
 *
 * Sleep is injectable via `RetryOptions.sleepFn`, and jitter RNG via
 * `RetryOptions.randomFn`, for deterministic tests.
 * BaseError.retryable flag is honored by default presets (see ./presets.ts).
 *
 * @public @since 1.2.0
 */

import { RETRY_TRANSIENT } from "./presets.js";

/** @public */
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Retry policy. `jitter: true` adds ±25% randomization to each delay
 * (anti-thundering-herd when multiple callers retry simultaneously).
 *
 * Selection precedence on each error:
 *   1. `retryIf` predicate if provided
 *   2. `retryOn` class membership if provided
 *   3. Default: retry on any error
 *
 * @public
 */
export interface RetryConfig {
  /** Total attempts including the first try. Must be >= 1. */
  readonly maxAttempts: number;
  /** Initial delay before retry 1, in ms. */
  readonly baseDelayMs: number;
  /** Upper bound on any computed delay, in ms. */
  readonly maxDelayMs: number;
  /** Exponent for `baseDelayMs * base^attempt`. Typically 2.0. */
  readonly exponentialBase: number;
  /** Whether to add ±25% random jitter to each delay. */
  readonly jitter: boolean;
  /** If set, only retry when the error is an instance of one of these classes. */
  readonly retryOn?: ReadonlyArray<new (...args: never[]) => Error>;
  /** If set, called per error; return true to retry. Overrides retryOn. */
  readonly retryIf?: (err: unknown) => boolean;
}

/**
 * Options to {@link retry}.
 * @public
 */
export interface RetryOptions {
  /** Retry policy. Defaults to RETRY_TRANSIENT. */
  config?: RetryConfig;
  /** Called before each retry sleep. Receives the error, the 0-indexed attempt that failed, and the upcoming delay. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Sleep injection — defaults to setTimeout. Tests pass a zero-delay or mock. */
  sleepFn?: SleepFn;
  /**
   * RNG injection for jitter — defaults to Math.random. Callers that already
   * expose an injectable random source to their own callers (deterministic
   * tests) can thread it through here instead of duplicating jitter math.
   * @since 3.6.0
   */
  randomFn?: () => number;
}

/**
 * Thrown after all retry attempts have been exhausted.
 * @public
 */
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super(`All ${attempts} retry attempts exhausted: ${reason}`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute the delay before retry `attempt` (0-indexed). Caps at `maxDelayMs`.
 * Jitter, when enabled, adds a uniform-random ±25% offset.
 *
 * `randomFn` defaults to `Math.random`; pass a deterministic source for
 * reproducible tests (see {@link RetryOptions.randomFn}).
 *
 * Visible for tests and for callers that need to inspect timing.
 * @public
 */
export function calculateDelay(
  config: RetryConfig,
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const raw = config.baseDelayMs * config.exponentialBase ** attempt;
  const capped = Math.min(raw, config.maxDelayMs);
  if (!config.jitter) return Math.max(0, capped);
  const jitterRange = capped * 0.25;
  const offset = (randomFn() * 2 - 1) * jitterRange;
  return Math.max(0, capped + offset);
}

/**
 * Decide whether to retry after `err` at 0-indexed `attempt`.
 *
 * Returns false on the final attempt (caller should throw exhaustion).
 *
 * @public
 */
export function shouldRetry(config: RetryConfig, err: unknown, attempt: number): boolean {
  if (attempt >= config.maxAttempts - 1) return false;
  if (config.retryIf) return config.retryIf(err);
  if (config.retryOn && config.retryOn.length > 0) {
    return config.retryOn.some((Ctor) => err instanceof Ctor);
  }
  return true;
}

/**
 * Execute `fn` with retry and exponential backoff.
 *
 * @throws The non-retryable error as-is if `shouldRetry` returns false mid-loop.
 * @throws {@link RetryExhaustedError} when all attempts have failed.
 *
 * @public
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const config = opts.config ?? RETRY_TRANSIENT;
  const sleep = opts.sleepFn ?? defaultSleep;
  const randomFn = opts.randomFn ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(config, err, attempt)) {
        if (attempt >= config.maxAttempts - 1) {
          throw new RetryExhaustedError(config.maxAttempts, err);
        }
        throw err;
      }
      const delay = calculateDelay(config, attempt, randomFn);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }

  throw new RetryExhaustedError(config.maxAttempts, lastError);
}

/**
 * Manual retry control. Use when the operation doesn't fit a single `fn()` —
 * e.g. when multiple endpoints are tried per attempt, or when partial state
 * must be reset between tries.
 *
 * @example
 * ```ts
 * const ctx = new RetryContext({ config: RETRY_AGGRESSIVE });
 * while (ctx.shouldContinue) {
 *   try {
 *     return await op();
 *   } catch (err) {
 *     await ctx.handleError(err);
 *   }
 * }
 * ```
 *
 * @public
 */
export class RetryContext {
  private readonly config: RetryConfig;
  private readonly sleep: SleepFn;
  private readonly randomFn: () => number;
  private readonly onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  private attemptCount = 0;
  private exhausted = false;

  constructor(opts: RetryOptions & { config: RetryConfig }) {
    this.config = opts.config;
    this.sleep = opts.sleepFn ?? defaultSleep;
    this.randomFn = opts.randomFn ?? Math.random;
    this.onRetry = opts.onRetry;
  }

  /** True while attempts remain and no non-retryable error has been thrown. */
  get shouldContinue(): boolean {
    return !this.exhausted && this.attemptCount < this.config.maxAttempts;
  }

  /** 0-indexed count of completed (failed) attempts. */
  get attempt(): number {
    return this.attemptCount;
  }

  /**
   * Record an error and sleep before the next try.
   *
   * @throws The non-retryable error as-is.
   * @throws {@link RetryExhaustedError} if attempts are exhausted.
   */
  async handleError(err: unknown): Promise<void> {
    const failedAttempt = this.attemptCount;
    this.attemptCount += 1;
    if (this.attemptCount >= this.config.maxAttempts) {
      this.exhausted = true;
      throw new RetryExhaustedError(this.config.maxAttempts, err);
    }
    if (!shouldRetry(this.config, err, failedAttempt)) {
      this.exhausted = true;
      throw err;
    }
    const delay = calculateDelay(this.config, failedAttempt, this.randomFn);
    this.onRetry?.(err, failedAttempt, delay);
    await this.sleep(delay);
  }
}

export {
  RETRY_TRANSIENT,
  RETRY_AGGRESSIVE,
  RETRY_PATIENT,
  NO_RETRY,
} from "./presets.js";
