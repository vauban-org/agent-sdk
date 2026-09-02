/**
 * Pattern A: Session-Level Circuit Breaker — types.
 *
 * DISTINCT from `resilience/circuit-breaker.ts` which wraps async functions.
 * This pattern tracks SESSION METRICS (tokens, errors, actions, cost, time)
 * and integrates as a RiskGuard for the OODA cycle.
 *
 * State machine: closed → open (threshold breach) → half-open (after
 * resetAfterMs) → closed (probe success via recordSuccess()).
 *
 * IMPORTANT: record* methods must be called manually from phase functions.
 * The OODA loop does NOT auto-feed these metrics.
 *
 * @public
 */
import type { RiskGuard } from "../../orchestration/ooda/types.js";
import type { BrainPort } from "../../ports/brain.js";
import type { LoggerPort } from "../../ports/logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly tokenCount: number;
  readonly consecutiveErrors: number;
  readonly actionCount: number;
  readonly elapsedMs: number;
  readonly estimatedCostUsd: number;
  readonly tripReason?: string;
  readonly openedAt?: number;
}

export interface CircuitBreakerThresholds {
  /** Max cumulative tokens before trip. Default: 50_000 */
  readonly maxTokens?: number;
  /** Max consecutive errors before trip. Default: 5 */
  readonly maxConsecutiveErrors?: number;
  /** Max action count per session. Default: 200 */
  readonly maxActionCount?: number;
  /** Max session elapsed ms. Default: 3_600_000 (1h) */
  readonly maxElapsedMs?: number;
  /** Max estimated cost USD. Default: 10.0 */
  readonly maxCostUsd?: number;
}

export interface CircuitBreakerConfig {
  readonly name: string;
  readonly thresholds?: CircuitBreakerThresholds;
  /** Time to stay OPEN before half-open probe. Default: 60_000 ms */
  readonly resetAfterMs?: number;
  readonly brain?: BrainPort;
  readonly logger?: LoggerPort;
  /** Called synchronously when circuit trips. Must not throw. */
  readonly onTrip?: (snapshot: CircuitSnapshot) => void;
  /** Injectable clock for tests. Default: Date.now */
  readonly _now?: () => number;
}

/**
 * Session-level circuit breaker. Implements RiskGuard + metric recording.
 *
 * Add to OODAAgentConfig.riskGuards. Phase functions call record* methods.
 */
export interface SessionCircuitBreaker extends RiskGuard {
  recordTokens(count: number, costUsd?: number): void;
  recordError(): void;
  /** Record a successful action. Resets consecutiveErrors. Closes half-open probe. */
  recordSuccess(): void;
  recordAction(): void;
  reset(): void;
  snapshot(): CircuitSnapshot;
}
