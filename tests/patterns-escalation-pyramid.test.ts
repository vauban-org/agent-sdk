/**
 * Tests for src/patterns/escalation/pyramid.ts
 * Focus: constructor validation, canProceed routing, dry-run, reason strings,
 * override/clearOverride, HITL callback, EscalationDecision shape, Brain logging,
 * custom thresholds, multiple declarations, and edge confidence values.
 */

import { describe, expect, it, vi } from "vitest";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import { createEscalationPyramid } from "../src/patterns/escalation/pyramid.js";
import type { BrainPort } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(opts: Partial<OODAContext> = {}): OODAContext {
  return {
    agentId: "test-agent",
    runId: "run-1",
    executionMode: "live",
    cycle: 1,
    createdAt: new Date(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    ...opts,
  } as unknown as OODAContext;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-pyramid",
    declarations: [
      { actionType: "vault.rebalance", level: "L1_autonomous" as const },
      { actionType: "brain.archive", level: "L2_async_review" as const },
      { actionType: "starknet.sign", level: "L3_hitl_required" as const },
    ],
    brain: undefined,
    ...overrides,
  };
}

function mockBrain(): BrainPort {
  return { archiveKnowledge: vi.fn(async () => null) };
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe("createEscalationPyramid — constructor validation", () => {
  it("throws when l2ConfidenceThreshold >= l1ConfidenceThreshold (equal)", () => {
    expect(() =>
      createEscalationPyramid({
        name: "bad",
        declarations: [],
        l1ConfidenceThreshold: 0.75,
        l2ConfidenceThreshold: 0.75,
        brain: undefined,
      }),
    ).toThrow();
  });

  it("throws when l2ConfidenceThreshold > l1ConfidenceThreshold", () => {
    expect(() =>
      createEscalationPyramid({
        name: "bad",
        declarations: [],
        l1ConfidenceThreshold: 0.6,
        l2ConfidenceThreshold: 0.8,
        brain: undefined,
      }),
    ).toThrow(/l2ConfidenceThreshold.*must be < l1ConfidenceThreshold/);
  });

  it("creates pyramid successfully with valid config", () => {
    const pyramid = createEscalationPyramid(makeConfig());
    expect(pyramid).toBeDefined();
    expect(typeof pyramid.canProceed).toBe("function");
    expect(typeof pyramid.override).toBe("function");
    expect(typeof pyramid.clearOverride).toBe("function");
  });
});

// ─── canProceed routing ───────────────────────────────────────────────────────

describe("createEscalationPyramid — canProceed routing", () => {
  it("L1_autonomous + confidence >= 0.85 → proceed=true, effectiveLevel=L1_autonomous", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
  });

  it("L1_autonomous + confidence < 0.85 → escalated to L2_async_review, proceed=true", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("vault.rebalance", 0.75, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L2_async_review");
  });

  it("L2_async_review + confidence >= 0.60 → proceed=true, effectiveLevel=L2_async_review", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("brain.archive", 0.65, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L2_async_review");
  });

  it("L2_async_review + confidence < 0.60 → escalated to L3_hitl_required, proceed=false", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("brain.archive", 0.45, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });

  it("L3_hitl_required always → proceed=false, effectiveLevel=L3_hitl_required", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("starknet.sign", 0.99, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });

  it("L3_hitl_required at confidence=1.0 still blocks (proceed=false)", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("starknet.sign", 1.0, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });

  it("unknown actionType defaults to L3_hitl_required (fail-safe)", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("undeclared.action", 0.99, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });
});

// ─── Dry-run mode ─────────────────────────────────────────────────────────────

describe("createEscalationPyramid — dry-run mode", () => {
  it("executionMode='dry-run' always yields effectiveLevel=L1_autonomous, proceed=true", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed(
      "vault.rebalance",
      0.0,
      makeCtx({ executionMode: "dry-run" }),
    );
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
  });

  it("dry-run overrides L3_hitl_required to L1_autonomous", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("starknet.sign", 0.1, makeCtx({ executionMode: "dry-run" }));
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
  });

  it("dry-run reason contains 'dry-run'", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("starknet.sign", 0.5, makeCtx({ executionMode: "dry-run" }));
    expect(d.reason).toContain("dry-run");
  });
});

// ─── Reason string ────────────────────────────────────────────────────────────

describe("createEscalationPyramid — reason string", () => {
  it("escalated action → reason contains 'escalated'", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("vault.rebalance", 0.7, makeCtx());
    expect(d.reason).toContain("escalated");
  });

  it("non-escalated action → reason contains the actionType", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    expect(d.reason).toContain("vault.rebalance");
  });

  it("dry-run reason does not contain 'escalated'", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("starknet.sign", 0.1, makeCtx({ executionMode: "dry-run" }));
    expect(d.reason).not.toContain("escalated");
  });
});

// ─── override / clearOverride ─────────────────────────────────────────────────

