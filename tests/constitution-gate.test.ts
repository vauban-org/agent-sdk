/**
 * tests/constitution-gate.test.ts
 *
 * Unit tests for the HardGate — each rule is tested in isolation
 * with positive (should block) and negative (should pass) cases.
 */

import { describe, expect, it } from "vitest";
import { HardGate } from "../src/constitution/gate.js";
import type { ParentCycleContext } from "../src/constitution/gate.js";
import type { CycleSnapshot } from "../src/constitution/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cleanCycle(overrides: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    runId: "run-clean",
    steps: [],
    budgetUsdMax: 1.0,
    budgetUsdSpent: 0.1,
    scope_id: "scope-a",
    rootHash: "a".repeat(64),
    metadata: {
      rso_veto: false,
      pii_redacted: true,
    },
    ...overrides,
  };
}

const defaultParent: ParentCycleContext = {
  budgetUsdMax: 1.0,
  allowed_scope_ids: ["scope-a", "scope-b"],
};

// ---------------------------------------------------------------------------
// Baseline — clean cycle passes
// ---------------------------------------------------------------------------

describe("HardGate baseline", () => {
  it("passes a clean cycle with no parent", () => {
    const gate = new HardGate();
    const result = gate.evaluate(cleanCycle());
    expect(result.pass).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("passes a clean cycle with a valid parent", () => {
    const gate = new HardGate();
    const result = gate.evaluate(cleanCycle(), defaultParent);
    expect(result.pass).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — child budget > parent budget → block (Profitable)
// ---------------------------------------------------------------------------

describe("HardGate Rule 1 — child budget > parent budget", () => {
  it("blocks when child budgetUsdMax > parent budgetUsdMax", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ budgetUsdMax: 2.0 }); // exceeds parent 1.0
    const result = gate.evaluate(cycle, { budgetUsdMax: 1.0 });
    expect(result.pass).toBe(false);
    const v = result.violations.find((v) => v.rule === "child_budget_exceeds_parent");
    expect(v).toBeDefined();
    expect(v!.axiom).toBe("Profitable");
    expect(v!.severity).toBe("block");
  });

  it("passes when child budgetUsdMax === parent budgetUsdMax", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ budgetUsdMax: 1.0 });
    const result = gate.evaluate(cycle, { budgetUsdMax: 1.0 });
    expect(result.violations.some((v) => v.rule === "child_budget_exceeds_parent")).toBe(false);
  });

  it("passes when child budgetUsdMax < parent budgetUsdMax", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ budgetUsdMax: 0.5 });
    const result = gate.evaluate(cycle, { budgetUsdMax: 1.0 });
    expect(result.violations.some((v) => v.rule === "child_budget_exceeds_parent")).toBe(false);
  });

  it("skips budget rule when no parent is provided", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ budgetUsdMax: 999.0 });
    const result = gate.evaluate(cycle); // no parent
    expect(result.violations.some((v) => v.rule === "child_budget_exceeds_parent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — secret in step output → block (Robuste)
// ---------------------------------------------------------------------------

describe("HardGate Rule 2 — secret in step output", () => {
  it('blocks when output contains "api_key="', () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [{ index: 0, phase: "act", type: "tool_call", output: "response api_key=sk-abc" }],
    });
    const result = gate.evaluate(cycle);
    const v = result.violations.find((v) => v.rule === "secret_in_step_output");
    expect(v).toBeDefined();
    expect(v!.axiom).toBe("Robuste");
    expect(v!.severity).toBe("block");
  });

  it('blocks when output contains "password"', () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [{ index: 0, phase: "act", type: "tool_call", output: '{"password":"p@ssw0rd"}' }],
    });
    const result = gate.evaluate(cycle);
    const v = result.violations.find((v) => v.rule === "secret_in_step_output");
    expect(v).toBeDefined();
  });

  it('blocks when output contains "secret"', () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [{ index: 0, phase: "act", type: "tool_call", output: "secret=topsecret" }],
    });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "secret_in_step_output")).toBe(true);
  });

  it('blocks when output contains "token="', () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [{ index: 0, phase: "act", type: "tool_call", output: "token=Bearer eyJhb" }],
    });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "secret_in_step_output")).toBe(true);
  });

  it("passes when output contains no secret patterns", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [{ index: 0, phase: "decide", type: "llm_call", output: "The answer is 42" }],
    });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "secret_in_step_output")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — scope dépassé → block (Robuste)
// ---------------------------------------------------------------------------

