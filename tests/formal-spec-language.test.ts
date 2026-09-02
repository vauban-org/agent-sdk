/**
 * tests/formal-spec-language.test.ts
 *
 * Sprint-587 — Focused unit tests for the SMT compiler (spec-language.ts).
 * No Z3 binary required ; tests only the compileToSmt pure function.
 */

import { describe, expect, it } from "vitest";

import { AXIOM_SPECS, type AxiomSpec, compileToSmt } from "../src/verify/formal/spec-language.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spec(
  axiom: string,
  preconditions: AxiomSpec["preconditions"],
  postconditions: AxiomSpec["postconditions"],
): AxiomSpec {
  return { axiom, preconditions, postconditions };
}

// ---------------------------------------------------------------------------
// Terminator + header
// ---------------------------------------------------------------------------

describe("compileToSmt — structure", () => {
  it("always ends with (check-sat)", () => {
    const smt = compileToSmt(spec("T", [], []));
    const lines = smt.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("(get-model)");
    expect(lines.at(-2)).toBe("(check-sat)");
  });

  it("includes axiom label in the header comment", () => {
    const smt = compileToSmt(spec("MyAxiom", [], []));
    expect(smt).toContain("MyAxiom");
  });

  it("sets (set-logic ALL) header", () => {
    const smt = compileToSmt(spec("T", [], []));
    expect(smt).toContain("(set-logic ALL)");
  });

  it("empty pre + empty post → (assert false) making it trivially SAFE", () => {
    const smt = compileToSmt(spec("T", [], []));
    expect(smt).toContain("(assert false)");
  });
});

// ---------------------------------------------------------------------------
// budget_constraint
// ---------------------------------------------------------------------------

describe("compileToSmt — budget_constraint", () => {
  it("declares parent_budget and child_budget as Real", () => {
    const smt = compileToSmt(
      spec("T", [], [{ type: "budget_constraint", child_max_fraction: 0.5 }]),
    );
    expect(smt).toContain("(declare-const parent_budget Real)");
    expect(smt).toContain("(declare-const child_budget Real)");
  });

  it("as postcondition, negates the budget inequality", () => {
    const smt = compileToSmt(
      spec("T", [], [{ type: "budget_constraint", child_max_fraction: 0.5 }]),
    );
    expect(smt).toContain("(not (<= child_budget (* parent_budget 0.5)))");
  });

  it("as precondition, asserts the budget constraint positively", () => {
    const smt = compileToSmt(
      spec("T", [{ type: "budget_constraint", child_max_fraction: 0.8 }], []),
    );
    expect(smt).toContain("(<= child_budget (* parent_budget 0.8))");
    expect(smt).not.toContain("(not (<= child_budget");
  });

  it("declares each symbol at most once when reused in pre + post", () => {
    const smt = compileToSmt(
      spec(
        "T",
        [{ type: "budget_constraint", child_max_fraction: 1.0 }],
        [{ type: "budget_constraint", child_max_fraction: 0.5 }],
      ),
    );
    const occurrences = smt.match(/\(declare-const parent_budget Real\)/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scope_subset
// ---------------------------------------------------------------------------

describe("compileToSmt — scope_subset", () => {
  it("child fully within parent → asserts true in postcondition", () => {
    const smt = compileToSmt(
      spec("T", [], [{ type: "scope_subset", parent_scope: ["a", "b"], child_scope: ["a"] }]),
    );
    // negated postcondition of `true` is `(not true)`
    expect(smt).toContain("(assert (not true))");
  });

  it("child outside parent → asserts false in postcondition", () => {
    const smt = compileToSmt(
      spec("T", [], [{ type: "scope_subset", parent_scope: ["a"], child_scope: ["b"] }]),
    );
    // negated postcondition of `false` is `(not false)`
    expect(smt).toContain("(assert (not false))");
  });

  it("scope_subset with empty child is always a subset", () => {
    const smt = compileToSmt(
      spec("T", [], [{ type: "scope_subset", parent_scope: ["x", "y"], child_scope: [] }]),
    );
    expect(smt).toContain("(assert (not true))");
  });
});

// ---------------------------------------------------------------------------
// no_pii_in_output
// ---------------------------------------------------------------------------

describe("compileToSmt — no_pii_in_output", () => {
  it("declares default pii_count Int variable", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "no_pii_in_output" }]));
    expect(smt).toContain("(declare-const pii_count Int)");
  });

  it("respects custom pii_count_var name", () => {
    const smt = compileToSmt(
      spec("T", [], [{ type: "no_pii_in_output", pii_count_var: "leaked_fields" }]),
    );
    expect(smt).toContain("(declare-const leaked_fields Int)");
    expect(smt).not.toContain("(declare-const pii_count Int)");
  });

  it("as postcondition, negates (= pii_count 0)", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "no_pii_in_output" }]));
    expect(smt).toContain("(not (= pii_count 0))");
  });
});

