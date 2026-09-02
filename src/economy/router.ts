/**
 * economy/router — EconomyRouter dual-mode (Sprint D).
 *
 * Decides WHICH model tier to use for a given task category, based on
 * observed cost-per-cycle data from OutcomeTracker. Sits ABOVE TierPolicy
 * (which produces the candidate set) and is informed by FleetCircuitBreaker.
 *
 * NOT to be confused with the compute-strategy router (withCompute, Sprint A)
 * or the legacy heuristic complexity router (src/router/llm-router.ts).
 *
 * Substrate-pure: no consumer-specific product references.
 */

import type { FleetCircuitBreaker } from "./circuit-breaker.js";
import type { CycleCost, OutcomeTracker } from "./outcome-tracker.js";
import type { ModelTier, TierPolicy } from "./tier-policy.js";

// ─── Public types ─────────────────────────────────────────────────────────

/** @public */
export type EconomyMode = "degraded" | "full";

/** @public */
export interface EconomyRouterConfig {
  mode: EconomyMode;
  policy: TierPolicy;
  tracker: OutcomeTracker;
  breaker: FleetCircuitBreaker;
  /** Fraction of budget to leave as buffer when filtering tiers by cost. Default 0.1 (10%). */
  budgetBuffer?: number;
}

/** @public */
export interface RouteDecision {
  tier: ModelTier;
  mode: EconomyMode;
  reason: string;
  blockedByBreaker: boolean;
}

// ─── Internal constants ───────────────────────────────────────────────────

/** Default rolling cost-window for tier-cost averaging. 1 hour. */
const COST_WINDOW_MS = 3_600_000;

/**
 * Cost ceiling for "cheap-enough to upgrade" heuristic, in USD per cycle.
 * Below this average cycle cost, the router will try a tier ABOVE the policy
 * default (better quality at acceptable cost). Above it, downgrade.
 */
const UPGRADE_THRESHOLD_USD = 0.005;
const DOWNGRADE_THRESHOLD_USD = 0.05;

// ─── EconomyRouter ────────────────────────────────────────────────────────

/**
 * EconomyRouter — model tier selector informed by observed costs.
 *
 * Degraded mode: cost lookup is per task category.
 * Full mode (Sprint C): cost lookup is per skillId. Falls back to degraded
 *   when no skill data is available.
 * @public
 */
export class EconomyRouter {
  private readonly _mode: EconomyMode;
  private readonly _policy: TierPolicy;
  private readonly _tracker: OutcomeTracker;
  private readonly _breaker: FleetCircuitBreaker;
  private readonly _budgetBuffer: number;

  /** Total `route()` calls. */
  private _totalRouteCalls = 0;
  /** Calls where `blockedByBreaker` was false. */
  private _nonBlockedRouteCalls = 0;

  constructor(config: EconomyRouterConfig) {
    this._mode = config.mode;
    this._policy = config.policy;
    this._tracker = config.tracker;
    this._breaker = config.breaker;
    this._budgetBuffer = config.budgetBuffer ?? 0.1;
  }

