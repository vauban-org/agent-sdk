/**
 * Outcomes module — wire types for /api/outcomes/* REST endpoints.
 *
 * All monetary amounts are integer cents (signed). Negative = cost.
 * Route implementation lives in command-center /api/outcomes/* (sprint-522:quick-4).
 */

/**
 * Open-ended outcome type discriminant.
 * Canonical values: trade_pnl, forecast_accurate, knowledge_consolidated,
 * cost_savings, lead_qualified, sprint_completed, etc.
 */
export type OutcomeType = string;

/** A single measurable business result attributed to an agent run. */
export interface Outcome {
  id: string;
  agent_id: string;
  /** UUID of the agent_run row that produced this outcome. Nullable when created offline. */
  agent_run_id: string | null;
  outcome_type: OutcomeType;
  /** Signed integer cents. Positive = value created, negative = cost incurred. */
  value_cents: number;
  /** ISO 4217 currency code. Defaults to 'USD'. */
  currency: string;
  /** ISO 8601 timestamp of when the outcome occurred. */
  occurred_at: string;
  /**
   * True when the monetary value has not yet been back-filled from an
   * authoritative source (e.g. trade P&L still pending settlement).
   */
  is_pending_backfill: boolean;
  metadata?: Record<string, unknown> | null;
}

/** Aggregated outcome statistics for a given time window. */
export interface OutcomeSummary {
  period: { from: string; to: string };
  /** Sum of positive value_cents over the period. */
  total_value_cents: number;
  /** Absolute sum of negative value_cents (stored as positive). */
  total_cost_cents: number;
  /** total_value_cents / total_cost_cents. Null when cost == 0. */
  value_to_cost_ratio: number | null;
  /** (total_value_cents - total_cost_cents) / total_cost_cents * 100. Null when cost == 0. */
  net_roi_pct: number | null;
  outcome_count: number;
  attributed_count: number;
  /** Outcomes where is_pending_backfill = true. */
  pending_attribution_count: number;
}

/** Per-agent ROI breakdown for a time window. */
export interface RoiPerAgent {
  agent_id: string;
  period: { from: string; to: string };
  value_cents: number;
  cost_cents: number;
  /** Null when cost_cents == 0. */
  net_roi_pct: number | null;
  outcome_count: number;
  /** pending_count / outcome_count. 0 when outcome_count == 0. */
  pending_ratio: number;
  /** Week-over-week delta in net_roi_pct. Null when prior week data unavailable. */
  wow_delta_pct: number | null;
}

/** CFO-ready burn-rate and initiative breakdown view. */
export interface CfoView {
  period: { from: string; to: string };
  /** Average daily spend in cents over the period. */
  burn_rate_per_day_cents: number;
  /** burn_rate_per_day_cents * 30. */
  projected_30d_cents: number;
  by_initiative: Array<{
    initiative_id: string;
    spent_cents: number;
    /** Null when no budget is assigned to the initiative. */
    budget_cents: number | null;
    /** spent_cents / budget_cents * 100. Null when budget_cents is null. */
    pct: number | null;
  }>;
  /**
   * Sum of value_cents for is_pending_backfill=true rows.
   * Lower-bound estimate of unrealised value.
   */
  pending_value_estimate_cents: number;
}
