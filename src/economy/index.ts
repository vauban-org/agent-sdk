/**
 * economy — Model tier policy + outcome cost tracking.
 *
 * Public exports for the economy sub-module.
 */

export type { ModelTier, TierPolicy } from "./tier-policy.js";
export { DefaultTierPolicy, lookupTier } from "./tier-policy.js";

export type { OutcomeHook, CycleCost } from "./outcome-tracker.js";
export { OutcomeTracker } from "./outcome-tracker.js";

export type {
  EconomyMode,
  EconomyRouterConfig,
  RouteDecision,
} from "./router.js";
export { EconomyRouter } from "./router.js";

export type { CircuitBreakerConfig } from "./circuit-breaker.js";
export { FleetCircuitBreaker } from "./circuit-breaker.js";

export type {
  ProviderTier,
  EconomyRouterOpts,
  CostEntry,
} from "./economy-router.js";
export { EconomyRouter as SimpleEconomyRouter } from "./economy-router.js";

export type {
  CostRecord,
  CostAccountingSnapshot,
  CostAccountingPort,
  CostAccountingOptions,
} from "./cost-accounting-port.js";
export { createCostAccountingPort } from "./cost-accounting-port.js";
