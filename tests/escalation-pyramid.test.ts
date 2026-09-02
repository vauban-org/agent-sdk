/**
 * Tests for src/patterns/escalation/pyramid.ts
 *
 * createEscalationPyramid — confidence-based level escalation,
 * dry-run bypass, override/clearOverride, unknown action default.
 */

import { describe, expect, it, vi } from "vitest";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import { createEscalationPyramid } from "../src/patterns/escalation/pyramid.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(executionMode: "live" | "dry-run" = "live"): OODAContext {
  return {
    agentId: "test-agent",
    runId: "run-1",
    executionMode,
    cycle: 1,
    createdAt: new Date(),
  } as unknown as OODAContext;
}

function makePyramid() {
  return createEscalationPyramid({
    name: "test-pyramid",
    declarations: [
      { actionType: "read_db", level: "L1_autonomous" },
      { actionType: "write_db", level: "L2_async_review" },
      { actionType: "sign_tx", level: "L3_hitl_required" },
    ],
    l1ConfidenceThreshold: 0.85,
    l2ConfidenceThreshold: 0.6,
    brain: undefined,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createEscalationPyramid", () => {
  it("throws when l2 threshold >= l1 threshold", () => {
    expect(() =>
      createEscalationPyramid({
        name: "bad",
        declarations: [],
        l1ConfidenceThreshold: 0.7,
        l2ConfidenceThreshold: 0.8,
        brain: undefined,
      }),
    ).toThrow();
  });

  it("L1 action with high confidence proceeds at L1", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("read_db", 0.9, makeCtx());
    expect(decision.proceed).toBe(true);
    expect(decision.effectiveLevel).toBe("L1_autonomous");
  });

  it("L1 action with low confidence escalates to L2", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("read_db", 0.7, makeCtx());
    expect(decision.proceed).toBe(true);
    expect(decision.effectiveLevel).toBe("L2_async_review");
  });

  it("L2 action with low confidence escalates to L3 (blocked)", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("write_db", 0.4, makeCtx());
    expect(decision.proceed).toBe(false);
    expect(decision.effectiveLevel).toBe("L3_hitl_required");
  });

  it("L3 action always blocks regardless of confidence", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("sign_tx", 0.99, makeCtx());
    expect(decision.proceed).toBe(false);
    expect(decision.effectiveLevel).toBe("L3_hitl_required");
  });

  it("unknown action type defaults to L3 (fail-safe)", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("unknown_action", 0.99, makeCtx());
    expect(decision.proceed).toBe(false);
    expect(decision.effectiveLevel).toBe("L3_hitl_required");
  });

  it("dry-run forces L1_autonomous regardless of nominal level", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("sign_tx", 0.1, makeCtx("dry-run"));
    expect(decision.proceed).toBe(true);
    expect(decision.effectiveLevel).toBe("L1_autonomous");
  });

  it("override changes the level for an action type", async () => {
    const pyramid = makePyramid();
    pyramid.override("read_db", "L3_hitl_required");
    const decision = await pyramid.canProceed("read_db", 0.99, makeCtx());
    expect(decision.proceed).toBe(false);
    expect(decision.effectiveLevel).toBe("L3_hitl_required");
  });

  it("clearOverride restores the declared level", async () => {
    const pyramid = makePyramid();
    pyramid.override("read_db", "L3_hitl_required");
    pyramid.clearOverride("read_db");
    const decision = await pyramid.canProceed("read_db", 0.9, makeCtx());
    expect(decision.proceed).toBe(true);
    expect(decision.effectiveLevel).toBe("L1_autonomous");
  });

  it("calls onHitlRequired callback when L3 blocks", async () => {
    const onHitlRequired = vi.fn();
    const pyramid = createEscalationPyramid({
      name: "hitl-test",
      declarations: [{ actionType: "sign_tx", level: "L3_hitl_required" }],
      brain: undefined,
      onHitlRequired,
    });
    await pyramid.canProceed("sign_tx", 0.99, makeCtx());
    expect(onHitlRequired).toHaveBeenCalledOnce();
    expect(onHitlRequired.mock.calls[0]?.[0]).toBe("sign_tx");
  });

  it("decision reason contains actionType and confidence", async () => {
    const pyramid = makePyramid();
    const decision = await pyramid.canProceed("read_db", 0.9, makeCtx());
    expect(decision.reason).toContain("read_db");
  });
});
