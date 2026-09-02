/**
 * tests/verify-cost-gate.test.ts
 *
 * cost-gate verifier ; the faithful-steal proof. The PARITY suite replays the
 * exact fixtures from governance/policy/opa-policies/cost-gate_test.rego and
 * asserts costGateAllow() returns the same allow/deny verdict the rego does, so
 * the TS port and the OPA policy cannot drift. Plus lens shape + battery wiring.
 */

import { describe, expect, it } from "vitest";
import { runVerifierBattery } from "../src/compute/battery/battery.js";
import { RecordedClock } from "../src/replay/clock.js";
import {
  type AgentRunDeclaration,
  COST_GATE_ADR,
  costGateAllow,
  costGateDeny,
  costGateLens,
} from "../src/verify/verifiers/cost-gate.js";

// ─── Parity fixtures (verbatim from cost-gate_test.rego) ────────────────────────

interface Fixture {
  readonly name: string;
  readonly expectAllow: boolean;
  readonly decl: AgentRunDeclaration;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "test_allow_valid_xs_haiku",
    expectAllow: true,
    decl: {
      session_id: "valid-xs-001",
      started_at: "2026-05-19T14:30:00Z",
      intention: "Quick lookup of country list from gmrtd PKD",
      tier: "XS",
      model: "claude-haiku-4-5",
      token_budget_max: 8000,
      max_iterations: 3,
      approved_by: "self",
    },
  },
  {
    name: "test_allow_valid_l_opus_with_rollback",
    expectAllow: true,
    decl: {
      session_id: "valid-l-001",
      started_at: "2026-05-19T14:30:00Z",
      intention: "Refactor Cairo secp384r1 worktree, fix invariant",
      tier: "L",
      model: "claude-opus-4-8",
      token_budget_max: 80000,
      max_iterations: 8,
      max_iterations_justification: "Multi-file Cairo refactor with cross-contract invariants",
      rollback_plan:
        "git worktree remove --force on push failure, escalate founder on test failure",
      approved_by: "founder",
    },
  },
  {
    name: "test_deny_xs_opus",
    expectAllow: false,
    decl: {
      session_id: "bad-xs-opus",
      intention: "Trivial lookup but using Opus by mistake",
      tier: "XS",
      model: "claude-opus-4-8",
      token_budget_max: 8000,
      max_iterations: 3,
      approved_by: "self",
    },
  },
  {
    // Regression 2026-09-01. The table listed an exact family-4 Opus identifier
    // while the Opus in service belonged to family 5, so the XS/S gate refused a
    // retired model and let the live one through. Every existing fixture still
    // passed, because they all used the same stale identifier: consistency between
    // copies is not correctness against the world. This case fails if anyone goes
    // back to exact identifiers, and it does not go stale at the next family.
    name: "test_deny_xs_opus_current_family",
    expectAllow: false,
    decl: {
      session_id: "bad-xs-opus-5",
      intention: "Trivial lookup on the Opus actually in service, not a retired id",
      tier: "XS",
      model: "claude-opus-5",
      token_budget_max: 8000,
      max_iterations: 3,
      approved_by: "self",
    },
  },
  {
    // The counterpart: a non-forbidden family must still pass, so the prefix does
    // not over-block. Without this, "forbid everything" would satisfy the test above.
    name: "test_allow_xs_sonnet_allowed_family",
    expectAllow: true,
    decl: {
      session_id: "ok-xs-sonnet",
      intention: "Trivial lookup on a model allowed at tier XS",
      tier: "XS",
      model: "claude-sonnet-5",
      token_budget_max: 8000,
      max_iterations: 3,
      approved_by: "self",
    },
  },
  {
    name: "test_deny_s_opus",
    expectAllow: false,
    decl: {
      session_id: "bad-s-opus",
      intention: "Small task but using Opus, forbidden by R7.2",
      tier: "S",
      model: "claude-opus-4-8",
      token_budget_max: 20000,
      max_iterations: 3,
      approved_by: "self",
    },
  },
  {
    name: "test_deny_budget_over_cap",
    expectAllow: false,
    decl: {
      session_id: "bad-budget",
      intention: "M tier but requesting 100k budget",
      tier: "M",
      model: "claude-sonnet-4-6",
      token_budget_max: 100000,
      max_iterations: 5,
      approved_by: "founder",
      rollback_plan: "stash changes and abort",
    },
  },
  {
    name: "test_deny_iterations_without_justification",
    expectAllow: false,
    decl: {
      session_id: "bad-iter",
      intention: "Trying to override max_iterations without justifying",
      tier: "M",
      model: "claude-sonnet-4-6",
      token_budget_max: 40000,
      max_iterations: 10,
      approved_by: "founder",
      rollback_plan: "git reset --hard HEAD~10",
    },
  },
  {
    name: "test_deny_self_on_M",
    expectAllow: false,
    decl: {
      session_id: "bad-self-M",
      intention: "M tier trying to self-approve, forbidden",
      tier: "M",
      model: "claude-sonnet-4-6",
      token_budget_max: 40000,
      max_iterations: 5,
      approved_by: "self",
      rollback_plan: "stash",
    },
  },
  {
    name: "test_deny_no_rollback_on_L",
    expectAllow: false,
    decl: {
      session_id: "bad-no-rollback",
      intention: "L tier without rollback_plan",
      tier: "L",
      model: "claude-opus-4-8",
      token_budget_max: 80000,
      max_iterations: 5,
      approved_by: "founder",
    },
  },
  {
    name: "test_deny_worker_with_agent_tool",
    expectAllow: false,
    decl: {
      session_id: "bad-worker-agent",
      intention: "Worker trying to spawn its own subagents, forbidden R-4",
      tier: "M",
      model: "claude-sonnet-4-6",
      token_budget_max: 40000,
      max_iterations: 5,
      approved_by: "founder",
      rollback_plan: "abort",
      extends_session: "parent-coord-001",
      tools_required: ["Read", "Edit", "Agent"],
    },
  },
  {
    name: "test_deny_short_intention",
    expectAllow: false,
    decl: {
      session_id: "bad-short",
      intention: "too short",
      tier: "S",
      model: "claude-sonnet-4-6",
      token_budget_max: 20000,
      max_iterations: 3,
      approved_by: "self",
    },
  },
  {
    name: "test_deny_unknown_tier",
    expectAllow: false,
    decl: {
      session_id: "bad-tier",
      intention: "Trying invalid tier value",
      tier: "XXL",
      model: "claude-opus-4-8",
      token_budget_max: 200000,
      max_iterations: 5,
      approved_by: "founder",
      rollback_plan: "abort",
    },
  },
];

