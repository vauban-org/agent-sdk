/**
 * AgentLoop × VetoChannel — the T6a veto window in the running loop.
 *
 * Verifies the full integration: tool.intent is emitted before every tool
 * call, the loop respects a veto by SKIPPING the tool, the vetoed result is
 * pushed into the conversation log so the LLM can adjust, and the absence
 * of a vetoChannel preserves the pre-T6a behaviour exactly.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  InMemoryVetoChannel,
  NOOP_SESSION_SINK,
  type ProviderRouter,
  type SessionEvent,
  type SessionEventSink,
  type ToolRegistry,
  createBudgetState,
  makeEvent,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Provider that calls `tool_under_test` once, then finalises. */
function makeOneToolThenDone(): ProviderRouter {
  let called = false;
  return {
    async complete() {
      if (!called) {
        called = true;
        return {
          provider: "mock",
          model: "mock",
          content: "calling the tool",
          toolCalls: [{ id: "c-1", name: "tool_under_test", args: { n: 1 } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        model: "mock",
        content: "all done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

interface InstrumentedRegistry {
  registry: ToolRegistry;
  toolExecutes: number;
}

function makeRegistry(): InstrumentedRegistry {
  let toolExecutes = 0;
  const registry = new ToolRegistryImpl();
  registry.register({
    name: "tool_under_test",
    description: "a test tool",
    parameters: z.object({ n: z.number() }).strict(),
    execute: async (args) => {
      toolExecutes++;
      return { ok: true, echo: (args as { n: number }).n };
    },
  });
  return {
    registry,
    get toolExecutes() {
      return toolExecutes;
    },
  } as unknown as InstrumentedRegistry;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentLoop × veto window (T6a)", () => {
  it("vetoes a tool call: tool.execute is NOT called, the log records [vetoed]", async () => {
    const reg = makeRegistry();
    const vetoChannel = new InMemoryVetoChannel();
    const events: SessionEvent[] = [];
    const sink: SessionEventSink = {
      emit(e: SessionEvent): void {
        events.push(e);
        // Race the loop: as soon as it asks "ok to run this?", we say no.
        if (e.type === "tool.intent") {
          vetoChannel.submit({
            callId: e.data.callId,
            by: "test-remote",
            reason: "do not run this in tests",
            at: new Date().toISOString(),
          });
        }
      },
    };

    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeOneToolThenDone(),
      tools: reg.registry,
      budget: createBudgetState({ maxSteps: 5 }),
      disableLoopDetection: true,
      eventSink: sink,
      vetoChannel,
      vetoWindowMs: 1_000,
    });
    const result = await loop.run("do something");

    expect(reg.toolExecutes).toBe(0);
    expect(events.some((e) => e.type === "tool.intent")).toBe(true);
    // The loop emits a tool.call.end whose body announces the veto so the
    // remote client and the on-disk trace can see what happened.
    const vetoedEnd = events.find(
      (e) => e.type === "tool.call.end" && e.data.resultPreview.includes("vetoed by test-remote"),
    );
    expect(vetoedEnd).toBeDefined();
    // The intent + the vetoed-end share the same callId (the loop's, not
    // the provider's mock id).
    if (vetoedEnd && vetoedEnd.type === "tool.call.end") {
      const intent = events.find(
        (e) => e.type === "tool.intent" && e.data.callId === vetoedEnd.data.callId,
      );
      expect(intent).toBeDefined();
    }
    expect(result.stopReason).toBe("complete");
  });

  it("with no vetoChannel, the loop runs the tool exactly as before T6a", async () => {
    const reg = makeRegistry();
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeOneToolThenDone(),
      tools: reg.registry,
      budget: createBudgetState({ maxSteps: 5 }),
      disableLoopDetection: true,
      eventSink: NOOP_SESSION_SINK,
      // no vetoChannel, no vetoWindowMs
    });
    await loop.run("do something");
    expect(reg.toolExecutes).toBe(1);
  });

  it("with vetoWindowMs=0 the loop never waits and runs the tool", async () => {
    const reg = makeRegistry();
    const events: SessionEvent[] = [];
    const sink: SessionEventSink = {
      emit(e): void {
        events.push(e);
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeOneToolThenDone(),
      tools: reg.registry,
      budget: createBudgetState({ maxSteps: 5 }),
      disableLoopDetection: true,
      eventSink: sink,
      vetoChannel: new InMemoryVetoChannel(),
      vetoWindowMs: 0, // gate disabled
    });
    await loop.run("do something");
    expect(reg.toolExecutes).toBe(1);
    expect(events.some((e) => e.type === "tool.intent")).toBe(false);
  });

  it("with a vetoWindow but no signal, the loop proceeds after the window", async () => {
    const reg = makeRegistry();
    const vetoChannel = new InMemoryVetoChannel();
    const start = Date.now();
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeOneToolThenDone(),
      tools: reg.registry,
      budget: createBudgetState({ maxSteps: 5 }),
      disableLoopDetection: true,
      eventSink: { emit: () => {} },
      vetoChannel,
      vetoWindowMs: 80, // waits up to 80ms, then proceeds
    });
    await loop.run("do something");
    expect(reg.toolExecutes).toBe(1);
    // Lower-bounded by the window; allow upper headroom for the second
    // LLM round trip + finalisation.
    expect(Date.now() - start).toBeGreaterThanOrEqual(75);
  });
});
