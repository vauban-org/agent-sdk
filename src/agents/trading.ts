/**
 * Agent-specific trading types — @vauban-org/agent-sdk v0.7.1 (sprint-526 Bloc 5b)
 *
 * Pure types + one pure helper. No I/O, no side effects.
 *
 * Types mirror the `trade_detail` DB schema (sprint-526:quick-1) so the SDK
 * surface stays in sync with persistence without a direct DB dependency.
 *
 * @public
 */

/**
 * A single trade record, mirroring the `trade_detail` table.
 * All monetary values are in integer cents to avoid float64 rounding.
 */
export interface Trade {
  id: string;
  outcome_id: string;
  agent_run_id: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entry_price_cents: number;
  exit_price_cents: number | null;
  pnl_cents: number | null;
  slippage_bps: number | null;
  alpaca_order_id: string;
  trading_mode: "paper" | "live";
  entry_at: string;
  exit_at: string | null;
  exit_reason: "stop" | "target" | "timeout" | "manual" | null;
}

/**
 * Observable snapshot of a RiskGuard circuit-breaker instance.
 * Mirrors the in-memory state exposed by the OODA RiskGuard.
 */
export interface RiskGuardState {
  name: string;
  state: "closed" | "open" | "half-open";
  failure_count: number;
  last_failure: string | null;
  reset_after: string | null;
}

/**
 * A single orientation-memory entry persisted to Brain.
 * The `metadata.kind` discriminator enables efficient FTS filtering.
 */
export interface OrientationMemory {
  entry_id: string;
  content: string;
  metadata: {
    kind: "orientation-memory";
    symbol: string;
    regime: string;
    observed_at: string;
  };
}

/**
 * Runtime-configurable thresholds for the trading-nq agent.
 * Loaded via `AgentConfigLoader` so changes apply without restart.
 */
export interface TradingNQConfig {
  thresholds: {
    conviction_min: number;
    kelly_cap: number;
    kelly_bootstrap_fraction: number;
    bootstrap_trade_threshold: number;
    hitl_timeout_ms: number;
    stop_loss_atr_multiple: number;
    target_atr_multiple: number;
    trade_timeout_minutes: number;
  };
}

/**
 * Compute a Kelly criterion sizing fraction with a bootstrap fallback.
 *
 * V5 anti-pattern #2 (piège 2): never apply full Kelly before sufficient
 * historical data. When `historicalTradeCount < bootstrap_trade_threshold`,
 * returns a conservative fixed fraction instead of the Kelly estimate.
 *
 * Variance is floored at `1e-9` to guard against divide-by-zero.
 * Fraction is clamped to `[0, kelly_cap]` — never negative, never unbounded.
 *
 * @param historicalTradeCount - Completed trades available for calibration.
 * @param expectedReturn       - Expected return per trade (e.g. mean PnL).
 * @param variance             - Variance of returns (must be ≥ 0).
 * @param config               - Cap + bootstrap parameters.
 * @returns Sizing fraction and the mode used for traceability.
 *
 * @public
 */
export function computeKellyFraction(
  historicalTradeCount: number,
  expectedReturn: number,
  variance: number,
  config: {
    kelly_cap: number;
    kelly_bootstrap_fraction: number;
    bootstrap_trade_threshold: number;
  },
): { fraction: number; mode: "bootstrap" | "kelly" } {
  if (historicalTradeCount < config.bootstrap_trade_threshold) {
    return { fraction: config.kelly_bootstrap_fraction, mode: "bootstrap" };
  }
  const kelly = expectedReturn / Math.max(variance, 1e-9);
  return {
    fraction: Math.min(Math.max(kelly, 0), config.kelly_cap),
    mode: "kelly",
  };
}
