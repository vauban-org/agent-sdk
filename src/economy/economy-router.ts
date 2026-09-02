/**
 * economy/economy-router — High-level EconomyRouter with tier catalog + circuit breaker.
 *
 * Promoted from forge/src/agents/shared/economy/forge-economy.ts (inline logic)
 * to a reusable SDK module.
 *
 * Design goals:
 *   - Tier catalog is data-driven (injected via EconomyRouterOpts.tiers)
 *   - Circuit breaker triggers on $/h threshold (configurable, default $10)
 *   - Cost recording with optional EventBusPort publish `cc.cost.recorded`
 *   - Multi-tenant isolation via forTenant()
 *
 * @public
 */

import type { EventBusPort } from "../ports/event-bus.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/** @public */
export interface ProviderTier {
  name: "free" | "cheap" | "mid" | "premium";
  costPerInputToken: number; // USD per token
  costPerOutputToken: number; // USD per token
  qualityScore: number; // 0-1
}

/** @public */
export interface EconomyRouterOpts {
  tiers: ProviderTier[];
  hourlyBudgetUsd: number;
  monthlyBudgetUsd: number;
  defaultTier: ProviderTier["name"];
  /** Called when the circuit breaker opens. */
  onCircuitBreak?: (reason: string) => void;
  /** Optional event bus for publishing cc.cost.recorded events. */
  eventBus?: EventBusPort;
  /** Rolling window for hourly budget. Default: 3_600_000ms (1h). */
  windowMs?: number;
  /** Monthly window. Default: 30 * 24 * 3_600_000ms. */
  monthlyWindowMs?: number;
  /** Injected clock for testability. Default: Date.now. */
  _now?: () => number;
  /** Tenant identifier (set by forTenant). */
  _tenantId?: string;
}

/** @public */
export interface CostEntry {
  agentId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  ts: number;
}

// ─── Complexity → tier selection ──────────────────────────────────────────────

/**
 * Map a 0-1 complexity score to a tier name.
 * 0.0-0.25 → free, 0.25-0.5 → cheap, 0.5-0.75 → mid, 0.75-1.0 → premium
 */
function complexityToTierName(complexity: number): ProviderTier["name"] {
  if (complexity < 0.25) return "free";
  if (complexity < 0.5) return "cheap";
  if (complexity < 0.75) return "mid";
  return "premium";
}

// ─── EconomyRouter ────────────────────────────────────────────────────────────

export class EconomyRouter {
  private readonly _tiers: Map<ProviderTier["name"], ProviderTier>;
  private readonly _opts: EconomyRouterOpts;
  private readonly _hourlyWindowMs: number;
  private readonly _monthlyWindowMs: number;
  private readonly _now: () => number;
  private readonly _history: CostEntry[] = [];
  private _circuitOpen = false;
  private _circuitOpenedAt: number | undefined;
  /** Cooldown before circuit can auto-reset. 5 minutes. */
  private static readonly COOLDOWN_MS = 300_000;

  constructor(opts: EconomyRouterOpts) {
    this._opts = opts;
    this._tiers = new Map(opts.tiers.map((t) => [t.name, t]));
    this._hourlyWindowMs = opts.windowMs ?? 3_600_000;
    this._monthlyWindowMs = opts.monthlyWindowMs ?? 30 * 24 * 3_600_000;
    this._now = opts._now ?? (() => Date.now());
  }

  /**
   * Select the most appropriate tier for a given complexity (0-1 scale).
   * Falls back to defaultTier if the mapped tier is not in the catalog.
   */
  selectTier(complexity: number, _agentId?: string): ProviderTier {
    const preferred = complexityToTierName(complexity);
    return this._tiers.get(preferred) ?? this._defaultTier();
  }

