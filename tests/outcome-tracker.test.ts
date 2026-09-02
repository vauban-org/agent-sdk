import { describe, expect, it, vi } from "vitest";
import { OutcomeTracker } from "../src/economy/outcome-tracker.js";
import type { CycleCost, OutcomeHook } from "../src/economy/outcome-tracker.js";
import { DefaultTierPolicy } from "../src/economy/tier-policy.js";

const policy = new DefaultTierPolicy();

// ─── Cost computation ─────────────────────────────────────────────────────

describe("OutcomeTracker.record() — cost computation", () => {
  it("computes cost=0 for free local model", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("run-1", "litellm/default-fast", 10_000, 2_000, 500);
    expect(cost.costUsd).toBe(0);
    expect(cost.modelTier).toBe("free");
  });

  it("computes correct cost for cheap model (deepseek-v4-flash)", () => {
    const tracker = new OutcomeTracker(policy);
    // 1M input @ 0.14, 1M output @ 0.28
    // 500k input → 0.07, 100k output → 0.028 → total 0.098
    const cost = tracker.record("run-2", "litellm/deepseek-v4-flash", 500_000, 100_000, 1200);
    expect(cost.costUsd).toBeCloseTo(0.098, 6);
    expect(cost.modelTier).toBe("cheap");
  });

  it("computes correct cost for premium model (deepseek-v4-pro)", () => {
    const tracker = new OutcomeTracker(policy);
    // 200k input @ 0.27/M = 0.054, 50k output @ 1.1/M = 0.055 → total 0.109
    const cost = tracker.record("run-3", "litellm/deepseek-v4-pro", 200_000, 50_000, 3000);
    expect(cost.costUsd).toBeCloseTo(0.109, 6);
    expect(cost.modelTier).toBe("premium");
  });

  it("defaults to costUsd=0 for unknown model", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("run-4", "unknown-provider/unknown-model", 1000, 500, 200);
    expect(cost.costUsd).toBe(0);
    expect(cost.modelTier).toBe("unknown");
  });

  it("propagates durationMs correctly", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("run-5", "groq/llama-3.3-70b-versatile", 100, 50, 4567);
    expect(cost.durationMs).toBe(4567);
  });

  it("propagates runId correctly", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("my-run-id", "litellm/default-fast", 1, 1, 1);
    expect(cost.runId).toBe("my-run-id");
  });
});

// ─── skillId propagation ──────────────────────────────────────────────────

describe("OutcomeTracker.record() — skillId propagation", () => {
  it("includes skillId when provided", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("run-sk", "litellm/default-fast", 100, 50, 200, {
      skillId: "skill-web-search",
    });
    expect(cost.skillId).toBe("skill-web-search");
  });

  it("omits skillId when not provided", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("run-nsk", "litellm/default-fast", 100, 50, 200);
    expect(cost.skillId).toBeUndefined();
  });

  it("includes outcomeValue when provided", () => {
    const tracker = new OutcomeTracker(policy);
    const cost = tracker.record("run-ov", "litellm/default-fast", 100, 50, 200, {
      outcomeValue: 42.5,
    });
    expect(cost.outcomeValue).toBe(42.5);
  });
});

// ─── flush() ─────────────────────────────────────────────────────────────

describe("OutcomeTracker.flush()", () => {
  it("calls hook.onCycleEnd for each recorded cycle of the runId", async () => {
    const received: CycleCost[] = [];
    const hook: OutcomeHook = {
      onCycleEnd: async (_runId, cost) => {
        received.push(cost);
      },
    };

    const tracker = new OutcomeTracker(policy, hook);
    tracker.record("run-flush", "litellm/default-fast", 100, 50, 100);
    tracker.record("run-flush", "litellm/deepseek-v4-flash", 200, 80, 200);
    await tracker.flush("run-flush");

    expect(received).toHaveLength(2);
    expect(received[0]?.runId).toBe("run-flush");
    expect(received[1]?.runId).toBe("run-flush");
  });

  it("does not call hook for a different runId", async () => {
    const received: CycleCost[] = [];
    const hook: OutcomeHook = {
      onCycleEnd: async (_runId, cost) => {
        received.push(cost);
      },
    };

    const tracker = new OutcomeTracker(policy, hook);
    tracker.record("run-A", "litellm/default-fast", 100, 50, 100);
    tracker.record("run-B", "litellm/default-fast", 200, 80, 200);
    await tracker.flush("run-A");

    expect(received).toHaveLength(1);
    expect(received[0]?.runId).toBe("run-A");
  });

  it("is a noop when no hook is configured", async () => {
    const tracker = new OutcomeTracker(policy);
    tracker.record("run-nohook", "litellm/default-fast", 100, 50, 100);
    // Should not throw
    await expect(tracker.flush("run-nohook")).resolves.toBeUndefined();
  });

  it("is a noop when runId has no records", async () => {
    const onCycleEnd = vi.fn();
    const hook: OutcomeHook = { onCycleEnd };
    const tracker = new OutcomeTracker(policy, hook);
    await tracker.flush("nonexistent-run");
    expect(onCycleEnd).not.toHaveBeenCalled();
  });
});

// ─── totalCostInWindow() ─────────────────────────────────────────────────

describe("OutcomeTracker.totalCostInWindow()", () => {
  it("sums cost for all records within default 1h window", () => {
    const tracker = new OutcomeTracker(policy);
    // 2× free model → costUsd=0 each
    tracker.record("run-w1", "litellm/default-fast", 10_000, 2_000, 100);
    // 1× deepseek-v4-flash: 500k in @ 0.14/M = 0.07, 100k out @ 0.28/M = 0.028 → 0.098
    tracker.record("run-w2", "litellm/deepseek-v4-flash", 500_000, 100_000, 200);
    const total = tracker.totalCostInWindow();
    expect(total).toBeCloseTo(0.098, 6);
  });

  it("returns 0 when no records exist", () => {
    const tracker = new OutcomeTracker(policy);
    expect(tracker.totalCostInWindow()).toBe(0);
  });

  it("sums correctly across multiple runs", () => {
    const tracker = new OutcomeTracker(policy);
    // Two cheap records: each 500k in + 100k out → 0.098 each
    tracker.record("run-x1", "litellm/deepseek-v4-flash", 500_000, 100_000, 100);
    tracker.record("run-x2", "litellm/deepseek-v4-flash", 500_000, 100_000, 100);
    expect(tracker.totalCostInWindow()).toBeCloseTo(0.196, 6);
  });

  it("excludes records outside the time window (using a very small window)", async () => {
    const tracker = new OutcomeTracker(policy);
    // Record something with a 1ms window — it was recorded before the cutoff if we wait
    tracker.record("run-y1", "litellm/deepseek-v4-flash", 500_000, 100_000, 100);

    // Wait 5ms then measure with a 1ms window — record should be outside window
    await new Promise((resolve) => setTimeout(resolve, 5));
    const total = tracker.totalCostInWindow(1);
    expect(total).toBe(0);
  });
});
