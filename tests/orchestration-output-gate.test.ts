/**
 * tests/orchestration-output-gate.test.ts
 *
 * The CC tier-gate : Agent.outputGate verifies a successfully-completed cycle's
 * output BEFORE the run is accepted (a producer cannot "commit" until the
 * orchestrator's verifiers pass). Fail-closed : a denied verdict yields
 * stopReason "blocked" + empty finalMessage. Symmetric to the preste pre-act
 * ActionGate (loop/minimal-loop.ts). Deterministic, no LLM.
 */

import { describe, expect, it } from "vitest";
import { batteryActionGate } from "../src/compute/battery/action-gate.js";
import type { BatteryLens } from "../src/compute/battery/types.js";
import { type AgentConfig, createAgent } from "../src/orchestration/agent.js";
import type { ActionGate, ActionGateCall } from "../src/permissions/action-gate.js";
import { RecordedClock } from "../src/replay/clock.js";
import type { AgentCycleResult, AgentStrategy } from "../src/strategies/types.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function stubStrategy(
  finalMessage: string,
  stopReason: AgentCycleResult["stopReason"] = "complete",
  stepCount = 1,
): AgentStrategy {
  return {
    name: "one-shot",
    run: async (): Promise<AgentCycleResult> => ({
      finalMessage,
      stopReason,
      stepCount,
      tokensUsed: { in: 5, out: 3 },
    }),
  };
}

function baseCfg(strategy: AgentStrategy): AgentConfig {
  return {
    agentId: "agent-test",
    systemPrompt: "p",
    tools: new ToolRegistryImpl(),
    strategy,
  };
}

describe("Agent output gate (CC tier-gate)", () => {
  it("passes through the cycle when no outputGate is configured (opt-in)", async () => {
    const agent = createAgent(baseCfg(stubStrategy("ok")));
    const r = await agent.run("task");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).toBe("ok");
  });

  it("accepts the cycle when the gate allows", async () => {
    const gate: ActionGate = {
      verify: () => ({ allowed: true, reason: "ok" }),
    };
    const agent = createAgent({
      ...baseCfg(stubStrategy("shipped")),
      outputGate: gate,
    });
    const r = await agent.run("task");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).toBe("shipped");
  });

  it("blocks fail-closed when the gate denies, surfacing reason + auditStep", async () => {
    const denials: Array<{
      runId: string;
      reason: string;
      auditStep?: unknown;
    }> = [];
    const gate: ActionGate = {
      verify: () => ({
        allowed: false,
        reason: "battery killed",
        auditStep: { phase: "guard" },
      }),
    };
    const agent = createAgent({
      ...baseCfg(stubStrategy("bad output")),
      outputGate: gate,
      onOutputDenied: (e) => denials.push(e),
    });
    const r = await agent.run("task");
    expect(r.stopReason).toBe("blocked");
    expect(r.finalMessage).toBe("");
    expect(r.stepCount).toBe(1); // work preserved on the blocked result
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason).toBe("battery killed");
    expect(denials[0]?.auditStep).toEqual({ phase: "guard" });
  });

  it("fails closed when the gate itself throws", async () => {
    const gate: ActionGate = {
      verify: () => {
        throw new Error("gate boom");
      },
    };
    const agent = createAgent({
      ...baseCfg(stubStrategy("x")),
      outputGate: gate,
    });
    const r = await agent.run("task");
    expect(r.stopReason).toBe("blocked");
    expect(r.finalMessage).toBe("");
  });

  it("does NOT gate a non-complete cycle (gate only guards a committed output)", async () => {
    let called = false;
    const gate: ActionGate = {
      verify: () => {
        called = true;
        return { allowed: true, reason: "ok" };
      },
    };
    const agent = createAgent({
      ...baseCfg(stubStrategy("", "error", 0)),
      outputGate: gate,
    });
    const r = await agent.run("task");
    expect(r.stopReason).toBe("error");
    expect(called).toBe(false);
  });

  it("end-to-end with a real batteryActionGate over the cycle output", async () => {
    // Hard affirm rule lens reading the projected cycle output (finalMessage) ;
    // only an "approved" output passes the governed battery.
    const lens: BatteryLens<string> = {
      verifier: {
        name: "output-allowlist",
        evaluate: (out) => ({
          score: out.includes("approved") ? 1 : 0,
          rationale: out.includes("approved") ? "output approved" : "output not approved",
        }),
      },
      polarity: "affirm",
      criticality: "hard",
      signature: { engine: "rule" },
    };
    const makeGate = (): ActionGate =>
      batteryActionGate<string>({
        lenses: [lens],
        adrEco: "ADR-ECO-068",
        clock: new RecordedClock([1_700_000_000_000, 1_700_000_000_050]),
        project: (call: ActionGateCall) =>
          String((call.args as { finalMessage: string }).finalMessage),
        runId: "cc-cycle-1",
      });

    const allowed = await createAgent({
      ...baseCfg(stubStrategy("this is approved")),
      outputGate: makeGate(),
    }).run("task");
    expect(allowed.stopReason).toBe("complete");
    expect(allowed.finalMessage).toBe("this is approved");

    const blocked = await createAgent({
      ...baseCfg(stubStrategy("this is junk")),
      outputGate: makeGate(),
    }).run("task");
    expect(blocked.stopReason).toBe("blocked");
    expect(blocked.finalMessage).toBe("");
  });
});
