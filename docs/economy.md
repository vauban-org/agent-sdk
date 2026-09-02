---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# EconomyRouter

**Module:** `@vauban-org/agent-sdk` · **Since:** sprint-584 Sprint D (economy module)

## Purpose

`EconomyRouter` provides data-driven tier selection, spend tracking, and circuit-breaking for agent LLM costs. It maps a complexity score (0–1) to a provider tier, records each cycle's cost, and opens a circuit breaker when hourly or monthly budgets are exceeded.

Budget: `$0/mo` is achievable when using Groq free tier + LiteLLM on-prem as fallback.

---

## Tier catalog

```typescript
import type { ProviderTier } from "@vauban-org/agent-sdk";

type ProviderTier = {
  name: "free" | "cheap" | "mid" | "premium";
  costPerInputToken: number;   // USD per token
  costPerOutputToken: number;  // USD per token
  qualityScore: number;        // 0-1
};
```

Complexity → tier mapping:

| Complexity | Tier |
|-----------|------|
| 0.00–0.25 | free |
| 0.25–0.50 | cheap |
| 0.50–0.75 | mid |
| 0.75–1.00 | premium |

---

## Basic setup

```typescript
import { EconomyRouter } from "@vauban-org/agent-sdk";
import type { EconomyRouterOpts, ProviderTier } from "@vauban-org/agent-sdk";

const FREE_TIER: ProviderTier = {
  name: "free",
  costPerInputToken: 0,
  costPerOutputToken: 0,
  qualityScore: 0.7,
};

const MID_TIER: ProviderTier = {
  name: "mid",
  costPerInputToken: 0.5 / 1_000_000,
  costPerOutputToken: 1.5 / 1_000_000,
  qualityScore: 0.88,
};

const router = new EconomyRouter({
  tiers: [FREE_TIER, MID_TIER],
  hourlyBudgetUsd: 0.10,
  monthlyBudgetUsd: 3.00,
  defaultTier: "free",
  onCircuitBreak: (reason) => console.error("[EconomyRouter] Circuit open:", reason),
} satisfies EconomyRouterOpts);
```

---

## Selecting a tier

```typescript
const tier = router.selectTier(0.6);   // → mid tier
const tier2 = router.selectTier(0.1);  // → free tier

console.log(tier.name);                // "mid"
```

---

## Recording cycle cost

```typescript
router.recordCycle("treasury-agent", 0.0014, { input: 500, output: 200 });
```

If `eventBus` is configured, this publishes a `cc.cost.recorded` CloudEvent to the `cc.cost` stream automatically.

---

## Budget guard before a cycle

```typescript
const estimatedCost = 0.05;
const check = router.canProceed(estimatedCost);

if (!check.ok) {
  console.warn("Skipping cycle:", check.reason);
  // check.reason examples:
  // "circuit-breaker-open"
  // "hourly budget would be exceeded: 0.1200 > 0.1000 USD"
  // "monthly budget would be exceeded: ..."
} else {
  // proceed with the cycle
}
```

Circuit breaker auto-resets after a 5-minute cooldown.

---

## Multi-tenant isolation

```typescript
const tenantRouter = router.forTenant("acme-corp");
// Independent spend history and circuit breaker for this tenant
// Shares the same tier catalog and hourlyBudgetUsd configuration
```

---

## EventBus integration

```typescript
import { EconomyRouter } from "@vauban-org/agent-sdk";

const router = new EconomyRouter({
  // ... tiers and budgets
  eventBus: myEventBusImplementation,  // publishes cc.cost.recorded
});
```

The event payload: `{ agentId, costUsd, tokens: { input, output }, tenantId? }`.

---

## Full Economy module exports

```typescript
import {
  EconomyRouter,
  DefaultTierPolicy,
  lookupTier,
  OutcomeTracker,
  FleetCircuitBreaker,
} from "@vauban-org/agent-sdk";

import type {
  EconomyRouterOpts,
  ProviderTier,
  CostEntry,
  ModelTier,
  TierPolicy,
  OutcomeHook,
  CycleCost,
  EconomyMode,
  EconomyRouterConfig,
  RouteDecision,
  CircuitBreakerConfig,
} from "@vauban-org/agent-sdk";
```
