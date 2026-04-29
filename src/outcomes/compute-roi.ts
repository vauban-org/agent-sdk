/**
 * computeRoi — pure client-side ROI computation from a set of Outcome rows.
 *
 * No network calls. Safe to run in browser or server contexts.
 * All monetary values are integer cents.
 */

import type { Outcome } from "./types.js";

export interface ComputeRoiInput {
  outcomes: Outcome[];
  /**
   * Optional external cost map.
   * When provided, cost for each outcome is taken from this map (looked up by
   * outcome id) rather than inferred from negative value_cents. Useful when
   * cost is tracked separately from outcome value (e.g. infra spend is
   * attributed via a different signal than the outcome row itself).
   */
  costsCentsByOutcomeId?: Map<string, number>;
}

export interface ComputeRoiResult {
  totalValueCents: number;
  totalCostCents: number;
  /** totalValueCents / totalCostCents. Null when totalCostCents == 0. */
  valueToCostRatio: number | null;
  /** (totalValueCents - totalCostCents) / totalCostCents * 100. Null when totalCostCents == 0. */
  netRoiPct: number | null;
  outcomeCount: number;
  pendingCount: number;
}

/**
 * Compute ROI metrics from a set of Outcome rows.
 *
 * Cost inference:
 * - If `costsCentsByOutcomeId` is provided: cost = map lookup (0 if absent).
 * - Otherwise: cost = abs(value_cents) for rows where value_cents < 0.
 *   Positive value_cents contribute to totalValueCents.
 *
 * Divide-by-zero is handled: ratios are null when totalCostCents == 0.
 */
export function computeRoi(input: ComputeRoiInput): ComputeRoiResult {
  const { outcomes, costsCentsByOutcomeId } = input;

  let totalValueCents = 0;
  let totalCostCents = 0;
  let pendingCount = 0;

  for (const outcome of outcomes) {
    if (outcome.is_pending_backfill) {
      pendingCount++;
    }

    if (costsCentsByOutcomeId !== undefined) {
      // External cost map mode: value and cost are tracked independently.
      // value_cents may still be signed; positive rows contribute value.
      if (outcome.value_cents > 0) {
        totalValueCents += outcome.value_cents;
      }
      const externalCost = costsCentsByOutcomeId.get(outcome.id) ?? 0;
      totalCostCents += externalCost;
    } else {
      // Inferred mode: sign of value_cents determines value vs cost.
      if (outcome.value_cents >= 0) {
        totalValueCents += outcome.value_cents;
      } else {
        totalCostCents += Math.abs(outcome.value_cents);
      }
    }
  }

  const valueToCostRatio =
    totalCostCents === 0 ? null : totalValueCents / totalCostCents;

  const netRoiPct =
    totalCostCents === 0
      ? null
      : ((totalValueCents - totalCostCents) / totalCostCents) * 100;

  return {
    totalValueCents,
    totalCostCents,
    valueToCostRatio,
    netRoiPct,
    outcomeCount: outcomes.length,
    pendingCount,
  };
}
