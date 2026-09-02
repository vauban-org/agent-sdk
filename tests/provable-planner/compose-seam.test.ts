/**
 * composeActionGates ; the ADR-ECO-092 preste seam consumer #2.
 *
 * Proves the fail-closed AND-composition of provableActionGate + batteryActionGate,
 * and its genuine injection into the minimal-loop `actionGate?` seam:
 *   (a) both gates are evaluated before dispatch ;
 *   (b) if EITHER gate denies, the tool call is skipped fail-closed and the loop
 *       continues ;
 *   (c) the provable decision audit step is emitted (preserved through composition) ;
 *   (d) with NO gate injected, the loop is byte-for-byte unchanged.
 *
 * Three-tier per build-quality-mandate.md:
 *   - unit        : composeActionGates allow/deny/throw/aggregate/guard, no loop ;
 *   - integration : composed gate evaluated by AgentLoop before dispatch ;
 *   - e2e         : full loop run, deny skips the call and the loop finalises clean,
 *                   then the no-gate baseline is identical.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBudgetState } from "../../src/budget/budget-state.js";
import { batteryActionGate } from "../../src/compute/battery/action-gate.js";
import type { BatteryLens } from "../../src/compute/battery/types.js";
// Import the loop + ports from their source modules (NOT ../../src/index.js):
// the index barrel transitively pulls in skill-manifest -> @vauban-org/proof-core,
// whose dist is unbuilt in a fresh worktree ; the direct path keeps the test hermetic.
import { AgentLoop } from "../../src/loop/minimal-loop.js";
import type {
  ActionGate,
  ActionGateCall,
  ActionGateVerdict,
} from "../../src/permissions/action-gate.js";
import { composeActionGates } from "../../src/permissions/action-gate.js";
import {
  type DeterministicPolicy,
  type GateDecisionCore,
  provableActionGate,
} from "../../src/provable-planner/index.js";
import { RealClock } from "../../src/replay/clock.js";
import type { ProviderRouter } from "../../src/router/provider-router.js";
import { ToolRegistryImpl } from "../../src/tools/index.js";
import type { ToolRegistry } from "../../src/tools/types.js";

const ADR = "ADR-ECO-092";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Provable policy: deny any tool whose name starts with "write", else allow. */
const provablePolicy: DeterministicPolicy<ActionGateCall, GateDecisionCore> = (call) =>
  call.toolName.startsWith("write")
    ? { allowed: false, reason: "provable: write tool denied" }
    : { allowed: true, reason: "provable: ok" };

const makeProvableGate = (): ActionGate =>
  provableActionGate({
    policyId: "preste.tool-allow",
    policyVersion: "v1",
    adrEco: ADR,
    policy: provablePolicy,
  });