describe("cost-gate ; parity with cost-gate.rego fixtures", () => {
  for (const f of FIXTURES) {
    it(`${f.name} ⇒ ${f.expectAllow ? "allow" : "deny"}`, () => {
      expect(costGateAllow(f.decl)).toBe(f.expectAllow);
    });
  }

  // 13 = the 11 rego fixtures plus the two family-matching regressions added
  // 2026-09-01, which have identical counterparts in cost-gate_test.rego
  // (test_deny_xs_opus_famille_courante, test_allow_xs_sonnet_famille_autorisee).
  // This count assertion is what caught the drift when the two were added: it is
  // doing its job, so keep it in step rather than loosening it.
  it("covers all 13 rego fixtures (3 allow, 10 deny)", () => {
    expect(FIXTURES).toHaveLength(13);
    expect(FIXTURES.filter((f) => f.expectAllow)).toHaveLength(3);
    expect(FIXTURES.filter((f) => !f.expectAllow)).toHaveLength(10);
  });
});

describe("cost-gate ; per-rule sanity", () => {
  const base: AgentRunDeclaration = {
    session_id: "s",
    intention: "a valid intention of sufficient length",
    tier: "M",
    model: "claude-sonnet-4-6",
    token_budget_max: 40000,
    max_iterations: 5,
    approved_by: "founder",
    rollback_plan: "abort",
  };

  it("base declaration allows", () => expect(costGateAllow(base)).toBe(true));

  it("DENY-2 fires past the cap", () =>
    expect(costGateDeny({ ...base, token_budget_max: 40001 })[0]).toMatch(/exceeds tier/));

  it("DENY-3 fires on iterations without justification", () =>
    expect(costGateDeny({ ...base, max_iterations: 6 })[0]).toMatch(/max_iterations/));

  it("multiple violations accumulate", () => {
    const denies = costGateDeny({
      ...base,
      token_budget_max: 99999,
      max_iterations: 9,
    });
    expect(denies.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cost-gate ; lens + battery", () => {
  it("builds a hard affirm rule lens", () => {
    const l = costGateLens();
    expect(l.verifier.name).toBe("cost-gate");
    expect(l.polarity).toBe("affirm");
    expect(l.criticality).toBe("hard");
    expect(l.signature.engine).toBe("rule");
  });

  it("kills the denied declaration and accepts the allowed one", async () => {
    const allowed: AgentRunDeclaration = {
      session_id: "ok",
      intention: "a sufficiently long and valid intention",
      tier: "S",
      model: "claude-sonnet-4-6",
      token_budget_max: 20000,
      max_iterations: 3,
      approved_by: "self",
    };
    const denied: AgentRunDeclaration = {
      ...allowed,
      model: "claude-opus-4-8",
    }; // opus on S = DENY-1

    const d = await runVerifierBattery<AgentRunDeclaration>(
      "pick a compliant run declaration",
      [denied, allowed],
      [costGateLens()],
      {
        clock: new RecordedClock([1_700_000_000_000, 1_700_000_000_050]),
        runId: "cost-gate-run-001",
        adrEco: COST_GATE_ADR,
      },
    );

    expect(d.acceptedIndex).toBe(1);
    expect(d.verdicts[0].killed).toBe(true);
    expect(d.rejected.find((r) => r.candidateIndex === 0)?.reason).toMatch(/^killed:/);
  });
});