  /**
   * Record a completed cycle's cost. Publishes cc.cost.recorded if an
   * EventBusPort is provided.
   */
  recordCycle(agentId: string, costUsd: number, tokens: { input: number; output: number }): void {
    const now = this._now();
    this._history.push({
      agentId,
      costUsd,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      ts: now,
    });

    // Check circuit breaker
    if (!this._circuitOpen) {
      if (this.hourlySpend() > this._opts.hourlyBudgetUsd) {
        this._circuitOpen = true;
        this._circuitOpenedAt = now;
        const reason = `hourly budget exceeded: ${this.hourlySpend().toFixed(
          4,
        )} USD > ${this._opts.hourlyBudgetUsd} USD`;
        this._opts.onCircuitBreak?.(reason);
      }
    }

    // Publish event if EventBusPort provided
    if (this._opts.eventBus !== undefined) {
      const tenantId = this._opts._tenantId;
      void this._opts.eventBus.publish(
        {
          id: `cc-cost-${now}-${agentId}`,
          specversion: "1.0",
          source: "cc",
          type: "cc.cost.recorded",
          time: new Date(now).toISOString(),
          datacontenttype: "application/json",
          data: {
            agentId,
            costUsd,
            tokens,
            ...(tenantId !== undefined ? { tenantId } : {}),
          },
        },
        "cc.cost",
      );
    }
  }

  /**
   * Total cost in the rolling hourly window.
   */
  hourlySpend(): number {
    const cutoff = this._now() - this._hourlyWindowMs;
    return this._history.filter((e) => e.ts >= cutoff).reduce((sum, e) => sum + e.costUsd, 0);
  }

  /**
   * Total cost in the rolling monthly window.
   */
  monthlySpend(): number {
    const cutoff = this._now() - this._monthlyWindowMs;
    return this._history.filter((e) => e.ts >= cutoff).reduce((sum, e) => sum + e.costUsd, 0);
  }

  /**
   * Check whether a new cycle may proceed given estimated cost.
   *
   * Returns `{ ok: false, reason }` if:
   *   - Circuit breaker is open
   *   - Estimated cost would push hourly spend over budget
   *   - Estimated cost would push monthly spend over budget
   */
  canProceed(estimatedCostUsd: number): { ok: true } | { ok: false; reason: string } {
    // Auto-reset circuit breaker after cooldown
    if (this._circuitOpen && this._circuitOpenedAt !== undefined) {
      if (this._now() - this._circuitOpenedAt >= EconomyRouter.COOLDOWN_MS) {
        this._circuitOpen = false;
        this._circuitOpenedAt = undefined;
      }
    }

    if (this._circuitOpen) {
      return { ok: false, reason: "circuit-breaker-open" };
    }

    const projectedHourly = this.hourlySpend() + estimatedCostUsd;
    if (projectedHourly > this._opts.hourlyBudgetUsd) {
      return {
        ok: false,
        reason: `hourly budget would be exceeded: ${projectedHourly.toFixed(
          4,
        )} > ${this._opts.hourlyBudgetUsd} USD`,
      };
    }

    const projectedMonthly = this.monthlySpend() + estimatedCostUsd;
    if (projectedMonthly > this._opts.monthlyBudgetUsd) {
      return {
        ok: false,
        reason: `monthly budget would be exceeded: ${projectedMonthly.toFixed(
          4,
        )} > ${this._opts.monthlyBudgetUsd} USD`,
      };
    }

    return { ok: true };
  }

  /**
   * Create a scoped router for a specific tenant.
   *
   * The scoped router shares the same tier catalog and configuration
   * but maintains isolated spend history and circuit breaker state.
   */
  forTenant(tenantId: string): EconomyRouter {
    return new EconomyRouter({
      ...this._opts,
      _tenantId: tenantId,
      // Reset history and circuit state for the new tenant scope
      _now: this._now,
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _defaultTier(): ProviderTier {
    const t = this._tiers.get(this._opts.defaultTier);
    if (t !== undefined) return t;
    // Absolute fallback: first tier in catalog
    const first = this._opts.tiers[0];
    if (first !== undefined) return first;
    throw new Error("EconomyRouter: no tiers configured");
  }
}
