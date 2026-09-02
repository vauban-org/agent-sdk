/**
 * @vauban-org/agent-sdk/testing/chaos — chaos harness (Sprint-475 / Sprint-477).
 *
 * Inject realistic failure patterns into a port impl to validate that
 * agents + resilience primitives (circuit breaker, idempotent, bulkhead)
 * behave correctly under adverse conditions. Not to be used in production.
 *
 * Public API (Sprint-477):
 *   injectBrainFailure<P>(port, { failureRate, type? }) — BrainPort-aware wrapper
 *   networkJitter<P>(port, { p99Ms, p50Ms? })           — latency injection
 *   wholeCircuit<P>(port)                               — trips every call (half-open testing)
 *   exhaustResources<P>(port, { maxCalls })             — throws after N calls
 *
 * Legacy API (Sprint-475 — kept for backward compat):
 *   injectFailure<T>(impl, opts)  — generic failure injection
 *   fullOutage<T>(impl, opts)     — rate=1 shorthand
 *
 * Usage (vitest):
 *   import { injectBrainFailure, networkJitter } from "@vauban-org/agent-sdk/testing/chaos";
 *   const flaky = injectBrainFailure(brain, { failureRate: 0.3, type: "rate-limit" });
 *   const slow  = networkJitter(brain, { p99Ms: 500, p50Ms: 50 });
 */

import { BrainRateLimit, BrainUnavailable } from "../errors.js";
import type { BrainPort } from "../ports/index.js";

export type FailureType = "rate-limit" | "timeout" | "network" | "random" | "unavailable" | "error";

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
export function injectFailure<T extends object>(impl: T, options: InjectFailureOptions): T {
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
  if (type === "rate-limit") return () => new BrainRateLimit({ retryAfterMs: 500 });
  if (type === "unavailable") return () => new BrainUnavailable();
  if (type === "timeout")
    return () => Object.assign(new Error("chaos: timeout"), { code: "ETIMEDOUT" });
  if (type === "network")
    return () => Object.assign(new Error("chaos: network error"), { code: "ECONNRESET" });
  if (type === "random") {
    const types: Array<"rate-limit" | "unavailable" | "timeout" | "network"> = [
      "rate-limit",
      "unavailable",
      "timeout",
      "network",
    ];
    return () => defaultErrorFor(types[Math.floor(Math.random() * types.length)])();
  }
  return () => new Error("chaos: injected failure");
}

// ─── Network jitter ───────────────────────────────────────────────────────

export interface NetworkJitterOptions {
  /** Minimum delay per call, in ms. Default 0. */
  minMs?: number;
  /** Maximum delay per call, in ms. Default 100. */
  maxMs?: number;
  /**
   * p99 latency in ms (Sprint-477 API). When set, models a log-normal
   * distribution where ~99% of calls complete within p99Ms.
   * If both legacy (minMs/maxMs) and new (p99Ms) options are provided,
   * p99Ms takes precedence.
   */
  p99Ms?: number;
  /**
   * p50 (median) latency in ms. Only meaningful when p99Ms is set.
   * Defaults to p99Ms / 10 (rough estimate for a log-normal dist).
   */
  p50Ms?: number;
  /** Optional uniform PRNG for test determinism. */
  random?: () => number;
}

/**
 * Wrap every method so async calls settle after a random delay.
 *
 * Two usage modes:
 *   networkJitter(port, { minMs: 10, maxMs: 100 })          — uniform [min,max]
 *   networkJitter(port, { p99Ms: 500, p50Ms: 50 })          — log-normal percentile model
 *
 * Combined with bulkhead, proves queue stays bounded under slow backends.
 */
export function networkJitter<T extends object>(impl: T, options: NetworkJitterOptions = {}): T {
  const rand = options.random ?? Math.random;

  function sampleDelayMs(): number {
    if (options.p99Ms !== undefined) {
      // Model via log-normal: solve for μ and σ so that
      //   P50 = exp(μ) and P99 ≈ exp(μ + 2.326σ)
      const p50 = options.p50Ms ?? options.p99Ms / 10;
      const p99 = options.p99Ms;
      // μ = ln(p50); σ = (ln(p99) - ln(p50)) / 2.326
      const mu = Math.log(Math.max(p50, 1));
      const sigma = (Math.log(Math.max(p99, p50 + 1)) - mu) / 2.326;
      // Box-Muller transform for normal sample
      const u1 = Math.max(rand(), 1e-10);
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.exp(mu + sigma * z);
    }
    const minMs = options.minMs ?? 0;
    const maxMs = options.maxMs ?? 100;
    return minMs + rand() * (maxMs - minMs);
  }

  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async function (this: unknown, ...args: unknown[]) {
        const delay = sampleDelayMs();
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
export function fullOutage<T extends object>(impl: T, options: OutageOptions = {}): T {
  const makeErr = options.err ?? (() => new BrainUnavailable());
  return injectFailure(impl, {
    rate: 1,
    err: makeErr,
  });
}

// ─── Sprint-477: BrainPort-aware helpers ─────────────────────────────────

/** @public */
export interface InjectBrainFailureOptions {
  /** 0..1 probability that any call fails. */
  failureRate: number;
  /** Error type to inject. Default "rate-limit". */
  type?: "rate-limit" | "timeout" | "network" | "random";
  /** Optional PRNG for deterministic tests. */
  random?: () => number;
}

/**
 * BrainPort-specific chaos wrapper. Semantically equivalent to
 * injectFailure but typed against BrainPort and uses BrainPort-aware
 * defaults (rate-limit → BrainRateLimit instead of generic error).
 *
 * Usage:
 *   const flaky = injectBrainFailure(brain, { failureRate: 0.3, type: "rate-limit" });
 *   // Use in narrator tests to assert Brain-dependent steps are skipped.
 */
export function injectBrainFailure<P extends BrainPort>(
  port: P,
  opts: InjectBrainFailureOptions,
): P {
  return injectFailure(port, {
    rate: opts.failureRate,
    type: opts.type ?? "rate-limit",
    random: opts.random,
  });
}

// ─── wholeCircuit ─────────────────────────────────────────────────────────

/**
 * Trips every call immediately (rate=1, BrainUnavailable). Designed for
 * half-open testing: wrap the port BEFORE passing it to circuitBreaker,
 * then advance the clock past resetAfterMs to trigger the HALF-OPEN probe.
 *
 *   const cb = circuitBreaker(wholeCircuit(brain).archiveKnowledge.bind(...), {
 *     failureThreshold: 1,
 *     resetAfterMs: 1_000,
 *     now: () => clock,
 *   });
 */
export function wholeCircuit<P extends object>(port: P): P {
  return fullOutage(port);
}

// ─── exhaustResources ─────────────────────────────────────────────────────

/** @public */
export interface ExhaustResourcesOptions {
  /** Number of successful calls before throwing. */
  maxCalls: number;
  /** Error factory for calls past the limit. Default: BrainUnavailable. */
  err?: () => Error;
}

/**
 * Allow the first `maxCalls` invocations to succeed, then throw on
 * every subsequent call. Simulates quota exhaustion or memory pressure.
 *
 * Counter is shared across all methods — useful to cap total call volume
 * in property tests regardless of which method is invoked.
 */
export function exhaustResources<P extends object>(port: P, opts: ExhaustResourcesOptions): P {
  const makeErr = opts.err ?? (() => new BrainUnavailable());
  let callCount = 0;

  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        callCount += 1;
        if (callCount > opts.maxCalls) {
          return Promise.reject(makeErr());
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as P;
}
