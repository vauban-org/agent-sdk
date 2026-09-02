/**
 * tests/formal-verify.test.ts
 *
 * Sprint-587 — Tests for the formal verification layer.
 *
 * The Z3 binary is not assumed to be installed on the CI host. Tests that
 * depend on real solver behaviour mock the solver layer ; tests that exercise
 * the policy layer or the SMT compiler do not need Z3 at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formalVerify } from "../src/verify/formal/index.js";
import { type AxiomPolicy, DEFAULT_POLICIES, applyPolicy } from "../src/verify/formal/policy.js";
import type { FormalVerifyResult } from "../src/verify/formal/result.js";
import * as solver from "../src/verify/formal/solver.js";
import { AXIOM_SPECS, type AxiomSpec, compileToSmt } from "../src/verify/formal/spec-language.js";

// ---------------------------------------------------------------------------
// SMT compiler — no Z3 required
// ---------------------------------------------------------------------------

describe("compileToSmt", () => {
  it("emits check-sat + get-model terminators", () => {
    const smt = compileToSmt({
      axiom: "Robuste",
      preconditions: [],
      postconditions: [{ type: "budget_constraint", child_max_fraction: 1.0 }],
    });
    expect(smt).toContain("(check-sat)");
    expect(smt).toContain("(get-model)");
  });

  it("negates a single postcondition", () => {
    const smt = compileToSmt({
      axiom: "Profitable",
      preconditions: [],
      postconditions: [{ type: "cost_positive_roi", min_roi_ratio: 1.5 }],
    });
    expect(smt).toContain("(not (>= (/ value cost) 1.5))");
  });

  it("disjunctively negates multiple postconditions", () => {
    const smt = compileToSmt({
      axiom: "Robuste",
      preconditions: [],
      postconditions: [
        { type: "budget_constraint", child_max_fraction: 1.0 },
        { type: "response_time", max_ms: 5000 },
      ],
    });
    // Expect a single (or (not …) (not …)) assertion.
    expect(smt).toMatch(/\(assert \(or \(not /);
  });

  it("declares budget reals exactly once even when referenced multiple times", () => {
    const smt = compileToSmt({
      axiom: "Robuste",
      preconditions: [{ type: "budget_constraint", child_max_fraction: 1.0 }],
      postconditions: [{ type: "budget_constraint", child_max_fraction: 0.5 }],
    });
    const occurrences = smt.match(/\(declare-const parent_budget Real\)/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("compiles each of the 5 default AXIOM_SPECS without error", () => {
    for (const axiom of Object.keys(AXIOM_SPECS)) {
      const spec = AXIOM_SPECS[axiom]!;
      const smt = compileToSmt(spec);
      expect(smt.length).toBeGreaterThan(0);
      expect(smt).toContain("(check-sat)");
    }
  });
});

// ---------------------------------------------------------------------------
// Policy resolution — no Z3 required
// ---------------------------------------------------------------------------

function mkResult(
  state: FormalVerifyResult["state"],
  axiom: string,
  extras: Partial<FormalVerifyResult> = {},
): FormalVerifyResult {
  return {
    state,
    axiom,
    rationale: "test",
    time_ms: 1,
    solver: state === "SKIPPED" ? "none" : "z3",
    ...extras,
  };
}

describe("applyPolicy", () => {
  it("returns proceed on SAFE in strict mode runtime", () => {
    const d = applyPolicy(
      mkResult("SAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("proceed");
  });

  it("returns block on UNSAFE for Robuste in strict mode", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Robuste", { counterexample: "child_budget=10" }),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("block");
  });

  it("escalates UNKNOWN for Robuste in runtime", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("escalate_human");
  });

  it("logs UNKNOWN for Profitable in runtime (proceed_with_log)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("Tension Sprint C : skill_ingestion + UNKNOWN always blocks (even on Profitable)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "strict",
      "skill_ingestion",
    );
    expect(d.action).toBe("block");
    expect(d.rationale).toMatch(/Tension Sprint C/);
  });

  it("Tension Sprint C : skill_ingestion + UNKNOWN blocks regardless of permissive mode", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "permissive",
      "skill_ingestion",
    );
    expect(d.action).toBe("block");
  });

  it("permissive mode treats UNKNOWN as log even on Robuste runtime", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("permissive mode keeps UNSAFE on Robuste as block (hard axiom)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("block");
  });

  it("permissive mode downgrades UNSAFE on soft axiom (Profitable) to log", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("audit_only mode never blocks", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "audit_only",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("SKIPPED always returns log regardless of mode/context", () => {
    const d = applyPolicy(
      mkResult("SKIPPED", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "skill_ingestion",
    );
    expect(d.action).toBe("log");
  });

  it("DEFAULT_POLICIES preserves skillLoopStrict=true invariant", () => {
    for (const axiom of Object.keys(DEFAULT_POLICIES)) {
      const p = DEFAULT_POLICIES[axiom]!;
      expect(p.skillLoopStrict).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formalVerify with mocked solver — no Z3 binary needed
// ---------------------------------------------------------------------------

describe("formalVerify", () => {
  beforeEach(() => {
    solver.__resetZ3AvailabilityCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    solver.__resetZ3AvailabilityCache();
  });

  it("returns UNKNOWN for every spec when z3 is unavailable", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(false);

    const out = await formalVerify(
      [AXIOM_SPECS.Robuste!, AXIOM_SPECS.Profitable!],
      "strict",
      "runtime",
    );
    expect(out).toHaveLength(2);
    for (const { result } of out) {
      expect(result.state).toBe("UNKNOWN");
      expect(result.solver).toBe("none");
      expect(result.rationale).toMatch(/z3 binary not available/);
    }
  });

  it("maps unsat → SAFE", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(true);
    vi.spyOn(solver, "checkSmt").mockResolvedValue({ sat: false, time_ms: 12 });

    const out = await formalVerify([AXIOM_SPECS.Profitable!], "strict", "runtime");
    expect(out[0]!.result.state).toBe("SAFE");
    expect(out[0]!.decision.action).toBe("proceed");
  });

  it("maps sat → UNSAFE and preserves counterexample model", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(true);
    vi.spyOn(solver, "checkSmt").mockResolvedValue({
      sat: true,
      time_ms: 23,
      model: "(define-fun child_budget () Real 999.0)",
    });

    const out = await formalVerify([AXIOM_SPECS.Robuste!], "strict", "runtime");
    expect(out[0]!.result.state).toBe("UNSAFE");
    expect(out[0]!.result.counterexample).toContain("child_budget");
    expect(out[0]!.decision.action).toBe("block");
  });

  it("maps null (timeout) → UNKNOWN with reason propagated", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(true);
    vi.spyOn(solver, "checkSmt").mockResolvedValue({
      sat: null,
      time_ms: 5000,
      reason: "z3 timeout after 5000ms",
    });

    const out = await formalVerify([AXIOM_SPECS.Robuste!], "strict", "runtime");
    expect(out[0]!.result.state).toBe("UNKNOWN");
    expect(out[0]!.result.rationale).toMatch(/timeout/);
    expect(out[0]!.decision.action).toBe("escalate_human");
  });

  it("skill_ingestion + null solver result → block (Tension Sprint C)", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(false);

    const out = await formalVerify([AXIOM_SPECS.Profitable!], "permissive", "skill_ingestion");
    expect(out[0]!.result.state).toBe("UNKNOWN");
    expect(out[0]!.decision.action).toBe("block");
    expect(out[0]!.decision.rationale).toMatch(/Tension Sprint C/);
  });

  it("respects customPolicies override", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(true);
    vi.spyOn(solver, "checkSmt").mockResolvedValue({ sat: null, time_ms: 100 });

    const override: AxiomPolicy = {
      onSafe: "proceed",
      onUnsafe: "block",
      onUnknown: "proceed_with_log", // override: log instead of escalate
      timeout_ms: 500,
      skillLoopStrict: true,
    };

    const out = await formalVerify([AXIOM_SPECS.Robuste!], "strict", "runtime", {
      Robuste: override,
    });
    expect(out[0]!.decision.action).toBe("log");
  });

  it("respects per-spec custom AxiomSpec", async () => {
    vi.spyOn(solver, "isZ3Available").mockResolvedValue(true);
    vi.spyOn(solver, "checkSmt").mockResolvedValue({ sat: false, time_ms: 5 });

    const custom: AxiomSpec = {
      axiom: "Custom",
      preconditions: [],
      postconditions: [{ type: "custom_smt", smt_fragment: "true" }],
      timeout_ms: 250,
    };
    const out = await formalVerify([custom], "strict", "runtime");
    expect(out[0]!.result.state).toBe("SAFE");
    expect(out[0]!.result.axiom).toBe("Custom");
  });
});
