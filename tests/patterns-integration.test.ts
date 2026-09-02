/**
 * Integration test: 3 patterns orchestrés ensemble dans un OODA act phase.
 */
import { describe, expect, it } from "vitest";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import { createSessionCircuitBreaker } from "../src/patterns/circuit-breaker/index.js";
import { createEscalationPyramid } from "../src/patterns/escalation/index.js";
import { createQualityGate } from "../src/patterns/quality-gate/index.js";

function makeCtx(mode: OODAContext["executionMode"] = "live"): OODAContext {
  return {
    agentId: "integration-agent",
    runId: "run-integration",
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

describe("Intégration — 3 patterns dans un OODA act phase", () => {
  it("happy path: CB open + QG auto + Pyramid L1 → proceed complet", async () => {
    const cb = createSessionCircuitBreaker({
      name: "integration-cb",
      thresholds: { maxConsecutiveErrors: 5 },
    });
    const gate = createQualityGate({
      name: "integration-gate",
      evaluators: [{ name: "confidence", evaluate: async () => 0.9 }],
    });
    const pyramid = createEscalationPyramid({
      name: "integration-pyramid",
      declarations: [{ actionType: "write_report", level: "L1_autonomous" }],
    });

    const ctx = makeCtx();
    const cbResult = await cb.check(ctx);
    expect(cbResult.proceed).toBe(true);

    const score = await gate.evaluate({ confidence: 0.9 });
    expect(score.routing).toBe("auto");

    cb.recordTokens(200);
    const escalation = await pyramid.canProceed("write_report", score.overall, ctx);
    expect(escalation.proceed).toBe(true);
    expect(escalation.effectiveLevel).toBe("L1_autonomous");
    cb.recordSuccess();
    cb.recordAction();

    // CB still healthy after one cycle
    expect((await cb.check(ctx)).proceed).toBe(true);
  });

  it("CB trippé → court-circuite avant QG et Pyramid", async () => {
    const cb = createSessionCircuitBreaker({
      name: "tripped-cb",
      thresholds: { maxConsecutiveErrors: 1 },
    });
    const gate = createQualityGate({
      name: "gate",
      evaluators: [{ name: "e", evaluate: async () => 0.9 }],
    });

    const ctx = makeCtx();
    cb.recordError(); // trip

    const cbResult = await cb.check(ctx);
    expect(cbResult.proceed).toBe(false);
    // Short-circuit: QG and Pyramid not evaluated
    if (!cbResult.proceed) return;
    await gate.evaluate({}); // should not reach here
  });

  it("QG hitl_block → bloque avant Pyramid même avec CB open", async () => {
    const cb = createSessionCircuitBreaker({ name: "cb" });
    const gate = createQualityGate({
      name: "gate",
      evaluators: [{ name: "e", evaluate: async () => 0.1 }], // très bas → hitl_block
    });
    const pyramid = createEscalationPyramid({
      name: "pyramid",
      declarations: [{ actionType: "act", level: "L1_autonomous" }],
    });

    const ctx = makeCtx();
    expect((await cb.check(ctx)).proceed).toBe(true);

    const score = await gate.evaluate({ value: 1 });
    expect(score.routing).toBe("hitl_block");
    if (score.routing === "hitl_block") return; // blocked before pyramid
    await pyramid.canProceed("act", score.overall, ctx); // should not reach
  });

  it("dry-run: Pyramid L3 → proceed=true (pas de side effects)", async () => {
    const pyramid = createEscalationPyramid({
      name: "pyramid",
      declarations: [{ actionType: "stripe_refund", level: "L3_hitl_required" }],
    });
    const d = await pyramid.canProceed("stripe_refund", 0.0, makeCtx("dry-run"));
    expect(d.proceed).toBe(true);
    expect(d.effectiveLevel).toBe("L1_autonomous");
  });
});
