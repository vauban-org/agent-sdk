/**
 * Tests for economy/economy-router.ts
 *
 * Covers: selectTier, recordCycle, hourlySpend, canProceed, circuitBreak callback,
 * forTenant isolation, EventBusPort integration.
 */

import { describe, expect, it, vi } from "vitest";
import { EconomyRouter } from "../src/economy/economy-router.js";
import type { EconomyRouterOpts, ProviderTier } from "../src/economy/economy-router.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TIER_FREE: ProviderTier = {
  name: "free",
  costPerInputToken: 0,
  costPerOutputToken: 0,
  qualityScore: 0.3,
};
const TIER_CHEAP: ProviderTier = {
  name: "cheap",
  costPerInputToken: 0.00000014,
  costPerOutputToken: 0.00000028,
  qualityScore: 0.5,
};
const TIER_MID: ProviderTier = {
  name: "mid",
  costPerInputToken: 0,
  costPerOutputToken: 0,
  qualityScore: 0.7,
};
const TIER_PREMIUM: ProviderTier = {
  name: "premium",
  costPerInputToken: 0.00000027,
  costPerOutputToken: 0.0000011,
  qualityScore: 0.95,
};

const ALL_TIERS: ProviderTier[] = [TIER_FREE, TIER_CHEAP, TIER_MID, TIER_PREMIUM];

function buildRouter(overrides?: Partial<EconomyRouterOpts>): EconomyRouter {
  return new EconomyRouter({
    tiers: ALL_TIERS,
    hourlyBudgetUsd: 10,
    monthlyBudgetUsd: 100,
    defaultTier: "cheap",
    ...overrides,
  });
}

// ─── selectTier ──────────────────────────────────────────────────────────────

describe("EconomyRouter.selectTier", () => {
  it("complexity 0.1 → free tier", () => {
    const router = buildRouter();
    const tier = router.selectTier(0.1);
    expect(tier.name).toBe("free");
  });

  it("complexity 0.3 → cheap tier", () => {
    const router = buildRouter();
    const tier = router.selectTier(0.3);
    expect(tier.name).toBe("cheap");
  });

  it("complexity 0.6 → mid tier", () => {
    const router = buildRouter();
    const tier = router.selectTier(0.6);
    expect(tier.name).toBe("mid");
  });

  it("complexity 0.9 → premium tier", () => {
    const router = buildRouter();
    const tier = router.selectTier(0.9);
    expect(tier.name).toBe("premium");
  });

  it("agentId param is accepted (reserved for skill attribution)", () => {
    const router = buildRouter();
    expect(() => router.selectTier(0.5, "agent-x")).not.toThrow();
  });

  it("falls back to defaultTier when mapped tier not in catalog", () => {
    // Only premium in catalog — complexity 0.1 maps to "free" which is missing
    const router = new EconomyRouter({
      tiers: [TIER_PREMIUM],
      hourlyBudgetUsd: 10,
      monthlyBudgetUsd: 100,
      defaultTier: "premium",
    });
    const tier = router.selectTier(0.1);
    expect(tier.name).toBe("premium");
  });
});

// ─── recordCycle + hourlySpend ────────────────────────────────────────────────

describe("EconomyRouter.recordCycle + hourlySpend", () => {
  it("hourlySpend is 0 before any cycle recorded", () => {
    const router = buildRouter();
    expect(router.hourlySpend()).toBe(0);
  });

  it("hourlySpend reflects N recorded cycles", () => {
    const router = buildRouter();
    router.recordCycle("agent-a", 0.001, { input: 1000, output: 200 });
    router.recordCycle("agent-a", 0.002, { input: 2000, output: 400 });
    expect(router.hourlySpend()).toBeCloseTo(0.003, 6);
  });

  it("hourlySpend excludes entries outside the window", () => {
    let fakeNow = 0;
    const router = buildRouter({ _now: () => fakeNow, windowMs: 3_600_000 });

    // Record at t=0
    fakeNow = 0;
    router.recordCycle("agent-b", 0.005, { input: 1000, output: 200 });

    // Advance time beyond window
    fakeNow = 3_600_001;
    // This entry is inside the new window
    router.recordCycle("agent-b", 0.002, { input: 500, output: 100 });

    // Only the second entry should be in window
    expect(router.hourlySpend()).toBeCloseTo(0.002, 6);
  });

  it("monthlySpend accumulates across multiple cycles", () => {
    const router = buildRouter();
    for (let i = 0; i < 5; i++) {
      router.recordCycle("agent-c", 0.01, { input: 100, output: 50 });
    }
    expect(router.monthlySpend()).toBeCloseTo(0.05, 6);
  });
});

// ─── canProceed ───────────────────────────────────────────────────────────────

describe("EconomyRouter.canProceed", () => {
  it("returns ok=true when spend is below budget", () => {
    const router = buildRouter({ hourlyBudgetUsd: 10, monthlyBudgetUsd: 100 });
    const result = router.canProceed(0.01);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false when estimated cost would exceed hourly budget", () => {
    const router = buildRouter({ hourlyBudgetUsd: 1, monthlyBudgetUsd: 100 });
    // Already spent 0.9 USD
    router.recordCycle("agent-d", 0.9, { input: 1000, output: 200 });
    const result = router.canProceed(0.2); // 0.9 + 0.2 = 1.1 > 1.0
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/hourly budget/);
    }
  });

  it("returns ok=false when estimated cost would exceed monthly budget", () => {
    const router = buildRouter({ hourlyBudgetUsd: 10, monthlyBudgetUsd: 5 });
    router.recordCycle("agent-e", 4.9, { input: 1000, output: 200 });
    const result = router.canProceed(0.2); // 4.9 + 0.2 = 5.1 > 5.0
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/monthly budget/);
    }
  });
});

