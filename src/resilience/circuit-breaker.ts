/**
 * Circuit breaker — Hystrix-style state machine.
 *
 * Sprint-468. Wrap an unreliable async operation so N consecutive
 * failures trip the breaker OPEN (all subsequent calls fast-fail
 * without invoking the operation) for `resetAfterMs`. After that a
 * single probe call runs in HALF-OPEN state; success → back to CLOSED,
 * failure → back to OPEN.
 *
 *   CLOSED (normal)
 *     ├─ N failures ──► OPEN (fast-fail, window)
 *     └─ success ──► CLOSED
 *   OPEN
 *     └─ after resetAfterMs ──► HALF-OPEN (1 probe)
 *   HALF-OPEN
 *     ├─ probe success ──► CLOSED
 *     └─ probe failure ──► OPEN (new window)
 *
 * Usage:
 *   const safeArchive = circuitBreaker(brain.archiveKnowledge.bind(brain), {
 *     name: "brain.archive",
 *     failureThreshold: 5,
 *     resetAfterMs: 30_000,
 *   });
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Operation identifier for CircuitOpenError messages. */
  name: string;
  /** Consecutive failures required to trip OPEN. Default 5. */
  failureThreshold?: number;
  /** How long to stay OPEN before the HALF-OPEN probe. Default 30s. */
  resetAfterMs?: number;
  /** Optional clock for tests. */
  now?: () => number;
  /**
   * Predicate — classify an error as "should count as failure" vs
   * "fast-exit without tripping". Default: every thrown value counts.
   */
  isFailure?: (err: unknown) => boolean;
}

export class CircuitOpenError extends Error {
  readonly circuitName: string;
  readonly retryAfterMs: number;
  constructor(circuitName: string, retryAfterMs: number) {
    super(
      `Circuit "${circuitName}" is OPEN — fast-fail. Retry after ${retryAfterMs}ms.`,
    );
    this.name = "CircuitOpenError";
    this.circuitName = circuitName;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitBreaker<TArgs extends unknown[], TResult> {
  (...args: TArgs): Promise<TResult>;
  readonly state: CircuitState;
  /** Consecutive failures in the current CLOSED window. */
  readonly failureCount: number;
  /** Force back to CLOSED (for tests or operational reset). */
  reset(): void;
}

export function circuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions,
): CircuitBreaker<TArgs, TResult> {
  const failureThreshold = options.failureThreshold ?? 5;
  const resetAfterMs = options.resetAfterMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const isFailure = options.isFailure ?? (() => true);

  let state: CircuitState = "closed";
  let failureCount = 0;
  let openedAt = 0;

  async function run(...args: TArgs): Promise<TResult> {
    if (state === "open") {
      const elapsed = now() - openedAt;
      if (elapsed < resetAfterMs) {
        throw new CircuitOpenError(options.name, resetAfterMs - elapsed);
      }
      state = "half-open";
    }

    try {
      const result = await fn(...args);
      if (state === "half-open") {
        state = "closed";
        failureCount = 0;
      } else {
        failureCount = 0;
      }
      return result;
    } catch (err) {
      if (!isFailure(err)) throw err;

      if (state === "half-open") {
        state = "open";
        openedAt = now();
        throw err;
      }

      failureCount += 1;
      if (failureCount >= failureThreshold) {
        state = "open";
        openedAt = now();
      }
      throw err;
    }
  }

  const wrapper = run as CircuitBreaker<TArgs, TResult>;
  Object.defineProperty(wrapper, "state", { get: () => state });
  Object.defineProperty(wrapper, "failureCount", {
    get: () => failureCount,
  });
  Object.defineProperty(wrapper, "reset", {
    value: () => {
      state = "closed";
      failureCount = 0;
      openedAt = 0;
    },
  });
  return wrapper;
}
