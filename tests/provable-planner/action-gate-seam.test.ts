/**
 * provableActionGate ; the preste local-before-action seam consuming decideProvably
 * (ADR-ECO-092, second consumer). The gate's verdict IS a governed, A3-gradable decision.
 */
import { describe, expect, it } from "vitest";

import type { ActionGateCall } from "../../src/permissions/action-gate.js";
import {
  type DeterministicPolicy,
  type GateDecisionCore,
  decideProvably,
  gradeDecision,
  provableActionGate,
  verifyDecisionReexecution,
} from "../../src/provable-planner/index.js";

const POLICY_ID = "preste.tool-allow";
const POLICY_VERSION = "v1";
const ADR = "ADR-ECO-092";

// A deterministic allow/deny policy: deny a writing tool over a budget cap, else allow.
const gatePolicy: DeterministicPolicy<ActionGateCall, GateDecisionCore> = (call) => {
  if (call.toolName.startsWith("write") && call.budgetUsed > 1) {
    return { allowed: false, reason: "write tool denied over budget cap" };
  }
  return { allowed: true, reason: "ok" };
};

const gate = provableActionGate({
  policyId: POLICY_ID,
  policyVersion: POLICY_VERSION,
  adrEco: ADR,
  policy: gatePolicy,
});

describe("provableActionGate (preste seam)", () => {
  it("allows a permitted call", async () => {
    const v = await gate.verify({ toolName: "read_file", args: {}, budgetUsed: 0 });
    expect(v.allowed).toBe(true);
    expect(v.auditStep).toBeDefined();
  });

  it("denies fail-closed a call the policy rejects", async () => {
    const v = await gate.verify({ toolName: "write_file", args: { path: "x" }, budgetUsed: 5 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("budget");
  });

  it("the gate verdict is itself an A3-gradable governed decision", () => {
    const call: ActionGateCall = { toolName: "write_file", args: { path: "x" }, budgetUsed: 5 };
    const governed = decideProvably({
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      policy: gatePolicy,
      input: call,
      adrEco: ADR,
    });
    const verdict = verifyDecisionReexecution(governed.claim, gatePolicy, POLICY_VERSION);
    expect(gradeDecision(verdict, true)).toBe("A3");
    expect(governed.claim.output.allowed).toBe(false);
  });

  it("fails closed (deny) when the policy is non-deterministic", async () => {
    let n = 0;
    const flaky: DeterministicPolicy<ActionGateCall, GateDecisionCore> = () => ({
      allowed: true,
      reason: `nonce-${n++}`,
    });
    const flakyGate = provableActionGate({
      policyId: "preste.flaky",
      policyVersion: "v1",
      adrEco: ADR,
      policy: flaky,
    });
    const v = await flakyGate.verify({ toolName: "read", args: {}, budgetUsed: 0 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("fail-closed");
  });
});
