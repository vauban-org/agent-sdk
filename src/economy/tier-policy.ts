/**
 * economy/tier-policy — Model tier catalog and routing policy.
 *
 * Substrate-pure: no consumer-specific names anywhere.
 * Consumers inject a custom TierPolicy implementation to override defaults.
 * @public
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface ModelTier {
  /** Provider identifier: "litellm" | "groq" | "anthropic" | etc. */
  provider: string;
  /** Model alias as configured in the provider. e.g. "default-fast", "deepseek-v4-flash". */
  model: string;
  /** USD per 1M input tokens. 0 when unknown or local (free). */
  costPerMTokenIn: number;
  /** USD per 1M output tokens. */
  costPerMTokenOut: number;
  label: "free" | "cheap" | "mid" | "premium";
}

/** @public */
export interface TierPolicy {
  /**
   * Return an ordered list of tiers to try for a given task category.
   * First element = preferred tier.
   *
   * @param category - Task category: "simple" | "standard" | "complex" | "reasoning" | string
   * @param mode     - "degraded" uses cost-minimising static routing;
   *                   "full" allows observed cost-per-outcome to influence order.
   */
  tiersFor(category: string, mode: "degraded" | "full"): ModelTier[];
}

// ─── Built-in tier catalog ────────────────────────────────────────────────

/** Tier 0 — local Qwen3-8B via LiteLLM proxy. Free. */
const TIER_FREE: ModelTier = {
  provider: "litellm",
  model: "default-fast",
  costPerMTokenIn: 0,
  costPerMTokenOut: 0,
  label: "free",
};

/** Tier 1 — DeepSeek Flash via LiteLLM proxy. Low cost. */
const TIER_CHEAP: ModelTier = {
  provider: "litellm",
  model: "deepseek-v4-flash",
  costPerMTokenIn: 0.14,
  costPerMTokenOut: 0.28,
  label: "cheap",
};

/** Tier 2 — Groq free tier (llama-3.3-70b-versatile). Mid quality, near-zero cost. */
const TIER_MID: ModelTier = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  costPerMTokenIn: 0.0,
  costPerMTokenOut: 0.0,
  label: "mid",
};

/** Tier 3 — DeepSeek Pro via LiteLLM proxy. Premium. */
const TIER_PREMIUM: ModelTier = {
  provider: "litellm",
  model: "deepseek-v4-pro",
  costPerMTokenIn: 0.27,
  costPerMTokenOut: 1.1,
  label: "premium",
};

// ─── Static category → tier index mapping ─────────────────────────────────

const DEGRADED_ROUTING: Record<string, ModelTier[]> = {
  simple: [TIER_FREE, TIER_CHEAP],
  standard: [TIER_CHEAP, TIER_MID],
  complex: [TIER_MID, TIER_PREMIUM],
  reasoning: [TIER_PREMIUM],
};

const DEFAULT_DEGRADED: ModelTier[] = [TIER_CHEAP, TIER_MID];

// ─── DefaultTierPolicy ────────────────────────────────────────────────────

/**
 * DefaultTierPolicy — static cost-minimising routing.
 *
 * "degraded" mode: purely static, category → ordered tier list.
 * "full" mode: same tiers returned in same order; the *caller* (economy router)
 *   is responsible for re-ordering by observed cost-per-outcome from OutcomeTracker.
 *   This class only supplies the candidate set.
 * @public
 */
export class DefaultTierPolicy implements TierPolicy {
  tiersFor(category: string, _mode: "degraded" | "full"): ModelTier[] {
    // Both modes return the same candidate set; re-ordering in "full" mode
    // is the router's responsibility (Sprint D router.ts, not this class).
    const tiers = DEGRADED_ROUTING[category] ?? DEFAULT_DEGRADED;
    // Return a copy to prevent external mutation of the catalog.
    return [...tiers];
  }
}

// ─── Catalog helpers ──────────────────────────────────────────────────────

/**
 * Look up a ModelTier by provider+model from the built-in catalog.
 * Returns undefined if the model is not in the default catalog
 * (consumers may use custom tiers not registered here).
 * @public
 */
export function lookupTier(provider: string, model: string): ModelTier | undefined {
  const catalog: ModelTier[] = [TIER_FREE, TIER_CHEAP, TIER_MID, TIER_PREMIUM];
  return catalog.find((t) => t.provider === provider && t.model === model);
}
