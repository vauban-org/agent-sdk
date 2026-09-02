/**
 * economy/outcome-tracker — Per-cycle cost accounting, in-memory store.
 *
 * Closes the "agent_run.cost_usd always zero" gap (Sprint 0 v1).
 *
 * Design principles:
 *   • No DB dependency — substrate is product-agnostic.
 *   • Host wires DB persistence via OutcomeHook.
 *   • Cost computed from TierPolicy pricing; unknown models default to 0.
 */

import type { TierPolicy } from "./tier-policy.js";
import { lookupTier } from "./tier-policy.js";

// ─── Public types ─────────────────────────────────────────────────────────

/** @public */
export interface OutcomeHook {
  /**
   * Called by OutcomeTracker when flush() is invoked for a run.
   * Consumer is responsible for DB persistence or downstream dispatch.
   */
  onCycleEnd(runId: string, cost: CycleCost): Promise<void>;
}

/** @public */
export interface CycleCost {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  /** Computed from TierPolicy pricing. 0 when model pricing is unknown. */
  costUsd: number;
  /** Label of the ModelTier used (e.g. "free", "cheap", "mid", "premium"). */
  modelTier: string;
  durationMs: number;
  /** Sprint C: skill that ran (if known). */
  skillId?: string;
  /** Sprint C: consumer-supplied outcome delta (business value). */
  outcomeValue?: number;
  /** Sprint D: task category for economy router lookups (e.g. "simple"|"standard"|"complex"|"reasoning"). */
  category?: string;
}

// ─── OutcomeTracker ───────────────────────────────────────────────────────

/**
 * OutcomeTracker records token usage per cycle and computes cost_usd
 * from the injected TierPolicy.
 *
 * Usage:
 *   const tracker = new OutcomeTracker(policy, hook);
 *   const cost = tracker.record(runId, "litellm/default-fast", 1200, 300, 1800);
 *   await tracker.flush(runId);
 * @public
 */
export class OutcomeTracker {
  private readonly _policy: TierPolicy;
  private readonly _hook: OutcomeHook | undefined;
  /** In-memory store: runId → list of CycleCost records. */
  private readonly _store: Map<string, CycleCost[]> = new Map();

  constructor(policy: TierPolicy, hook?: OutcomeHook) {
    this._policy = policy;
    this._hook = hook;
  }

  /**
   * Record tokens used by one cycle.
   *
   * @param runId        - Unique run identifier.
   * @param model        - "provider/model" string, e.g. "litellm/default-fast" or "groq/llama-3.3-70b-versatile".
   * @param inputTokens  - Number of input tokens consumed.
   * @param outputTokens - Number of output tokens produced.
   * @param durationMs   - Wall-clock duration of the cycle.
   * @param opts         - Optional: skillId for Sprint C skill attribution.
   */
  record(
    runId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    opts?: { skillId?: string; outcomeValue?: number; category?: string },
  ): CycleCost {
    const { provider, modelName } = parseModel(model);
    const tier = lookupTier(provider, modelName);

    const costUsd =
      tier !== undefined
        ? (inputTokens / 1_000_000) * tier.costPerMTokenIn +
          (outputTokens / 1_000_000) * tier.costPerMTokenOut
        : 0;

    // Also try via policy catalog for consumer-injected tiers.
    // We use the "standard" category degraded mode to get a list, then check
    // if any matches — this is a fallback for consumer tiers not in built-in catalog.
    let tierLabel = tier?.label ?? "unknown";
    if (tier === undefined) {
      const candidates = this._policy.tiersFor("standard", "degraded");
      const match = candidates.find((t) => t.provider === provider && t.model === modelName);
      if (match !== undefined) {
        tierLabel = match.label;
        const matchedCost =
          (inputTokens / 1_000_000) * match.costPerMTokenIn +
          (outputTokens / 1_000_000) * match.costPerMTokenOut;
        const cycleCost: CycleCost = {
          runId,
          inputTokens,
          outputTokens,
          costUsd: matchedCost,
          modelTier: tierLabel,
          durationMs,
          ...(opts?.skillId !== undefined ? { skillId: opts.skillId } : {}),
          ...(opts?.outcomeValue !== undefined ? { outcomeValue: opts.outcomeValue } : {}),
          ...(opts?.category !== undefined ? { category: opts.category } : {}),
        };
        this._push(runId, cycleCost);
        return cycleCost;
      }
    }

    const cycleCost: CycleCost = {
      runId,
      inputTokens,
      outputTokens,
      costUsd,
      modelTier: tierLabel,
      durationMs,
      ...(opts?.skillId !== undefined ? { skillId: opts.skillId } : {}),
      ...(opts?.outcomeValue !== undefined ? { outcomeValue: opts.outcomeValue } : {}),
      ...(opts?.category !== undefined ? { category: opts.category } : {}),
    };

    this._push(runId, cycleCost);
    return cycleCost;
  }

  /**
   * Flush all recorded cycles for a runId to the consumer hook.
   * Noop if no hook is configured or no records exist for the runId.
   */
  async flush(runId: string): Promise<void> {
    if (this._hook === undefined) return;
    const records = this._store.get(runId);
    if (records === undefined || records.length === 0) return;
    for (const cost of records) {
      await this._hook.onCycleEnd(runId, cost);
    }
  }

  /**
   * Get all recorded costs, optionally filtered to a trailing time window.
   *
   * @param windowMs - If provided, only return records within the last windowMs milliseconds.
   *                   The tracker uses the current time as the reference point and
   *                   estimates record time by insertion order (no timestamp stored per record).
   *                   For window filtering, use totalCostInWindow() which is time-aware.
   */
  getCosts(windowMs?: number): CycleCost[] {
    const all: CycleCost[] = [];
    for (const records of this._store.values()) {
      all.push(...records);
    }
    if (windowMs === undefined) return all;
    // Without per-record timestamps, return all (host should use totalCostInWindow).
    return all;
  }

  /**
   * Running total cost (USD) across all recorded cycles within the time window.
   * Default window: last 1 hour (3_600_000 ms).
   *
   * Uses an internal timestamped wrapper to implement accurate windowing.
   */
  totalCostInWindow(windowMs = 3_600_000): number {
    const cutoff = Date.now() - windowMs;
    let total = 0;
    for (const records of this._timestamped.values()) {
      for (const r of records) {
        if (r.ts >= cutoff) {
          total += r.cost.costUsd;
        }
      }
    }
    return total;
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  /** Timestamped record store for window queries. */
  private readonly _timestamped: Map<string, Array<{ ts: number; cost: CycleCost }>> = new Map();

  private _push(runId: string, cost: CycleCost): void {
    // Plain store
    const list = this._store.get(runId) ?? [];
    list.push(cost);
    this._store.set(runId, list);

    // Timestamped store
    const tsList = this._timestamped.get(runId) ?? [];
    tsList.push({ ts: Date.now(), cost });
    this._timestamped.set(runId, tsList);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Parse "provider/model" string.
 * If no "/" is present, treats the whole string as the model name with an
 * empty provider (will not match any built-in tier).
 */
function parseModel(model: string): { provider: string; modelName: string } {
  const idx = model.indexOf("/");
  if (idx === -1) {
    return { provider: "", modelName: model };
  }
  return {
    provider: model.slice(0, idx),
    modelName: model.slice(idx + 1),
  };
}