// ─── Circuit breaker ─────────────────────────────────────────────────────────

describe("EconomyRouter circuit breaker", () => {
  it("fires onCircuitBreak callback when hourly threshold exceeded", () => {
    const onCircuitBreak = vi.fn();
    const router = buildRouter({ hourlyBudgetUsd: 1, onCircuitBreak });
    // Push spend over $1
    router.recordCycle("agent-f", 1.5, { input: 1000, output: 200 });
    expect(onCircuitBreak).toHaveBeenCalledTimes(1);
    expect(onCircuitBreak.mock.calls[0]![0]).toMatch(/hourly budget exceeded/);
  });

  it("canProceed returns ok=false when circuit is open", () => {
    const router = buildRouter({ hourlyBudgetUsd: 1 });
    router.recordCycle("agent-g", 1.5, { input: 1000, output: 200 });
    // Circuit is now open
    const result = router.canProceed(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("circuit-breaker-open");
    }
  });

  it("circuit auto-resets after cooldown (spend window also expired)", () => {
    let fakeNow = 0;
    // Use a very short window (1s) so spend evicts quickly, separate from cooldown
    const router = buildRouter({
      hourlyBudgetUsd: 1,
      windowMs: 1_000,
      _now: () => fakeNow,
    });
    router.recordCycle("agent-h", 1.5, { input: 1000, output: 200 });

    // Advance past both cooldown (300_000ms) AND the short spend window (1_000ms)
    fakeNow = 300_001;
    const result = router.canProceed(0);
    expect(result.ok).toBe(true);
  });

  it("onCircuitBreak is not called when spend stays below threshold", () => {
    const onCircuitBreak = vi.fn();
    const router = buildRouter({ hourlyBudgetUsd: 10, onCircuitBreak });
    router.recordCycle("agent-i", 0.5, { input: 100, output: 50 });
    expect(onCircuitBreak).not.toHaveBeenCalled();
  });
});

// ─── forTenant isolation ──────────────────────────────────────────────────────

describe("EconomyRouter.forTenant", () => {
  it("forTenant returns a new EconomyRouter instance", () => {
    const router = buildRouter();
    const t1 = router.forTenant("t1");
    expect(t1).toBeInstanceOf(EconomyRouter);
    expect(t1).not.toBe(router);
  });

  it("tenant router is isolated: spend in t1 does not affect t2", () => {
    const root = buildRouter({ hourlyBudgetUsd: 5 });
    const t1 = root.forTenant("t1");
    const t2 = root.forTenant("t2");

    t1.recordCycle("agent-x", 4.5, { input: 1000, output: 200 });

    // t2 should have zero spend regardless of t1
    expect(t2.hourlySpend()).toBe(0);
    const t2Check = t2.canProceed(4.5);
    expect(t2Check.ok).toBe(true);
  });

  it("tenant router is isolated: spend in t2 does not affect t1", () => {
    const root = buildRouter({ hourlyBudgetUsd: 5 });
    const t1 = root.forTenant("t1");
    const t2 = root.forTenant("t2");

    t2.recordCycle("agent-y", 4.5, { input: 1000, output: 200 });

    expect(t1.hourlySpend()).toBe(0);
    expect(t1.canProceed(0.1).ok).toBe(true);
  });

  it("tenant router is isolated from root router", () => {
    const root = buildRouter({ hourlyBudgetUsd: 5 });
    const t1 = root.forTenant("t1");

    t1.recordCycle("agent-z", 4.5, { input: 1000, output: 200 });

    // Root should not be affected by t1 spend
    expect(root.hourlySpend()).toBe(0);
  });

  it("tenant circuit break does not affect other tenants", () => {
    const root = buildRouter({ hourlyBudgetUsd: 2 });
    const t1 = root.forTenant("t1");
    const t2 = root.forTenant("t2");

    // Trip t1's circuit
    t1.recordCycle("agent-w", 3.0, { input: 1000, output: 200 });

    // t2 should still proceed
    const t2Result = t2.canProceed(0.01);
    expect(t2Result.ok).toBe(true);
  });
});

// ─── EventBusPort integration ─────────────────────────────────────────────────

describe("EconomyRouter EventBusPort integration", () => {
  it("publishes cc.cost.recorded event when eventBus is provided", async () => {
    const publishedEvents: unknown[] = [];
    const fakeEventBus = {
      publish: vi.fn(async (event: unknown) => {
        publishedEvents.push(event);
      }),
      publishWithIdempotency: vi.fn(),
      subscribe: vi.fn(),
      subscribeDomain: vi.fn(),
      replayFrom: vi.fn(),
      dlq: vi.fn(),
      pendingCount: vi.fn(),
    };

    const router = buildRouter({ eventBus: fakeEventBus });
    router.recordCycle("agent-pub", 0.001, { input: 100, output: 50 });

    // Give async publish a tick to fire
    await Promise.resolve();

    expect(fakeEventBus.publish).toHaveBeenCalledTimes(1);
    const [event, stream] = fakeEventBus.publish.mock.calls[0]! as [
      { type: string; source: string },
      string,
    ];
    expect(event.type).toBe("cc.cost.recorded");
    expect(event.source).toBe("cc");
    expect(stream).toBe("cc.cost");
  });

  it("does not throw when eventBus is not provided", () => {
    const router = buildRouter({ eventBus: undefined });
    expect(() =>
      router.recordCycle("agent-noevent", 0.001, { input: 100, output: 50 }),
    ).not.toThrow();
  });
});