// ---------------------------------------------------------------------------
// cost_positive_roi
// ---------------------------------------------------------------------------

describe("compileToSmt — cost_positive_roi", () => {
  it("declares cost and value as Real", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "cost_positive_roi", min_roi_ratio: 1.0 }]));
    expect(smt).toContain("(declare-const cost Real)");
    expect(smt).toContain("(declare-const value Real)");
  });

  it("as postcondition, negates the ROI ratio expression", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "cost_positive_roi", min_roi_ratio: 1.5 }]));
    expect(smt).toContain("(not (>= (/ value cost) 1.5))");
  });

  it("handles fractional roi ratio in the SMT fragment", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "cost_positive_roi", min_roi_ratio: 0.75 }]));
    expect(smt).toContain("0.75");
  });
});

// ---------------------------------------------------------------------------
// response_time
// ---------------------------------------------------------------------------

describe("compileToSmt — response_time", () => {
  it("declares response_ms as Real", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "response_time", max_ms: 5000 }]));
    expect(smt).toContain("(declare-const response_ms Real)");
  });

  it("as postcondition, negates the time bound", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "response_time", max_ms: 30000 }]));
    expect(smt).toContain("(not (<= response_ms 30000))");
  });
});

// ---------------------------------------------------------------------------
// custom_smt
// ---------------------------------------------------------------------------

describe("compileToSmt — custom_smt", () => {
  it("as postcondition, wraps fragment in (assert (not ...))", () => {
    const smt = compileToSmt(spec("T", [], [{ type: "custom_smt", smt_fragment: "(> x 0)" }]));
    expect(smt).toContain("(assert (not (> x 0)))");
  });

  it("as precondition, wraps fragment in (assert ...)", () => {
    const smt = compileToSmt(
      spec("T", [{ type: "custom_smt", smt_fragment: "(= flag true)" }], []),
    );
    expect(smt).toContain("(assert (= flag true))");
  });

  it("trims whitespace from the smt_fragment", () => {
    const smt = compileToSmt(spec("T", [{ type: "custom_smt", smt_fragment: "  (= x 1)  " }], []));
    expect(smt).toContain("(assert (= x 1))");
  });
});

// ---------------------------------------------------------------------------
// Multi-condition postcondition (disjunction)
// ---------------------------------------------------------------------------

describe("compileToSmt — multiple postconditions", () => {
  it("two postconditions produce a single (assert (or ...))", () => {
    const smt = compileToSmt(
      spec(
        "T",
        [],
        [
          { type: "cost_positive_roi", min_roi_ratio: 1.0 },
          { type: "response_time", max_ms: 5000 },
        ],
      ),
    );
    expect(smt).toMatch(/\(assert \(or \(not /);
  });

  it("three postconditions are all included under the disjunction", () => {
    const smt = compileToSmt(
      spec(
        "T",
        [],
        [
          { type: "cost_positive_roi", min_roi_ratio: 1.0 },
          { type: "response_time", max_ms: 5000 },
          { type: "no_pii_in_output" },
        ],
      ),
    );
    const orCount = (smt.match(/\(not /g) ?? []).length;
    expect(orCount).toBeGreaterThanOrEqual(3);
    expect(smt).toContain("(assert (or ");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("compileToSmt — determinism", () => {
  it("same spec produces identical output on repeated calls", () => {
    const s = spec("Det", [], [{ type: "response_time", max_ms: 1000 }]);
    expect(compileToSmt(s)).toBe(compileToSmt(s));
  });
});

// ---------------------------------------------------------------------------
// AXIOM_SPECS presets
// ---------------------------------------------------------------------------

describe("AXIOM_SPECS presets", () => {
  it("exports exactly 5 axiom specs", () => {
    expect(Object.keys(AXIOM_SPECS)).toHaveLength(5);
  });

  it("each preset compiles to a non-empty string with (check-sat)", () => {
    for (const key of Object.keys(AXIOM_SPECS)) {
      const smt = compileToSmt(AXIOM_SPECS[key]!);
      expect(smt.length).toBeGreaterThan(0);
      expect(smt).toContain("(check-sat)");
    }
  });

  it("Profitable spec references ROI expression", () => {
    const smt = compileToSmt(AXIOM_SPECS.Profitable!);
    expect(smt).toContain("(/ value cost)");
  });

  it("Institutionnel spec references pii_count", () => {
    const smt = compileToSmt(AXIOM_SPECS.Institutionnel!);
    expect(smt).toContain("pii_count");
  });

  it("Robuste spec has two postconditions producing a disjunction", () => {
    const smt = compileToSmt(AXIOM_SPECS.Robuste!);
    expect(smt).toContain("(assert (or ");
  });

  it("AntiFragile spec references response_ms", () => {
    const smt = compileToSmt(AXIOM_SPECS.AntiFragile!);
    expect(smt).toContain("response_ms");
  });
});
