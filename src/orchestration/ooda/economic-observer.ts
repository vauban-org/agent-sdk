/**
 * EconomicObserver — Cost/value guard for autonomous agents.
 *
 * Tracks per-agent token costs vs. outcome value over a 7-day rolling window.
 * Agents with negative ROI get throttled (cycle skipped with reason
 * `economic_observer:negative_roi`).
 *
 * The SDK defines ONLY the interface + guard factory — pure, no DB.
 * Forge implements `PostgresEconomicObserver` backed by TimescaleDB.
 *
 * Throttle logic:
 *   if cost_7d > value_7d * 0.5 AND cycles > 20 → throttle (skip cycle).
 *   Cycles under 20 always run (cold-start grace period).
 *
 * @public
 */

import type { OODAContext, RiskGuard } from "./types.js";

// ─── Interface ──────────────────────────────────────────────────────────────────

/** @public */
export interface EconomicObserver {
  /**
   * Record a completed cycle's cost and value.
   *
   * Called after the feedback phase produces an OutcomeRecord.
   * `confidence` weights the outcome value: effective_value = valueCents * confidence.
   */
  recordCycle(
    agentId: string,
    tokenCostUsd: number,
    outcomeValueCents: number,
    confidence: number,
  ): Promise<void>;

  /**
   * Check whether this agent should be throttled (skipped).
   *
   * Returns true if the agent's 7-day rolling cost exceeds 50% of its
   * 7-day rolling value AND it has completed more than 20 cycles.
   */
  shouldThrottle(agentId: string): Promise<boolean>;

  /**
   * Get statistics for the 7-day rolling window.
   */
  getStats(agentId: string): Promise<{
    cost7d: number;
    value7d: number;
    roi: number;
    cycles: number;
  }>;
}

// ─── Guard Factory ──────────────────────────────────────────────────────────────

/**
 * Create a RiskGuard from an EconomicObserver.
 *
 * Returns a guard compatible with `OODAAgentConfig.riskGuards` —
 * zero boilerplate wiring into the OODA loop.
 * @public
 */
export function economicObserverGuard(observer: EconomicObserver, agentId: string): RiskGuard {
  return {
    name: "economic_observer",
    check: async (_ctx: OODAContext) => {
      const throttled = await observer.shouldThrottle(agentId);
      return {
        proceed: !throttled,
        reason: throttled ? "economic_observer:negative_roi" : undefined,
      };
    },
  };
}
