/**
 * provable-planner parity + behaviour (ADR-ECO-092).
 *
 * The trust anchor of the promotion: the SDK provable-planner produces a leaf that is
 * BYTE-IDENTICAL to (a) the SDK proof canonicaliser (single source of truth) and (b) an
 * independent reference implementation of the JCS + SHA-256 algorithm used by the host
 * `src/proof/decision-reexec-proof.ts` and the research mirror
 * `research-wm/packages/provable-core`. Plus the A0/A1/A3 ladder and the governed-primitive
 * guards.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { leafHash as proofLeafHash } from "../../src/proof/index.js";
import {
  type DeterministicPolicy,
  GovernanceError,
  decideProvably,
  decisionAnchorPreimage,
  gradeDecision,
  verifyDecisionReexecution,
} from "../../src/provable-planner/index.js";

// ─── Independent reference (the host/research algorithm), re-derived here ─────────
function refNormalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(refNormalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = refNormalize(obj[key]);
    return sorted;
  }
  return value;
}
function refLeaf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(refNormalize(value)), "utf8")
    .digest("hex");
}

// A sample deterministic WM-planner core: argmin over a tiny candidate set.
interface PlanInput {
  candidates: { id: string; cost: number }[];
}
interface PlanOutput {
  chosen: string;
  cost: number;
}
const POLICY_ID = "test.argmin-planner";
const POLICY_VERSION = "v1";
const ADR = "ADR-ECO-092";
const planPolicy: DeterministicPolicy<PlanInput, PlanOutput> = (input) => {
  let best = input.candidates[0];
  for (const c of input.candidates) {
    if (c.cost < best.cost || (c.cost === best.cost && c.id < best.id)) best = c;
  }
  return { chosen: best.id, cost: best.cost };
};
const sampleInput: PlanInput = {
  candidates: [
    { id: "b", cost: 5 },
    { id: "a", cost: 3 },
    { id: "c", cost: 3 },
  ],
};

describe("provable-planner leaf parity", () => {
  it("decideProvably audit hash == SDK proof leafHash == independent reference", () => {
    const { claim, auditStep } = decideProvably({
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      policy: planPolicy,
      input: sampleInput,
      adrEco: ADR,
    });
    expect(claim.output).toEqual({ chosen: "a", cost: 3 });
    // single canonicaliser: audit hash is the proof module's leafHash of the core
    expect(auditStep.outputHash).toBe(proofLeafHash(claim.output as Record<string, unknown>));
    // byte-parity with the independent host/research algorithm
    expect(auditStep.outputHash).toBe(refLeaf(claim.output));
    expect(auditStep.adrEco).toBe(ADR);
  });

  it("anchor preimage leaf is byte-identical to the reference (field names load-bearing)", () => {
    const pre = decisionAnchorPreimage({
      id: "row-1",
      agentId: "agent-x",
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      input: sampleInput,
      output: { chosen: "a", cost: 3 },
      decidedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(proofLeafHash(pre)).toBe(refLeaf(pre));
    // key order independence: a reordered preimage hashes identically
    const reordered = {
      decided_at: "2026-06-15T00:00:00.000Z",
      output: { cost: 3, chosen: "a" },
      input: sampleInput,
      policy_version: POLICY_VERSION,
      policy_id: POLICY_ID,
      agent_id: "agent-x",
      id: "row-1",
    };
    expect(proofLeafHash(reordered)).toBe(proofLeafHash(pre));
  });
});

describe("A0/A1/A3 ladder", () => {
  it("clean re-execution grades A3 (external) / A1 (self)", () => {
    const { claim } = decideProvably({
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      policy: planPolicy,
      input: sampleInput,
      adrEco: ADR,
    });
    const verdict = verifyDecisionReexecution(claim, planPolicy, POLICY_VERSION);
    expect(verdict.ok).toBe(true);
    expect(gradeDecision(verdict, true)).toBe("A3");
    expect(gradeDecision(verdict, false)).toBe("A1");
  });

  it("tampered output grades A0", () => {
    const { claim } = decideProvably({
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      policy: planPolicy,
      input: sampleInput,
      adrEco: ADR,
    });
    const tampered = { ...claim, output: { chosen: "b", cost: 5 } };
    const verdict = verifyDecisionReexecution(tampered, planPolicy, POLICY_VERSION);
    expect(verdict.ok).toBe(false);
    expect(gradeDecision(verdict, true)).toBe("A0");
  });

  it("wrong policy version grades A0", () => {
    const { claim } = decideProvably({
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      policy: planPolicy,
      input: sampleInput,
      adrEco: ADR,
    });
    const verdict = verifyDecisionReexecution(claim, planPolicy, "v2");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("policy-version-mismatch");
    expect(gradeDecision(verdict, true)).toBe("A0");
  });
});

describe("governed-primitive guards (ADR-ECO-068)", () => {
  it("missing adrEco throws GovernanceError (property 3)", () => {
    expect(() =>
      decideProvably({
        policyId: POLICY_ID,
        policyVersion: POLICY_VERSION,
        policy: planPolicy,
        input: sampleInput,
        adrEco: "",
      }),
    ).toThrow(GovernanceError);
  });

  it("non-deterministic policy throws GovernanceError (property 1)", () => {
    let n = 0;
    const flaky: DeterministicPolicy<PlanInput, PlanOutput> = () => ({ chosen: "x", cost: n++ });
    expect(() =>
      decideProvably({
        policyId: "test.flaky",
        policyVersion: "v1",
        policy: flaky,
        input: sampleInput,
        adrEco: ADR,
      }),
    ).toThrow(GovernanceError);
  });
});
