/**
 * tests/formal-policy.test.ts
 *
 * Sprint-587 — Focused unit tests for the policy resolution layer (policy.ts).
 * No Z3 binary required ; tests only pure applyPolicy + DEFAULT_POLICIES data.
 */

import { describe, expect, it } from "vitest";

import { type AxiomPolicy, DEFAULT_POLICIES, applyPolicy } from "../src/verify/formal/policy.js";
import type { FormalVerifyResult } from "../src/verify/formal/result.js";

// ---------------------------------------------------------------------------
// Helper
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
    time_ms: 5,
    solver: state === "SKIPPED" ? "none" : "z3",
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// SAFE → always proceed
// ---------------------------------------------------------------------------

describe("applyPolicy — SAFE", () => {
  it("SAFE strict runtime → proceed", () => {
    const d = applyPolicy(
      mkResult("SAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("proceed");
  });

  it("SAFE permissive runtime → proceed", () => {
    const d = applyPolicy(
      mkResult("SAFE", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("proceed");
  });

  it("SAFE audit_only runtime → log (audit_only intercepts before SAFE short-circuit)", () => {
    // From source: audit_only fires at step 3, before the SAFE check at step 4.
    // So SAFE + audit_only → log, not proceed.
    const d = applyPolicy(
      mkResult("SAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "audit_only",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("SAFE skill_ingestion strict → proceed", () => {
    const d = applyPolicy(
      mkResult("SAFE", "Institutionnel"),
      DEFAULT_POLICIES.Institutionnel!,
      "strict",
      "skill_ingestion",
    );
    expect(d.action).toBe("proceed");
  });

  it("rationale mentions axiom name and timing on SAFE", () => {
    const d = applyPolicy(
      mkResult("SAFE", "SOTA", { time_ms: 42 }),
      DEFAULT_POLICIES.SOTA!,
      "strict",
      "runtime",
    );
    expect(d.rationale).toContain("SOTA");
    expect(d.rationale).toContain("42");
  });
});

// ---------------------------------------------------------------------------
// UNSAFE
// ---------------------------------------------------------------------------

describe("applyPolicy — UNSAFE", () => {
  it("UNSAFE strict runtime Robuste → block (hard axiom)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("block");
  });

  it("UNSAFE strict runtime Institutionnel → block (hard axiom)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Institutionnel"),
      DEFAULT_POLICIES.Institutionnel!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("block");
  });

  it("UNSAFE strict runtime Profitable → escalate_human (soft axiom, policy.onUnsafe)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("escalate_human");
  });

  it("UNSAFE strict runtime SOTA → escalate_human", () => {
    const d = applyPolicy(mkResult("UNSAFE", "SOTA"), DEFAULT_POLICIES.SOTA!, "strict", "runtime");
    expect(d.action).toBe("escalate_human");
  });

  it("UNSAFE permissive runtime Robuste → block (hard axiom not softened)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("block");
  });

  it("UNSAFE permissive runtime Profitable → log (soft axiom downgraded)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("UNSAFE permissive runtime AntiFragile → log (soft axiom downgraded)", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "AntiFragile"),
      DEFAULT_POLICIES.AntiFragile!,
      "permissive",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("UNSAFE audit_only → log regardless of axiom", () => {
    for (const axiom of Object.keys(DEFAULT_POLICIES)) {
      const d = applyPolicy(
        mkResult("UNSAFE", axiom),
        DEFAULT_POLICIES[axiom]!,
        "audit_only",
        "runtime",
      );
      expect(d.action).toBe("log");
    }
  });

  it("rationale includes counterexample when provided", () => {
    const d = applyPolicy(
      mkResult("UNSAFE", "Robuste", { counterexample: "child_budget=999" }),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.rationale).toContain("child_budget=999");
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN
// ---------------------------------------------------------------------------

describe("applyPolicy — UNKNOWN", () => {
  it("UNKNOWN strict runtime Robuste → escalate_human (hard axiom)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("escalate_human");
  });

  it("UNKNOWN strict runtime Institutionnel → escalate_human", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Institutionnel"),
      DEFAULT_POLICIES.Institutionnel!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("escalate_human");
  });

  it("UNKNOWN strict runtime Profitable → log (proceed_with_log policy)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("UNKNOWN strict runtime AntiFragile → log (proceed_with_log policy)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "AntiFragile"),
      DEFAULT_POLICIES.AntiFragile!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("UNKNOWN strict runtime SOTA → log (proceed_with_audit_log policy)", () => {
    const d = applyPolicy(mkResult("UNKNOWN", "SOTA"), DEFAULT_POLICIES.SOTA!, "strict", "runtime");
    expect(d.action).toBe("log");
  });

  it("UNKNOWN permissive runtime → log regardless of axiom", () => {
    for (const axiom of Object.keys(DEFAULT_POLICIES)) {
      const d = applyPolicy(
        mkResult("UNKNOWN", axiom),
        DEFAULT_POLICIES[axiom]!,
        "permissive",
        "runtime",
      );
      expect(d.action).toBe("log");
    }
  });

  it("UNKNOWN audit_only → log", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "audit_only",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("Tension Sprint C: UNKNOWN skill_ingestion strict → block", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "skill_ingestion",
    );
    expect(d.action).toBe("block");
    expect(d.rationale).toMatch(/Tension Sprint C/);
  });

  it("Tension Sprint C: UNKNOWN skill_ingestion permissive → block (mode ignored)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "permissive",
      "skill_ingestion",
    );
    expect(d.action).toBe("block");
  });

  it("Tension Sprint C: UNKNOWN skill_ingestion audit_only → block (audit_only bypassed)", () => {
    const d = applyPolicy(
      mkResult("UNKNOWN", "AntiFragile"),
      DEFAULT_POLICIES.AntiFragile!,
      "audit_only",
      "skill_ingestion",
    );
    expect(d.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// SKIPPED
// ---------------------------------------------------------------------------

describe("applyPolicy — SKIPPED", () => {
  it("SKIPPED always returns log in strict runtime", () => {
    const d = applyPolicy(
      mkResult("SKIPPED", "Robuste"),
      DEFAULT_POLICIES.Robuste!,
      "strict",
      "runtime",
    );
    expect(d.action).toBe("log");
  });

  it("SKIPPED always returns log in skill_ingestion (Tension Sprint C skipped)", () => {
    const d = applyPolicy(
      mkResult("SKIPPED", "Profitable"),
      DEFAULT_POLICIES.Profitable!,
      "strict",
      "skill_ingestion",
    );
    expect(d.action).toBe("log");
  });

  it("SKIPPED rationale mentions the axiom name", () => {
    const d = applyPolicy(mkResult("SKIPPED", "SOTA"), DEFAULT_POLICIES.SOTA!, "strict", "runtime");
    expect(d.rationale).toContain("SOTA");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_POLICIES data integrity
// ---------------------------------------------------------------------------

describe("DEFAULT_POLICIES — data integrity", () => {
  it("exports exactly 5 axiom policies", () => {
    expect(Object.keys(DEFAULT_POLICIES)).toHaveLength(5);
  });

  it("every policy has onSafe === 'proceed'", () => {
    for (const key of Object.keys(DEFAULT_POLICIES)) {
      expect(DEFAULT_POLICIES[key]!.onSafe).toBe("proceed");
    }
  });

  it("every policy has skillLoopStrict === true", () => {
    for (const key of Object.keys(DEFAULT_POLICIES)) {
      expect(DEFAULT_POLICIES[key]!.skillLoopStrict).toBe(true);
    }
  });

  it("Robuste policy blocks on UNSAFE", () => {
    expect(DEFAULT_POLICIES.Robuste!.onUnsafe).toBe("block");
  });

  it("Institutionnel policy blocks on UNSAFE", () => {
    expect(DEFAULT_POLICIES.Institutionnel!.onUnsafe).toBe("block");
  });

  it("SOTA policy escalates on UNSAFE", () => {
    expect(DEFAULT_POLICIES.SOTA!.onUnsafe).toBe("escalate_human");
  });

  it("AntiFragile policy escalates on UNSAFE", () => {
    expect(DEFAULT_POLICIES.AntiFragile!.onUnsafe).toBe("escalate_human");
  });

  it("Profitable policy escalates on UNSAFE", () => {
    expect(DEFAULT_POLICIES.Profitable!.onUnsafe).toBe("escalate_human");
  });

  it("Robuste onUnknown is escalate_human", () => {
    expect(DEFAULT_POLICIES.Robuste!.onUnknown).toBe("escalate_human");
  });

  it("SOTA onUnknown is proceed_with_audit_log", () => {
    expect(DEFAULT_POLICIES.SOTA!.onUnknown).toBe("proceed_with_audit_log");
  });

  it("Profitable onUnknown is proceed_with_log", () => {
    expect(DEFAULT_POLICIES.Profitable!.onUnknown).toBe("proceed_with_log");
  });

  it("all timeout_ms values are positive integers", () => {
    for (const key of Object.keys(DEFAULT_POLICIES)) {
      const t = DEFAULT_POLICIES[key]!.timeout_ms;
      expect(t).toBeGreaterThan(0);
      expect(Number.isInteger(t)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Custom AxiomPolicy override (arbitrary policy object)
// ---------------------------------------------------------------------------

describe("applyPolicy — custom policy", () => {
  it("custom onUnsafe=block is respected for UNSAFE strict", () => {
    const policy: AxiomPolicy = {
      onSafe: "proceed",
      onUnsafe: "block",
      onUnknown: "proceed_with_log",
      timeout_ms: 500,
      skillLoopStrict: true,
    };
    const d = applyPolicy(mkResult("UNSAFE", "Custom"), policy, "strict", "runtime");
    expect(d.action).toBe("block");
  });

  it("custom onUnknown=proceed_with_log maps UNKNOWN to log", () => {
    const policy: AxiomPolicy = {
      onSafe: "proceed",
      onUnsafe: "block",
      onUnknown: "proceed_with_log",
      timeout_ms: 500,
      skillLoopStrict: true,
    };
    const d = applyPolicy(mkResult("UNKNOWN", "Custom"), policy, "strict", "runtime");
    expect(d.action).toBe("log");
  });

  it("custom onUnknown=escalate_human maps UNKNOWN to escalate_human in runtime", () => {
    const policy: AxiomPolicy = {
      onSafe: "proceed",
      onUnsafe: "escalate_human",
      onUnknown: "escalate_human",
      timeout_ms: 500,
      skillLoopStrict: true,
    };
    const d = applyPolicy(mkResult("UNKNOWN", "Custom"), policy, "strict", "runtime");
    expect(d.action).toBe("escalate_human");
  });
});
