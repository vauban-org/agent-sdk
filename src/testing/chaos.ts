/**
 * @vauban-org/agent-sdk/testing — chaos harness (Sprint-475 / Sprint-477).
 *
 * Inject realistic failure patterns into a port impl to validate that
 * agents + resilience primitives (circuit breaker, idempotent, bulkhead)
 * behave correctly under adverse conditions. Not to be used in production.
 *
 * Usage (vitest):
 *   import { injectFailure, networkJitter } from "@vauban-org/agent-sdk/testing";
 *   const flaky = injectFailure(brain, { rate: 0.3, err: () => new BrainRateLimit() });
 *   const slow  = networkJitter(outcome, { minMs: 10, maxMs: 500 });
 */

import { BrainRateLimit, BrainUnavailable } from "../errors.js";

export type FailureType = "rate-limit" | "unavailable" | "error";

export interface InjectFailureOptions {
  /** 0..1 probability that a call fails instead of delegating. */
  rate: number;
  /**
   * Optional factory that produces the Error to throw. Defaults based
   * on `type` (rate-limit -> BrainRateLimit, else BrainUnavailable).
   */
  err?: () => Error;
  /** Shortcut for common error types. */
  type?: FailureType;
  /** Optional PRNG (defaults to Math.random). Inject for deterministic tests. */
  random?: () => number;
}

/**
 * Wrap every function-valued method of `impl` so `rate` fraction of
 * calls throw. Non-function properties pass through unchanged.
 */
export function injectFailure<T extends object>(
  impl: T,
  options: InjectFailureOptions,
): T {
  const rand = options.random ?? Math.random;
  const makeErr = options.err ?? defaultErrorFor(options.type ?? "error");

  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        if (rand() < options.rate) {
          const err = makeErr();
          return Promise.reject(err);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
}

function defaultErrorFor(type: FailureType): () => Error {
  if (type === "rate-limit")
    return () => new BrainRateLimit({ retryAfterMs: 500 });
  if (type === "unavailable") return () => new BrainUnavailable();
  return () => new Error("chaos: injected failure");
}

// ─── Network jitter ───────────────────────────────────────────────────────

export interface NetworkJitterOptions {
  /** Minimum delay per call, in ms. Default 0. */
  minMs?: number;
  /** Maximum delay per call, in ms. Default 100. */
  maxMs?: number;
  /** Optional uniform PRNG for test determinism. */
  random?: () => number;
}

/**
 * Wrap every method so async calls settle after a random delay in
 * [minMs, maxMs]. Combined with bulkhead, proves queue stays bounded
 * under slow backends.
 */
export function networkJitter<T extends object>(
  impl: T,
  options: NetworkJitterOptions = {},
): T {
  const minMs = options.minMs ?? 0;
  const maxMs = options.maxMs ?? 100;
  const rand = options.random ?? Math.random;

  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async function (this: unknown, ...args: unknown[]) {
        const delay = minMs + rand() * (maxMs - minMs);
        await new Promise<void>((r) => setTimeout(r, delay));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
}

// ─── Full-outage helper ───────────────────────────────────────────────────

export interface OutageOptions {
  /** Error factory for every call. */
  err?: () => Error;
}

/**
 * Every call throws. Useful to probe "brain down" degradation paths —
 * pairs with circuitBreaker to assert the breaker trips promptly.
 */
export function fullOutage<T extends object>(
  impl: T,
  options: OutageOptions = {},
): T {
  const makeErr = options.err ?? (() => new BrainUnavailable());
  return injectFailure(impl, {
    rate: 1,
    err: makeErr,
  });
}