/** Battery lens: only `read_file` / `fetch_rss` pass (hard affirm). */
const allowlistLens: BatteryLens<ActionGateCall> = {
  verifier: {
    name: "tool-allowlist",
    evaluate: (c) => {
      const safe = ["read_file", "fetch_rss"].includes(c.toolName);
      return {
        score: safe ? 1 : 0,
        rationale: safe ? "tool on allowlist" : `tool ${c.toolName} not allowed`,
      };
    },
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

const makeBatteryGate = (): ActionGate =>
  batteryActionGate<ActionGateCall>({
    lenses: [allowlistLens],
    adrEco: ADR,
    // RealClock: the loop verifies the same battery gate multiple times across a
    // run, so a fixed-length RecordedClock would exhaust ; tests assert no
    // timestamp VALUES, only allow/deny + audit-step presence.
    clock: new RealClock(),
    runId: "compose-test",
  });

function makeMockProvider(toolCalls: { name: string; args: unknown }[][]): ProviderRouter {
  let i = 0;
  return {
    async complete() {
      const calls = toolCalls[i] ?? [];
      i += 1;
      return {
        provider: "mock",
        model: "mock",
        content: calls.length === 0 ? "done" : "calling tool",
        toolCalls: calls.map((c) => ({
          id: `c${i}-${c.name}`,
          name: c.name,
          args: c.args,
        })),
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function makeRegistry(executed: string[]): ToolRegistry {
  const reg = new ToolRegistryImpl();
  for (const name of ["read_file", "fetch_rss", "write_file", "run_bash"]) {
    reg.register({
      name,
      description: name,
      parameters: z.object({}).strict(),
      execute: async () => {
        executed.push(name);
        return { ok: true };
      },
    });
  }
  return reg;
}

// ─── Unit ; composeActionGates in isolation (no loop) ─────────────────────────

describe("composeActionGates (unit)", () => {
  it("allows iff EVERY gate allows; preserves every defined audit step", async () => {
    const composed = composeActionGates(makeProvableGate(), makeBatteryGate());
    const v = await composed.verify({
      toolName: "read_file",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(true);
    // both sub-gates emit an audit step => aggregated array of length 2.
    expect(Array.isArray(v.auditStep)).toBe(true);
    expect((v.auditStep as unknown[]).length).toBe(2);
  });

  it("denies fail-closed if the PROVABLE gate denies (battery would allow)", async () => {
    // write_file: provable denies; battery allowlist also rejects it ; both deny.
    const composed = composeActionGates(makeProvableGate(), makeBatteryGate());
    const v = await composed.verify({
      toolName: "write_file",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("provable: write tool denied");
  });

  it("denies fail-closed if ONLY the BATTERY gate denies (provable allows)", async () => {
    // run_bash: provable allows (not a write), battery allowlist rejects it.
    const composed = composeActionGates(makeProvableGate(), makeBatteryGate());
    const v = await composed.verify({
      toolName: "run_bash",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("denied");
    expect(v.reason).not.toContain("provable: write");
  });

  it("evaluates ALL gates (no short-circuit) so each audit step is produced", async () => {
    const order: string[] = [];
    const gateA: ActionGate = {
      verify(): ActionGateVerdict {
        order.push("A");
        return { allowed: false, reason: "A denies", auditStep: { tag: "A" } };
      },
    };
    const gateB: ActionGate = {
      verify(): ActionGateVerdict {
        order.push("B");
        return { allowed: true, reason: "B ok", auditStep: { tag: "B" } };
      },
    };
    const v = await composeActionGates(gateA, gateB).verify({
      toolName: "x",
      args: {},
      budgetUsed: 0,
    });
    expect(order).toEqual(["A", "B"]); // B still ran after A denied
    expect(v.allowed).toBe(false);
    expect(v.auditStep).toEqual([{ tag: "A" }, { tag: "B" }]);
  });

  it("treats a THROWING sub-gate as a deny (fail-closed), never propagates", async () => {
    const boom: ActionGate = {
      verify() {
        throw new Error("gate exploded");
      },
    };
    const v = await composeActionGates(boom, makeProvableGate()).verify({
      toolName: "read_file",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("fail-closed");
    expect(v.reason).toContain("gate exploded");
  });

  it("omits auditStep when no sub-gate produced one (bare-gate parity)", async () => {
    const bare: ActionGate = {
      verify: () => ({ allowed: true, reason: "ok" }),
    };
    const v = await composeActionGates(bare, bare).verify({
      toolName: "x",
      args: {},
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(true);
    expect(v.auditStep).toBeUndefined();
  });

  it("rejects an empty composition (an empty AND would allow everything)", () => {
    expect(() => composeActionGates()).toThrow(/at least one gate/);
  });

  // `kind` (ADR-ECO-135) : the discriminator a denying sub-gate can attach so
  // a host tells one denying gate's verdict from another's without parsing
  // `reason` — e.g. preste's posture gate (`posture_denied`) composed with
  // the governed battery gate. Additive : untouched for every existing gate.
  describe("kind propagation", () => {
    const denyWithKind = (kind: string): ActionGate => ({
      verify: () => ({ allowed: false, reason: `denied by ${kind}`, kind }),
    });
    const denyNoKind: ActionGate = {
      verify: () => ({ allowed: false, reason: "denied, no kind" }),
    };
    const allow: ActionGate = { verify: () => ({ allowed: true, reason: "ok" }) };

    it("propagates the single distinct kind when exactly one denying gate declares one", async () => {
      const v = await composeActionGates(denyWithKind("posture_denied"), allow).verify({
        toolName: "x",
        args: {},
        budgetUsed: 0,
      });
      expect(v.allowed).toBe(false);
      expect(v.kind).toBe("posture_denied");
    });

    it("leaves kind unset when the denying gates disagree on it", async () => {
      const v = await composeActionGates(
        denyWithKind("posture_denied"),
        denyWithKind("action_denied"),
      ).verify({ toolName: "x", args: {}, budgetUsed: 0 });
      expect(v.allowed).toBe(false);
      expect(v.kind).toBeUndefined();
    });

    it("leaves kind unset when no denying gate declares one (today's default)", async () => {
      const v = await composeActionGates(denyNoKind, allow).verify({
        toolName: "x",
        args: {},
        budgetUsed: 0,
      });
      expect(v.allowed).toBe(false);
      expect(v.kind).toBeUndefined();
    });

    it("leaves kind unset on an allowed (non-denying) composite", async () => {
      const v = await composeActionGates(allow, allow).verify({
        toolName: "x",
        args: {},
        budgetUsed: 0,
      });
      expect(v.allowed).toBe(true);
      expect(v.kind).toBeUndefined();
    });
  });
});

// ─── Integration ; composed gate evaluated by AgentLoop before dispatch ───────

describe("composeActionGates × AgentLoop (integration)", () => {
  it("evaluates BOTH composed gates before a tool is dispatched", async () => {
    const provableSpy = vi.fn(makeProvableGate().verify);
    const batterySpy = vi.fn(makeBatteryGate().verify);
    const composed = composeActionGates({ verify: provableSpy }, { verify: batterySpy });

    const executed: string[] = [];
    const tools = makeRegistry(executed);
    const provider = makeMockProvider([[{ name: "read_file", args: {} }], []]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      actionGate: composed,
    });

    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    // both gates consulted, and only after both allowed did the tool execute.
    expect(provableSpy).toHaveBeenCalledTimes(1);
    expect(batterySpy).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(["read_file"]);
  });
});

// ─── E2E ; deny skips fail-closed, loop continues; no-gate baseline identical ──

describe("composeActionGates × AgentLoop (e2e)", () => {
  it("EITHER gate denying skips the call fail-closed; the loop continues", async () => {
    const composed = composeActionGates(makeProvableGate(), makeBatteryGate());
    const denied: Array<{ toolName: string; reason: string }> = [];
    const executed: string[] = [];
    const tools = makeRegistry(executed);
    // Turn 1: write_file (provable denies) + run_bash (battery denies) ; both skipped.
    // Turn 2: read_file (both allow) ; executes. Turn 3: finalise.
    const provider = makeMockProvider([
      [
        { name: "write_file", args: {} },
        { name: "run_bash", args: {} },
      ],
      [{ name: "read_file", args: {} }],
      [],
    ]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      actionGate: composed,
      onActionDenied: (e) => denied.push({ toolName: e.toolName, reason: e.reason }),
    });

    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    // The two denied calls never reached the tool registry ; only read_file ran.
    expect(executed).toEqual(["read_file"]);
    expect(denied.map((d) => d.toolName)).toEqual(["write_file", "run_bash"]);
    // Provable-origin deny carries the provable reason ; the audit step is emitted
    // (the composite auditStep is folded by the host ; here we assert the deny
    // surfaced the provable decision rationale).
    expect(denied[0].reason).toContain("provable: write tool denied");
  });

  it("with NO actionGate injected, the loop is unchanged (opt-in seam)", async () => {
    const executed: string[] = [];
    const tools = makeRegistry(executed);
    // write_file would be DENIED by the composed gate; with no gate it must run.
    const provider = makeMockProvider([[{ name: "write_file", args: {} }], []]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      // actionGate intentionally absent.
    });

    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    // No gate => no governance interception => the tool executes as before.
    expect(executed).toEqual(["write_file"]);
  });

  // `kind` (ADR-ECO-135) : a verdict's discriminator reaches BOTH the model
  // (as the `ERROR:` prefix, in place of the default "action_denied") and
  // the host's `onActionDenied` event, through a composed gate exactly like
  // preste's posture gate + optional governed battery.
  it("a denying kind reaches the model's ERROR prefix AND the onActionDenied event", async () => {
    // A single gate, NOT composed: composeActionGates' own reason-aggregation
    // format is covered above ; this test isolates ONE thing — that a gate's
    // `kind` + `reason` thread verbatim through the loop's ERROR prefix and
    // the onActionDenied event, exactly as preste's posture gate relies on.
    const kindedDeny: ActionGate = {
      verify: () => ({ allowed: false, reason: "write_file — refused", kind: "posture_denied" }),
    };
    const executed: string[] = [];
    const tools = makeRegistry(executed);
    const requests: Array<{ messages: { role: string; content: string }[] }> = [];
    const provider: ProviderRouter = {
      async complete(request) {
        requests.push(request);
        return requests.length === 1
          ? {
              provider: "mock",
              model: "mock",
              content: "calling tool",
              toolCalls: [{ id: "c1", name: "write_file", args: {} }],
              usage: { inputTokens: 1, outputTokens: 1 },
              latencyMs: 0,
            }
          : {
              provider: "mock",
              model: "mock",
              content: "done",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1 },
              latencyMs: 0,
            };
      },
    };
    const denied: Array<{ toolName: string; kind?: string }> = [];
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      actionGate: kindedDeny,
      onActionDenied: (e) => denied.push({ toolName: e.toolName, kind: e.kind }),
    });

    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    expect(executed).toEqual([]); // never dispatched
    expect(denied).toEqual([{ toolName: "write_file", kind: "posture_denied" }]);
    // The SECOND request carries the tool-result message the first call produced.
    const toolResult = requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toBe("ERROR: posture_denied:write_file — refused");
  });
});
