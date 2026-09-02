/**
 * tests/delegate.test.ts
 *
 * delegate() ; the governed sub-agent delegation primitive (ADR-ECO-076).
 * Deterministic, no LLM. Verifies the four governance properties plus the
 * attenuation invariant (child capability is a strict subset of the parent),
 * the fail-closed per-call ActionGate, and byte-identical replay.
 */

import { describe, expect, it } from "vitest";
import {
  CHILD_SYSTEM_PROMPT,
  DEFAULT_CHILD_MAX_STEPS,
  DELEGATION_ADR,
  baseToolName,
  delegate,
} from "../src/delegation/delegate.js";
import { RecordedClock } from "../src/replay/clock.js";

const HEX64 = /^[0-9a-f]{64}$/;

// A generous recorded clock: delegate() spends 2 ticks on the grant battery and
// 2 more per ActionGate.verify() call (all share the injected clock).
const clock = () =>
  new RecordedClock(Array.from({ length: 40 }, (_, i) => 1_700_000_000_000 + i * 10));

describe("delegate() attenuation", () => {
  it("default surface drops recursion + orientation, keeps a strict subset of the parent", async () => {
    const parentTools = [
      "read_file",
      "fetch_url",
      "write_file",
      "spawn_agent", // recursion -> dropped
      "spawn_parallel_agents", // recursion -> dropped
      "spawn_dag", // recursion -> dropped
      "get_active_sprints", // orientation -> dropped
      "mcp__citadel__get_drift_signals", // orientation (after prefix) -> dropped
    ];
    const plan = await delegate({
      parentTools,
      task: "research the STRK unlock schedule",
      clock: clock(),
      runId: "loop-1",
    });

    expect(plan.allowed).toBe(true);
    expect(plan.attenuatedTools).toEqual(["read_file", "fetch_url", "write_file"]);
    // strict subset: every child tool is held by the parent
    for (const t of plan.attenuatedTools) expect(parentTools).toContain(t);
    expect(plan.systemPrompt).toBe(CHILD_SYSTEM_PROMPT);
    expect(plan.maxSteps).toBe(DEFAULT_CHILD_MAX_STEPS);
  });

  it("a default child never gets spawn_dag in its capability set, so it cannot spawn a grandchild with a self-chosen grant", async () => {
    // Mitigation for the verified gap (2026-08-05): spawn_dag was missing from
    // NON_DELEGABLE_TOOLS, so a default child inherited it and could call it
    // with a node `tools` list of its own choosing, spawning a grandchild with
    // whatever capability that node granted -- unbounded recursion with no
    // explicit grant anywhere in the chain.
    const plan = await delegate({
      parentTools: ["read_file", "spawn_dag"],
      task: "research",
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.allowed).toBe(true);
    expect(plan.attenuatedTools).not.toContain("spawn_dag");
    // The per-call ActionGate also fail-closed denies a call to a tool the
    // plan never granted, so even a direct call attempt cannot spawn further.
    const verdict = await plan.actionGate.verify({
      toolName: "spawn_dag",
      args: { nodes: [{ id: "n1", task: "x", tools: ["write_file", "run_bash"] }] },
      budgetUsed: 0,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("honours an explicit grant but removes recursion and intersects with the parent", async () => {
    const plan = await delegate({
      parentTools: ["read_file", "fetch_url", "get_active_sprints"],
      task: "summarize today's sprints",
      grant: {
        tools: ["read_file", "get_active_sprints", "spawn_agent"],
        maxSteps: 12,
      },
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.allowed).toBe(true);
    // recursion dropped; orientation tool KEPT because explicitly granted + in parent
    expect(plan.attenuatedTools).toEqual(["read_file", "get_active_sprints"]);
    expect(plan.attenuatedTools).not.toContain("spawn_agent");
    expect(plan.maxSteps).toBe(12);
  });

  it("fails closed on escalation: a requested tool the parent lacks denies the plan", async () => {
    const plan = await delegate({
      parentTools: ["read_file"],
      task: "do the thing",
      grant: { tools: ["read_file", "run_bash"] }, // run_bash not held by parent
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.allowed).toBe(false);
    expect(plan.attenuatedTools).toEqual([]);
    expect(plan.reason).toMatch(/run_bash/);
    expect(plan.auditStep).toBeDefined();
  });
});

describe("delegate() governed audit step (4 properties)", () => {
  it("emits exactly one guard audit step with a sha256 outputHash", async () => {
    const plan = await delegate({
      parentTools: ["read_file"],
      task: "t",
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.auditStep).toBeDefined();
    expect(plan.auditStep.phase).toBe("guard");
    expect(plan.auditStep.type).toBe("guard_check");
    expect(plan.auditStep.outputHash).toMatch(HEX64);
    expect(plan.auditStep.runId).toBe("loop-1");
  });

  it("defaults adrEco to ADR-ECO-076 and propagates the battery guard on empty adrEco", async () => {
    // default path works (no throw)
    await expect(
      delegate({
        parentTools: ["read_file"],
        task: "t",
        clock: clock(),
        runId: "r",
      }),
    ).resolves.toBeDefined();
    expect(DELEGATION_ADR).toBe("ADR-ECO-076");
    // an explicit empty adrEco must propagate the battery's cargo-cult guard
    await expect(
      delegate({
        parentTools: ["read_file"],
        task: "t",
        clock: clock(),
        runId: "r",
        adrEco: "",
      }),
    ).rejects.toThrow(/adrEco/);
  });

  it("replays byte-identical: same inputs + recorded clock -> identical audit outputHash", async () => {
    const input = {
      parentTools: ["read_file", "fetch_url"],
      task: "research",
      runId: "loop-1",
    } as const;
    const a = await delegate({ ...input, clock: clock() });
    const b = await delegate({ ...input, clock: clock() });
    expect(a.auditStep.outputHash).toBe(b.auditStep.outputHash);
  });
});

describe("delegate() fail-closed per-call ActionGate", () => {
  it("allows a delegated tool and denies fail-closed an undelegated one", async () => {
    const plan = await delegate({
      parentTools: ["read_file", "fetch_url"],
      task: "t",
      clock: clock(),
      runId: "loop-1",
    });
    const ok = await plan.actionGate.verify({
      toolName: "read_file",
      args: {},
      budgetUsed: 0,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.auditStep).toBeDefined();

    const bad = await plan.actionGate.verify({
      toolName: "run_bash",
      args: {},
      budgetUsed: 0,
    });
    expect(bad.allowed).toBe(false);
  });

  it("a denied grant yields a gate that denies every call (no spawn)", async () => {
    const plan = await delegate({
      parentTools: ["read_file"],
      task: "t",
      grant: { tools: ["run_bash"] }, // escalation -> denied grant
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.allowed).toBe(false);
    const v = await plan.actionGate.verify({
      toolName: "read_file",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(false);
  });
});

describe("CHILD_SYSTEM_PROMPT teammate-message spotlighting clause (governed-teammates TM2)", () => {
  it("instructs the child to treat <external_data>-wrapped teammate bodies as data, never instructions", () => {
    expect(CHILD_SYSTEM_PROMPT).toContain("<external_data>");
    expect(CHILD_SYSTEM_PROMPT).toMatch(/teammate/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/data to read, never as/i);
  });
});

describe("baseToolName", () => {
  it("strips an mcp__<server>__ prefix and is a no-op otherwise", () => {
    expect(baseToolName("mcp__citadel__get_drift_signals")).toBe("get_drift_signals");
    expect(baseToolName("mcp__command-center__get_daily_digest")).toBe("get_daily_digest");
    expect(baseToolName("read_file")).toBe("read_file");
  });
});

describe("delegate() dangerous-tool attenuation", () => {
  it("attenuates dangerous tools out of the DEFAULT surface (child never silently runs them)", async () => {
    const plan = await delegate({
      parentTools: ["read_file", "run_bash", "delete_repo"],
      task: "research",
      dangerousTools: ["run_bash", "delete_repo"],
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.allowed).toBe(true);
    expect(plan.attenuatedTools).toEqual(["read_file"]);
    const v = await plan.actionGate.verify({
      toolName: "run_bash",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(false);
  });

  it("allows a dangerous tool ONLY via an explicit grant (deliberate, audited)", async () => {
    const plan = await delegate({
      parentTools: ["read_file", "run_bash"],
      task: "run the build",
      grant: { tools: ["run_bash"] },
      dangerousTools: ["run_bash"],
      clock: clock(),
      runId: "loop-1",
    });
    expect(plan.allowed).toBe(true);
    expect(plan.attenuatedTools).toContain("run_bash");
    const v = await plan.actionGate.verify({
      toolName: "run_bash",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(true);
  });
});
