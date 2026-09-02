/**
 * Named retry presets covering common scenarios.
 *
 * All presets honor a `retryable: boolean` flag on the thrown error when
 * present (compatible with {@link ../errors.js#BaseError}). When the flag is
 * absent, defaults fall back to: transient = retry, no_retry = no retry.
 *
 * @public @since 1.2.0
 */

import type { RetryConfig } from "./index.js";

function honorsRetryableFlag(err: unknown, defaultIfMissing: boolean): boolean {
  if (typeof err === "object" && err !== null && "retryable" in err) {
    return (err as { retryable: unknown }).retryable === true;
  }
  return defaultIfMissing;
}

/**
 * 3 attempts, 1s base, 10s cap, jitter on. Honors `retryable` flag (defaults
 * to retry when absent). Use for short-lived network calls.
 *
 * @public
 */
export const RETRY_TRANSIENT: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
  exponentialBase: 2.0,
  jitter: true,
  retryIf: (err) => honorsRetryableFlag(err, true),
};

/**
 * 5 attempts, 500ms base, 30s cap, jitter on. Use for flaky external APIs
 * where rapid recovery is plausible.
 *
 * @public
 */
export const RETRY_AGGRESSIVE: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  exponentialBase: 2.0,
  jitter: true,
};

/**
 * 10 attempts, 2s base, 120s cap, jitter on. Use for long-recovery
 * dependencies (database failover, restart-storm tolerant calls).
 *
 * @public
 */
export const RETRY_PATIENT: RetryConfig = {
  maxAttempts: 10,
  baseDelayMs: 2000,
  maxDelayMs: 120_000,
  exponentialBase: 2.0,
  jitter: true,
};

/**
 * Single attempt, no retry. Use as an explicit policy to disable retry at
 * call sites without scattering booleans.
 *
 * @public
 */
export const NO_RETRY: RetryConfig = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  exponentialBase: 2.0,
  jitter: false,
};