describe("createEscalationPyramid — override / clearOverride", () => {
  it("setOverride('vault.rebalance', 'L3_hitl_required') blocks a previously-L1 action", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    pyramid.override("vault.rebalance", "L3_hitl_required");
    const d = await pyramid.canProceed("vault.rebalance", 0.99, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });

  it("clearOverride('vault.rebalance') restores original L1_autonomous routing", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    pyramid.override("vault.rebalance", "L3_hitl_required");
    pyramid.clearOverride("vault.rebalance");
    const d = await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
  });

  it("override only applies to the specified actionType, not others", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    pyramid.override("vault.rebalance", "L3_hitl_required");
    const d = await pyramid.canProceed("brain.archive", 0.65, makeCtx());
    // brain.archive is L2_async_review, not affected by override on vault.rebalance
    expect(d.effectiveLevel).toBe("L2_async_review");
  });

  it("clearOverride on an undeclared type restores default L3", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    pyramid.override("undeclared", "L1_autonomous");
    pyramid.clearOverride("undeclared");
    const d = await pyramid.canProceed("undeclared", 1.0, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });
});

// ─── HITL callback ────────────────────────────────────────────────────────────

describe("createEscalationPyramid — HITL callback", () => {
  it("calls onHitlRequired when proceed=false (L3 block)", async () => {
    const onHitlRequired = vi.fn();
    const pyramid = createEscalationPyramid(makeConfig({ onHitlRequired }));
    await pyramid.canProceed("starknet.sign", 0.99, makeCtx());
    expect(onHitlRequired).toHaveBeenCalledOnce();
    expect(onHitlRequired.mock.calls[0]?.[0]).toBe("starknet.sign");
    expect(onHitlRequired.mock.calls[0]?.[1]).toBe(0.99);
  });

  it("does not call onHitlRequired when proceed=true", async () => {
    const onHitlRequired = vi.fn();
    const pyramid = createEscalationPyramid(makeConfig({ onHitlRequired }));
    await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    expect(onHitlRequired).not.toHaveBeenCalled();
  });

  it("HITL callback receives the EscalationDecision object as 3rd argument", async () => {
    const onHitlRequired = vi.fn();
    const pyramid = createEscalationPyramid(makeConfig({ onHitlRequired }));
    await pyramid.canProceed("starknet.sign", 0.5, makeCtx());
    const decision = onHitlRequired.mock.calls[0]?.[2];
    expect(decision).toBeDefined();
    expect(decision.proceed).toBe(false);
    expect(decision.effectiveLevel).toBe("L3_hitl_required");
    expect(typeof decision.reason).toBe("string");
  });
});

// ─── Multiple declarations ────────────────────────────────────────────────────

describe("createEscalationPyramid — multiple declarations", () => {
  it("all declared actionTypes route correctly in a single pyramid", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const l1 = await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    const l2 = await pyramid.canProceed("brain.archive", 0.65, makeCtx());
    const l3 = await pyramid.canProceed("starknet.sign", 0.99, makeCtx());
    expect(l1.effectiveLevel).toBe("L1_autonomous");
    expect(l2.effectiveLevel).toBe("L2_async_review");
    expect(l3.effectiveLevel).toBe("L3_hitl_required");
  });

  it("EscalationDecision always has proceed, effectiveLevel, and reason fields", async () => {
    const pyramid = createEscalationPyramid(makeConfig());
    const d = await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    expect(typeof d.proceed).toBe("boolean");
    expect(typeof d.effectiveLevel).toBe("string");
    expect(typeof d.reason).toBe("string");
  });
});

// ─── Brain logging ────────────────────────────────────────────────────────────

describe("createEscalationPyramid — Brain logging", () => {
  it("calls brain.archiveKnowledge on each canProceed call", async () => {
    const brain = mockBrain();
    const pyramid = createEscalationPyramid(makeConfig({ brain }));
    await pyramid.canProceed("vault.rebalance", 0.9, makeCtx());
    await Promise.resolve();
    expect(brain.archiveKnowledge).toHaveBeenCalledOnce();
  });
});

// ─── Custom thresholds ────────────────────────────────────────────────────────

describe("createEscalationPyramid — custom thresholds", () => {
  it("respects custom l1ConfidenceThreshold: 0.90 < 0.95 → escalates L1 to L2", async () => {
    const pyramid = createEscalationPyramid({
      name: "high-bar",
      declarations: [{ actionType: "action", level: "L1_autonomous" }],
      l1ConfidenceThreshold: 0.95,
      l2ConfidenceThreshold: 0.7,
      brain: undefined,
    });
    const d = await pyramid.canProceed("action", 0.9, makeCtx());
    expect(d.effectiveLevel).toBe("L2_async_review");
  });

  it("respects custom l2ConfidenceThreshold: 0.55 >= 0.50 → stays at L2", async () => {
    const pyramid = createEscalationPyramid({
      name: "low-bar",
      declarations: [{ actionType: "action", level: "L2_async_review" }],
      l1ConfidenceThreshold: 0.9,
      l2ConfidenceThreshold: 0.5,
      brain: undefined,
    });
    const d = await pyramid.canProceed("action", 0.55, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L2_async_review");
  });
});
