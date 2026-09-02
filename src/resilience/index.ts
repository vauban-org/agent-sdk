/**
 * Resilience primitives — Hystrix-style patterns for port wrappers.
 *
 * Sprint-468. Three composable wrappers that turn any async function
 * into a production-grade primitive:
 *
 *   - circuitBreaker : trip OPEN after N consecutive failures, recover
 *     via HALF-OPEN probe. Prevents overload of a failing dependency.
 *   - idempotent     : dedupe by a stable key; retry-safe writes.
 *   - bulkhead       : bound concurrent in-flight calls + queue depth.
 *
 * These are orthogonal and composable:
 *
 *   const safe = circuitBreaker(
 *     bulkhead(
 *       idempotent(brain.archiveKnowledge.bind(brain), { keyFor: ... }),
 *       { name: "brain.archive", maxConcurrent: 5 }
 *     ),
 *     { name: "brain.archive", failureThreshold: 5, resetAfterMs: 30_000 }
 *   );
 */

export {
  circuitBreaker,
  CircuitOpenError,
} from "./circuit-breaker.js";
export type {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitState,
} from "./circuit-breaker.js";

export {
  idempotent,
  hashKey,
  BoundedTtlCache,
} from "./idempotent.js";
export type {
  IdempotencyCache,
  IdempotentOptions,
} from "./idempotent.js";

export {
  bulkhead,
  BulkheadFullError,
} from "./bulkhead.js";
export type {
  Bulkhead,
  BulkheadOptions,
  BulkheadStats,
} from "./bulkhead.js";