describe("HardGate Rule 3 — scope dépassé", () => {
  it("blocks when scope_id is not in allowed_scope_ids", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ scope_id: "scope-forbidden" });
    const result = gate.evaluate(cycle, {
      budgetUsdMax: 10.0,
      allowed_scope_ids: ["scope-a", "scope-b"],
    });
    const v = result.violations.find((v) => v.rule === "scope_exceeded");
    expect(v).toBeDefined();
    expect(v!.axiom).toBe("Robuste");
    expect(v!.severity).toBe("block");
  });

  it("passes when scope_id is in allowed_scope_ids", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ scope_id: "scope-a" });
    const result = gate.evaluate(cycle, {
      budgetUsdMax: 10.0,
      allowed_scope_ids: ["scope-a", "scope-b"],
    });
    expect(result.violations.some((v) => v.rule === "scope_exceeded")).toBe(false);
  });

  it("passes when no scope_id is declared on the cycle", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ scope_id: undefined });
    const result = gate.evaluate(cycle, {
      budgetUsdMax: 10.0,
      allowed_scope_ids: ["scope-a"],
    });
    expect(result.violations.some((v) => v.rule === "scope_exceeded")).toBe(false);
  });

  it("passes when parent has no allowed_scope_ids restriction", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ scope_id: "scope-anything" });
    const result = gate.evaluate(cycle, { budgetUsdMax: 10.0 }); // no allowed_scope_ids
    expect(result.violations.some((v) => v.rule === "scope_exceeded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — PII without redacted flag → block (Institutionnel)
// ---------------------------------------------------------------------------

describe("HardGate Rule 4 — PII without redacted flag", () => {
  it("blocks when email appears in output without pii_redacted=true", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [
        {
          index: 0,
          phase: "decide",
          type: "llm_call",
          output: "Contact user@example.com for details",
        },
      ],
      metadata: { pii_redacted: false },
    });
    const result = gate.evaluate(cycle);
    const v = result.violations.find((v) => v.rule === "pii_in_payload_without_redaction");
    expect(v).toBeDefined();
    expect(v!.axiom).toBe("Institutionnel");
    expect(v!.severity).toBe("block");
  });

  it("passes when PII is present but pii_redacted=true", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [
        {
          index: 0,
          phase: "decide",
          type: "llm_call",
          output: "Contact user@example.com for details",
        },
      ],
      metadata: { pii_redacted: true },
    });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "pii_in_payload_without_redaction")).toBe(
      false,
    );
  });

  it("passes when no PII is present", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      steps: [{ index: 0, phase: "decide", type: "llm_call", output: "The answer is 42" }],
      metadata: { pii_redacted: false },
    });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "pii_in_payload_without_redaction")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — RSO veto → block (Institutionnel)
// ---------------------------------------------------------------------------

describe("HardGate Rule 5 — RSO veto", () => {
  it("blocks when metadata.rso_veto=true", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ metadata: { rso_veto: true, pii_redacted: true } });
    const result = gate.evaluate(cycle);
    const v = result.violations.find((v) => v.rule === "rso_veto");
    expect(v).toBeDefined();
    expect(v!.axiom).toBe("Institutionnel");
    expect(v!.severity).toBe("block");
  });

  it("passes when rso_veto is false", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ metadata: { rso_veto: false } });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "rso_veto")).toBe(false);
  });

  it("passes when rso_veto is absent", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({ metadata: {} });
    const result = gate.evaluate(cycle);
    expect(result.violations.some((v) => v.rule === "rso_veto")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("HardGate schema validation", () => {
  it("blocks and returns schema_validation violation for invalid input", () => {
    const gate = new HardGate();
    // Cast to bypass TS — testing runtime validation
    const invalid = { runId: "", steps: "not-an-array" } as unknown as CycleSnapshot;
    const result = gate.evaluate(invalid);
    expect(result.pass).toBe(false);
    const v = result.violations.find((v) => v.rule === "schema_validation");
    expect(v).toBeDefined();
    expect(v!.axiom).toBe("Robuste");
  });
});

// ---------------------------------------------------------------------------
// Multiple simultaneous violations
// ---------------------------------------------------------------------------

describe("HardGate multiple violations", () => {
  it("accumulates multiple violations when multiple rules fire", () => {
    const gate = new HardGate();
    const cycle = cleanCycle({
      budgetUsdMax: 5.0, // exceeds parent 1.0
      steps: [
        { index: 0, phase: "act", type: "tool_call", output: "api_key=leaked" }, // secret
      ],
      metadata: { rso_veto: true, pii_redacted: true }, // RSO veto
    });
    const result = gate.evaluate(cycle, { budgetUsdMax: 1.0 });
    expect(result.pass).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});
