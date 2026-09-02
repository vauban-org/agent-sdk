import { describe, expect, it, vi } from "vitest";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import { createEscalationPyramid } from "../src/patterns/escalation/index.js";
import type { EscalationDecision } from "../src/patterns/escalation/index.js";
import type { BrainPort } from "../src/ports/brain.js";

function makeCtx(mode: OODAContext["executionMode"] = "live"): OODAContext {
  return {
    agentId: "a",
    runId: "r",
    cycleIndex: 0,
    executionMode: mode,
    isReplay: false,
    config: {},
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    skills: {},
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    insertStep: async () => ({ stepId: "s" }),
    completeStep: async () => ({ leafHash: "0x" }),
    errorStep: async () => undefined,
    notifySlack: async () => undefined,
  };
}

function mockBrain(): BrainPort {
  return { archiveKnowledge: vi.fn(async () => null) };
}

describe("createEscalationPyramid — construction", () => {
  it("throw si l2 >= l1", () => {
    expect(() =>
      createEscalationPyramid({
        name: "p",
        declarations: [],
        l1ConfidenceThreshold: 0.6,
        l2ConfidenceThreshold: 0.7,
      }),
    ).toThrow(/l2ConfidenceThreshold.*must be < l1ConfidenceThreshold/);
  });
});

describe("createEscalationPyramid — L1_autonomous", () => {
  it("L1 + confidence >= 0.85 → proceed=true, L1", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "read", level: "L1_autonomous" }],
    });
    const d = await p.canProceed("read", 0.9, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
  });
  it("L1 + confidence < 0.85 → escalade L2, proceed=true", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "read", level: "L1_autonomous" }],
    });
    const d = await p.canProceed("read", 0.8, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L2_async_review");
    expect(d.reason).toContain("escalated");
  });
});

describe("createEscalationPyramid — L2_async_review", () => {
  it("L2 + confidence >= 0.60 → proceed=true, L2", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "write", level: "L2_async_review" }],
    });
    const d = await p.canProceed("write", 0.65, makeCtx());
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L2_async_review");
  });
  it("L2 + confidence < 0.60 → escalade L3, proceed=false", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "write", level: "L2_async_review" }],
    });
    const d = await p.canProceed("write", 0.5, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });
});

describe("createEscalationPyramid — L3_hitl_required", () => {
  it("L3 → proceed=false quelle que soit la confiance", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "trade", level: "L3_hitl_required" }],
    });
    const d = await p.canProceed("trade", 0.99, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });
});

describe("createEscalationPyramid — actionType inconnu", () => {
  it("default L3 (fail-safe)", async () => {
    const p = createEscalationPyramid({ name: "p", declarations: [] });
    const d = await p.canProceed("unknown", 1.0, makeCtx());
    expect(d.proceed).toBe(false);
    expect(d.effectiveLevel).toBe("L3_hitl_required");
  });
});

describe("createEscalationPyramid — dry-run", () => {
  it("dry-run toujours L1, proceed=true", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "trade", level: "L3_hitl_required" }],
    });
    const d = await p.canProceed("trade", 0.0, makeCtx("dry-run"));
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
    expect(d.reason).toContain("dry-run");
  });
  it("dry-run actionType inconnu → L1", async () => {
    const p = createEscalationPyramid({ name: "p", declarations: [] });
    const d = await p.canProceed("mystery", 0.0, makeCtx("dry-run"));
    expect(d.proceed).toBe(true);
  });
});

describe("createEscalationPyramid — onHitlRequired", () => {
  it("appelle onHitlRequired quand L3", async () => {
    const onHitlRequired = vi.fn();
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "trade", level: "L3_hitl_required" }],
      onHitlRequired,
    });
    const ctx = makeCtx();
    await p.canProceed("trade", 0.99, ctx);
    expect(onHitlRequired).toHaveBeenCalledOnce();
    const [at, conf, , callCtx] = onHitlRequired.mock.calls[0] as [
      string,
      number,
      EscalationDecision,
      OODAContext,
    ];
    expect(at).toBe("trade");
    expect(conf).toBe(0.99);
    expect(callCtx).toBe(ctx);
  });
  it("ne appelle pas onHitlRequired quand proceed=true", async () => {
    const onHitlRequired = vi.fn();
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "read", level: "L1_autonomous" }],
      onHitlRequired,
    });
    await p.canProceed("read", 0.95, makeCtx());
    expect(onHitlRequired).not.toHaveBeenCalled();
  });
});

describe("createEscalationPyramid — override()/clearOverride()", () => {
  it("override() change le niveau d'un actionType", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "read", level: "L1_autonomous" }],
    });
    p.override("read", "L3_hitl_required");
    expect((await p.canProceed("read", 0.99, makeCtx())).proceed).toBe(false);
  });
  it("clearOverride() restaure le niveau déclaré", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "read", level: "L1_autonomous" }],
    });
    p.override("read", "L3_hitl_required");
    p.clearOverride("read");
    expect((await p.canProceed("read", 0.99, makeCtx())).proceed).toBe(true);
  });
  it("clearOverride sur type inconnu → L3 par défaut", async () => {
    const p = createEscalationPyramid({ name: "p", declarations: [] });
    p.override("x", "L1_autonomous");
    p.clearOverride("x");
    expect((await p.canProceed("x", 1.0, makeCtx())).proceed).toBe(false);
  });
});

describe("createEscalationPyramid — Brain logging", () => {
  it("appelle brain.archiveKnowledge par canProceed", async () => {
    const brain = mockBrain();
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "r", level: "L1_autonomous" }],
      brain,
    });
    await p.canProceed("r", 0.9, makeCtx());
    await Promise.resolve();
    expect(brain.archiveKnowledge).toHaveBeenCalledOnce();
  });
});

describe("createEscalationPyramid — thresholds custom", () => {
  it("respecte l1ConfidenceThreshold custom", async () => {
    const p = createEscalationPyramid({
      name: "p",
      declarations: [{ actionType: "a", level: "L1_autonomous" }],
      l1ConfidenceThreshold: 0.95,
      l2ConfidenceThreshold: 0.7,
    });
    // 0.90 < 0.95 → escalade L2
    const d = await p.canProceed("a", 0.9, makeCtx());
    expect(d.effectiveLevel).toBe("L2_async_review");
  });
});
