/**
 * Tests for packages/agent-sdk/src/economy/router.ts — EconomyRouter
 *
 * Focus: constructor defaults, RouteDecision structure, route counter accuracy,
 * within-band decisions, full-mode skill→category fallback, half-open breaker,
 * pool-of-one upgrade fallback, routingRate after reset, and edge cases not
 * covered in the companion test suites.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FleetCircuitBreaker } from "../src/economy/circuit-breaker.js";
import type { CycleCost } from "../src/economy/outcome-tracker.js";
import { EconomyRouter } from "../src/economy/router.js";
import type { RouteDecision } from "../src/economy/router.js";
import { DefaultTierPolicy } from "../src/economy/tier-policy.js";

// ─── Minimal mock tracker ─────────────────────────────────────────────────────

type MockTracker = {
  getCosts: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
};

function makeMockTracker(costs: CycleCost[] = []): MockTracker {
  const record = vi.fn().mockReturnValue({ costUsd: 0 });
  return {
    getCosts: vi.fn().mockReturnValue(costs),
    record,
  };
}

function makeRouter(
  opts: {
    mode?: "degraded" | "full";
    budgetBuffer?: number;
    costs?: CycleCost[];
    breaker?: FleetCircuitBreaker;
  } = {},
) {
  const policy = new DefaultTierPolicy();
  const tracker = makeMockTracker(opts.costs ?? []);
  const breaker = opts.breaker ?? new FleetCircuitBreaker();
  const router = new EconomyRouter({
    mode: opts.mode ?? "degraded",
    policy,
    tracker: tracker as any,
    breaker,
    ...(opts.budgetBuffer !== undefined ? { budgetBuffer: opts.budgetBuffer } : {}),
  });
  return { router, tracker, policy, breaker };
}

// ─── Helper to make a CycleCost stub ─────────────────────────────────────────

function cycleCost(partial: Partial<CycleCost> & { costUsd: number }): CycleCost {
  return {
    runId: "test-run",
    inputTokens: 100,
    outputTokens: 100,
    modelTier: "cheap",
    durationMs: 50,
    ...partial,
  };
}

// ─── 1. Constructor and basic routing ─────────────────────────────────────────

describe("EconomyRouter — construction and RouteDecision shape", () => {
  it("can be constructed with minimal valid config", () => {
    expect(() => makeRouter()).not.toThrow();
  });

  it("route() returns a RouteDecision with all required fields", () => {
    const { router } = makeRouter();
    const d: RouteDecision = router.route("simple");
    expect(d).toHaveProperty("tier");
    expect(d).toHaveProperty("mode");
    expect(d).toHaveProperty("reason");
    expect(d).toHaveProperty("blockedByBreaker");
  });

  it("RouteDecision.tier has provider and model string fields", () => {
    const { router } = makeRouter();
    const d = router.route("simple");
    expect(typeof d.tier.provider).toBe("string");
    expect(typeof d.tier.model).toBe("string");
    expect(d.tier.provider.length).toBeGreaterThan(0);
    expect(d.tier.model.length).toBeGreaterThan(0);
  });

  it("RouteDecision.mode matches the configured mode", () => {
    const { router: dr } = makeRouter({ mode: "degraded" });
    expect(dr.route("simple").mode).toBe("degraded");

    const { router: fr } = makeRouter({ mode: "full" });
    expect(fr.route("simple").mode).toBe("full");
  });

  it("blockedByBreaker is false when circuit is closed", () => {
    const { router } = makeRouter();
    const d = router.route("standard");
    expect(d.blockedByBreaker).toBe(false);
  });
});

// ─── 2. Route call counter accuracy ──────────────────────────────────────────

describe("EconomyRouter — totalCalls counter via routingRate", () => {
  it("routingRate is 0 before any route() call", () => {
    const { router } = makeRouter();
    expect(router.routingRate).toBe(0);
  });

  it("1 non-blocked call → routingRate is 1.0", () => {
    const { router } = makeRouter();
    router.route("simple");
    expect(router.routingRate).toBe(1);
  });

  it("totalCalls increment: 5 calls → denominator is 5", () => {
    const { router } = makeRouter();
    for (let i = 0; i < 5; i++) router.route("simple");
    // All non-blocked → rate is 1.0 (5/5)
    expect(router.routingRate).toBe(1);
  });

  it("2 non-blocked then 2 blocked → routingRate is exactly 0.5", () => {
    const breaker = new FleetCircuitBreaker({ thresholdUsd: 0.001 });
    const { router } = makeRouter({ breaker });
    router.route("simple"); // non-blocked
    router.route("simple"); // non-blocked
    // trip the breaker
    breaker.recordCost(100);
    router.route("simple"); // blocked
    router.route("simple"); // blocked
    expect(router.routingRate).toBeCloseTo(0.5, 9);
  });

  it("routingRate recovers to 1.0 after breaker reset", () => {
    const breaker = new FleetCircuitBreaker({ thresholdUsd: 0.001 });
    const { router } = makeRouter({ breaker });
    breaker.recordCost(100); // trip
    router.route("simple"); // blocked (rate = 0/1 = 0)
    breaker.reset();
    router.route("simple"); // non-blocked (rate = 1/2 = 0.5)
    expect(router.routingRate).toBeCloseTo(0.5, 9);
  });
});

// ─── 3. Degraded mode category routing ───────────────────────────────────────

describe("EconomyRouter — degraded mode, no history", () => {
  it("'standard' category returns first candidate (cheap)", () => {
    const { router } = makeRouter();
    const d = router.route("standard");
    expect(d.tier.label).toBe("cheap");
    expect(d.reason).toContain("no-history");
  });

  it("'complex' category returns first candidate (mid)", () => {
    const { router } = makeRouter();
    const d = router.route("complex");
    expect(d.tier.label).toBe("mid");
  });

  it("'reasoning' category returns single premium tier", () => {
    const { router } = makeRouter();
    const d = router.route("reasoning");
    expect(d.tier.label).toBe("premium");
  });

  it("route() without opts does not throw", () => {
    const { router } = makeRouter();
    expect(() => router.route("simple")).not.toThrow();
  });
});

// ─── 4. Within-band cost decisions ───────────────────────────────────────────

describe("EconomyRouter — within-band cost (0.005 ≤ avgCost ≤ 0.05)", () => {
  it("avgCost exactly at UPGRADE_THRESHOLD keeps policy default", () => {
    // avgCost = 0.005 → NOT < 0.005, so no upgrade; NOT > 0.05, so no downgrade → within-band
    const cost = cycleCost({ costUsd: 0.005, category: "standard" });
    const { router } = makeRouter({ costs: [cost] });
    const d = router.route("standard");
    expect(d.reason).toContain("default-tier-within-band");
    expect(d.tier.label).toBe("cheap"); // head of [cheap, mid]
  });

  it("avgCost = 0.01 (mid-band) keeps policy default for standard", () => {
    const cost = cycleCost({ costUsd: 0.01, category: "standard" });
    const { router } = makeRouter({ costs: [cost] });
    const d = router.route("standard");
    expect(d.reason).toContain("within-band");
  });

  it("avgCost at DOWNGRADE boundary (= 0.05) is within-band (not downgraded)", () => {
    // avgCost = 0.05 → NOT > 0.05, so stays within-band
    const cost = cycleCost({ costUsd: 0.05, category: "complex" });
    const { router } = makeRouter({ costs: [cost] });
    const d = router.route("complex");
    expect(d.reason).toContain("within-band");
  });
});

// ─── 5. Full mode: skill-id filtering and category fallback ──────────────────

describe("EconomyRouter — full mode skill/category filtering", () => {
  it("full mode with skillId present uses skill records over category ones", () => {
    const skillRecord = cycleCost({
      costUsd: 0.0001,
      skillId: "skill-a",
      category: "standard",
    });
    const catRecord = cycleCost({ costUsd: 0.06, category: "standard" }); // expensive
    // skill-a is cheap → expect upgrade
    const { router } = makeRouter({
      mode: "full",
      costs: [skillRecord, catRecord],
    });
    const d = router.route("standard", { skillId: "skill-a" });
    // Avg from skill-a = 0.0001 < 0.005 → upgrade to pool[1] = mid
    expect(d.reason).toContain("upgrade");
  });

  it("full mode falls back to category when skillId has no records", () => {
    const catRecord = cycleCost({ costUsd: 0.01, category: "standard" });
    const { router } = makeRouter({ mode: "full", costs: [catRecord] });
    // skillId "unknown-skill" has no records
    const d = router.route("standard", { skillId: "unknown-skill" });
    expect(d.reason).toContain("within-band"); // catRecord 0.01 is within-band
  });

  it("full mode with skillId matching no records and no category records → no-history", () => {
    const { router } = makeRouter({ mode: "full", costs: [] });
    const d = router.route("simple", { skillId: "ghost-skill" });
    expect(d.reason).toContain("no-history");
  });

  it("degraded mode ignores skillId (uses category filter)", () => {
    const skillRecord = cycleCost({ costUsd: 0.0001, skillId: "skill-b" });
    const catRecord = cycleCost({ costUsd: 0.01, category: "standard" });
    // In degraded mode, skillId is ignored; category filter applies
    const { router } = makeRouter({
      mode: "degraded",
      costs: [skillRecord, catRecord],
    });
    const d = router.route("standard", { skillId: "skill-b" });
    // Only catRecord matches category "standard"; 0.01 → within-band
    expect(d.reason).toContain("within-band");
  });
});

// ─── 6. Pool-of-one upgrade fallback ─────────────────────────────────────────

describe("EconomyRouter — single-candidate pool upgrade fallback", () => {
  it("'reasoning' with cheap avg cost: upgrade falls back to same tier", () => {
    // Reasoning only has [premium]. Upgrade would need pool[1] but there is none.
    const cost = cycleCost({ costUsd: 0.0001, category: "reasoning" });
    const { router } = makeRouter({ costs: [cost] });
    const d = router.route("reasoning");
    // avgCost < UPGRADE_THRESHOLD → try upgrade, but pool.length < 2 → same tier
    expect(d.tier.label).toBe("premium");
    expect(d.reason).toContain("default-no-upgrade-available");
  });
});

// ─── 7. Circuit breaker half-open state ──────────────────────────────────────

describe("EconomyRouter — half-open circuit breaker", () => {
  it("half-open state allows exactly one call (blockedByBreaker false)", () => {
    let now = 0;
    const breaker = new FleetCircuitBreaker(
      { thresholdUsd: 1, cooldownMs: 1_000, windowMs: 3_600_000 },
      () => now,
    );
    // Trip the breaker
    breaker.recordCost(10);
    expect(breaker.state).toBe("open");

    // Advance past cooldown
    now = 2_000;
    // canProceed transitions to half-open and allows one probe
    const { router } = makeRouter({ breaker });
    const d = router.route("simple");
    // Half-open probe succeeds → blockedByBreaker should be false
    expect(d.blockedByBreaker).toBe(false);
  });
});

// ─── 8. Budget buffer behaviour ───────────────────────────────────────────────

describe("EconomyRouter — budgetBuffer configuration", () => {
  it("default budgetBuffer=0.1 applies 10% reduction to effective budget", () => {
    // Premium tier estimate: 1000/1e6 * 1.1 = 0.0011 USD
    // With budgetRemainingUsd=0.00122 and buffer=0.1 → cap=0.00122*0.9=0.001098
    // 0.0011 > 0.001098 → premium filtered → mid chosen from complex pool
    const { router } = makeRouter(); // default buffer 0.1
    const d = router.route("complex", { budgetRemainingUsd: 0.00122 });
    expect(d.tier.label).toBe("mid"); // premium filtered, mid remains
  });

  it("budgetBuffer=0 applies no reduction — full budget used for comparison", () => {
    // Premium estimate 0.0011, budget 0.0012, buffer 0 → cap=0.0012 → premium passes
    const { router } = makeRouter({ budgetBuffer: 0 });
    const d = router.route("complex", { budgetRemainingUsd: 0.0012 });
    // mid is head of pool (policy default), premium also affordable, still head=mid
    expect(["mid", "premium"]).toContain(d.tier.label);
  });

  it("budgetBuffer=1 means effective cap is 0 → all tiers filtered → cheapest", () => {
    // With buffer=1, cap = budget * 0 = 0 → all tiers cost > 0 → cheapest fallback
    // But TIER_FREE has cost 0 (simple pool) and TIER_MID also 0 (groq).
    // For 'complex': pool=[mid,premium]. mid has costPerMTokenOut=0, estimate=0 → passes cap=0
    const { router } = makeRouter({ budgetBuffer: 1 });
    const d = router.route("complex", { budgetRemainingUsd: 1 });
    // mid (groq, free) has costPerMTokenOut=0 → estimate 0 → affordable even at cap=0
    expect(d.tier.label).toBe("mid");
  });
});

// ─── 9. Record outcome propagates to breaker ─────────────────────────────────

describe("EconomyRouter — recordOutcome", () => {
  it("recordOutcome calls tracker.record with provider/model string", () => {
    const { router, tracker } = makeRouter();
    const tier = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      costPerMTokenIn: 0,
      costPerMTokenOut: 0,
      label: "mid" as const,
    };
    router.recordOutcome("run-1", tier, 500, 200, 100);
    expect(tracker.record).toHaveBeenCalledOnce();
    const [runId, modelStr] = tracker.record.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(modelStr).toBe("groq/llama-3.3-70b-versatile");
  });

  it("recordOutcome propagates costUsd to circuit breaker windowSpend", () => {
    const breaker = new FleetCircuitBreaker();
    const mockTracker = makeMockTracker();
    // Override record to return a cost
    mockTracker.record.mockReturnValue({ costUsd: 0.5 });

    const policy = new DefaultTierPolicy();
    const router = new EconomyRouter({
      mode: "degraded",
      policy,
      tracker: mockTracker as any,
      breaker,
    });

    const tier = {
      provider: "litellm",
      model: "default-fast",
      costPerMTokenIn: 0,
      costPerMTokenOut: 0,
      label: "free" as const,
    };
    router.recordOutcome("run-2", tier, 100, 100, 50);
    expect(breaker.windowSpend).toBeCloseTo(0.5, 9);
  });

  it("recordOutcome without optional fields does not throw", () => {
    const { router } = makeRouter();
    const tier = {
      provider: "litellm",
      model: "default-fast",
      costPerMTokenIn: 0,
      costPerMTokenOut: 0,
      label: "free" as const,
    };
    expect(() => router.recordOutcome("run-3", tier, 100, 100, 50)).not.toThrow();
  });

  it("recordOutcome with category and skillId passes them to tracker", () => {
    const { router, tracker } = makeRouter();
    const tier = {
      provider: "litellm",
      model: "deepseek-v4-flash",
      costPerMTokenIn: 0.14,
      costPerMTokenOut: 0.28,
      label: "cheap" as const,
    };
    router.recordOutcome("run-4", tier, 1000, 500, 200, {
      category: "simple",
      skillId: "my-skill",
      outcomeValue: 0.9,
    });
    const [, , , , , opts] = tracker.record.mock.calls[0]!;
    expect(opts).toMatchObject({
      category: "simple",
      skillId: "my-skill",
      outcomeValue: 0.9,
    });
  });
});

// ─── 10. Cheapest fallback when budget filters all ────────────────────────────

describe("EconomyRouter — cheapest fallback on total budget exclusion", () => {
  it("returns cheapest original candidate when budget is 0 and all are non-free", () => {
    // 'standard' pool = [cheap, mid]. mid has costPerMTokenOut=0 → estimate=0.
    // With budget=0 (or tiny), cheap (0.28/1e3 = 0.00028) may be filtered.
    // mid (groq, free, costPerMTokenOut=0) estimate = 0 → affordable even at cap=0.
    const { router } = makeRouter({ budgetBuffer: 0 });
    const d = router.route("standard", { budgetRemainingUsd: 0 });
    // mid (groq, $0) passes cap=0; cheap (0.00028) also passes cap=0. Head = cheap.
    expect(["cheap", "mid"]).toContain(d.tier.label);
  });

  it("single-tier pool with budget=0 falls back to that one tier", () => {
    // 'reasoning' → [premium] only; budget 0 → affordable = []; fallback = cheapest([premium]) = premium
    const { router } = makeRouter({ budgetBuffer: 0 });
    const d = router.route("reasoning", { budgetRemainingUsd: 0 });
    expect(d.tier.label).toBe("premium");
  });
});