  /**
   * Decide which tier to use for a task.
   *
   * Caller is responsible for honouring `blockedByBreaker` — when true,
   * the returned tier is informational and the caller should typically
   * defer or run a degraded execution path.
   */
  route(category: string, opts?: { skillId?: string; budgetRemainingUsd?: number }): RouteDecision {
    this._totalRouteCalls += 1;

    const blockedByBreaker = !this._breaker.canProceed();
    const candidates = this._policy.tiersFor(category, this._mode);
    if (candidates.length === 0) {
      // Defensive: empty candidate set should never happen with DefaultTierPolicy
      // but custom policies might. Surface a clear error.
      throw new Error(
        `EconomyRouter: TierPolicy returned no candidates for category "${category}"`,
      );
    }

    // Apply budget filter (if provided).
    const budget = opts?.budgetRemainingUsd;
    const affordable =
      budget !== undefined
        ? candidates.filter((t) => this._estimateCallCost(t) <= budget * (1 - this._budgetBuffer))
        : candidates;

    // If budget filtered everything, fall back to cheapest known tier.
    const pool = affordable.length > 0 ? affordable : [this._cheapest(candidates)];

    // Cost-history-driven tier selection.
    const avgCost = this._observedAvgCostUsd(category, opts?.skillId);
    let chosen: ModelTier;
    let reason: string;

    if (avgCost === undefined) {
      // No history — use policy default (head of list, intersected with affordable pool).
      chosen = pool[0];
      reason = "default-tier-no-history";
    } else if (avgCost < UPGRADE_THRESHOLD_USD) {
      // Cheap-enough average → try to upgrade one tier.
      chosen = pool.length >= 2 ? pool[1] : pool[0];
      reason = pool.length >= 2 ? "upgrade-cheap-history" : "default-no-upgrade-available";
    } else if (avgCost > DOWNGRADE_THRESHOLD_USD) {
      // Too expensive on average → downgrade to cheapest of pool.
      chosen = this._cheapest(pool);
      reason = "downgrade-expensive-history";
    } else {
      // Within band — keep policy default (head of pool).
      chosen = pool[0];
      reason = "default-tier-within-band";
    }

    if (!blockedByBreaker) {
      this._nonBlockedRouteCalls += 1;
    }

    return {
      tier: chosen,
      mode: this._mode,
      reason: blockedByBreaker ? `${reason}+breaker-open` : reason,
      blockedByBreaker,
    };
  }

  /**
   * Record outcome of a completed cycle. Propagates to OutcomeTracker
   * (which computes cost from pricing) AND to FleetCircuitBreaker.
   *
   * The model identifier sent to the tracker is `provider/model` per
   * tracker convention.
   */
  recordOutcome(
    runId: string,
    tier: ModelTier,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    opts?: {
      skillId?: string;
      outcomeValue?: number;
      category?: string;
    },
  ): void {
    const modelStr = `${tier.provider}/${tier.model}`;
    const cost = this._tracker.record(runId, modelStr, inputTokens, outputTokens, durationMs, {
      ...(opts?.skillId !== undefined ? { skillId: opts.skillId } : {}),
      ...(opts?.outcomeValue !== undefined ? { outcomeValue: opts.outcomeValue } : {}),
      ...(opts?.category !== undefined ? { category: opts.category } : {}),
    });
    this._breaker.recordCost(cost.costUsd);
  }

  /**
   * Routing rate: fraction of `route()` calls that returned non-blocked.
   * 0 when no calls have been made (cannot divide by zero).
   */
  get routingRate(): number {
    if (this._totalRouteCalls === 0) return 0;
    return this._nonBlockedRouteCalls / this._totalRouteCalls;
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  /**
   * Compute average cost-per-cycle observed within the rolling window.
   *
   * In "full" mode with a skillId, we filter records by skillId.
   * Falls back to category filtering when:
   *   - mode is degraded, OR
   *   - skillId is undefined, OR
   *   - no records match the skillId.
   *
   * Returns undefined when no records match (caller treats as "no history").
   */
  private _observedAvgCostUsd(category: string, skillId: string | undefined): number | undefined {
    const all = this._tracker.getCosts(COST_WINDOW_MS);
    if (all.length === 0) return undefined;

    let pool: CycleCost[] = [];
    if (this._mode === "full" && skillId !== undefined) {
      pool = all.filter((r) => r.skillId === skillId);
      if (pool.length === 0) {
        // Fall back to category in full mode when no skill data yet.
        pool = all.filter((r) => r.category === category);
      }
    } else {
      pool = all.filter((r) => r.category === category);
    }

    if (pool.length === 0) return undefined;
    const sum = pool.reduce((acc, r) => acc + r.costUsd, 0);
    return sum / pool.length;
  }

  /**
   * Estimate the cost (USD) of one tier call. Used for budget filtering.
   * Heuristic: assume 1k output tokens per call (output dominates cost).
   */
  private _estimateCallCost(tier: ModelTier): number {
    return (1_000 / 1_000_000) * tier.costPerMTokenOut;
  }

  /** Return the cheapest tier in a non-empty list (by output cost). */
  private _cheapest(tiers: ModelTier[]): ModelTier {
    let best = tiers[0];
    for (const t of tiers) {
      if (t.costPerMTokenOut < best.costPerMTokenOut) best = t;
    }
    return best;
  }
}
