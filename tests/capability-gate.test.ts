/**
 * Capability gate integration — minimal-loop and SdkAgentLoop both honour
 * a CapabilityGate by denying tool calls before dispatch.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  ALLOW_ALL_GATE,
  createBudgetState,
  type CapabilityGate,
  type ProviderRouter,
  type ToolRegistry,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function makeMockProvider(toolCalls: { name: string; args: unknown }[][]) {
  let i = 0;
  const provider: ProviderRouter = {
    async complete() {
      const calls = toolCalls[i] ?? [];
      i += 1;
      return {
        provider: "mock",
        model: "mock",
        content: calls.length === 0 ? "done" : "calling tool",
        toolCalls: calls.map((c) => ({
          id: `c${Math.random()}`,
          name: c.name,
          args: c.args,
        })),
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
  return provider;
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "fetch_rss",
    description: "fetch rss",
    parameters: z.object({}).strict(),
    execute: async () => ({ ok: true }),
  });
  reg.register({
    name: "fetch_github",
    description: "fetch gh",
    parameters: z.object({}).strict(),
    execute: async () => ({ ok: true }),
  });
  return reg;
}

describe("CapabilityGate × AgentLoop (minimal-loop)", () => {
  it("denies a tool call when gate refuses; loop fires onToolDenied", async () => {
    const denied: Array<{ toolName: string; reason: string }> = [];
    const gate: CapabilityGate = {
      async verify({ toolName }) {
        if (toolName === "fetch_github") {
          return { allowed: false, reason: "tool_not_in_scope" };
        }
        return { allowed: true };
      },
    };
    const tools = makeRegistry();
    const provider = makeMockProvider([
      [{ name: "fetch_github", args: {} }], // turn 1: denied
      [], // turn 2: model finalises
    ]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      capabilityGate: gate,
      onToolDenied: (e) =>
        denied.push({ toolName: e.toolName, reason: e.reason }),
    });
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    expect(denied).toEqual([
      { toolName: "fetch_github", reason: "tool_not_in_scope" },
    ]);
  });

  it("ALLOW_ALL_GATE permits every call", async () => {
    const tools = makeRegistry();
    const provider = makeMockProvider([
      [{ name: "fetch_rss", args: {} }],
      [],
    ]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      capabilityGate: ALLOW_ALL_GATE,
    });
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
  });

  it("a thrown gate is treated as a deny (defence-in-depth)", async () => {
    const denied: Array<string> = [];
    const gate: CapabilityGate = {
      verify() {
        throw new Error("gate exploded");
      },
    };
    const tools = makeRegistry();
    const provider = makeMockProvider([
      [{ name: "fetch_rss", args: {} }],
      [],
    ]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      capabilityGate: gate,
      onToolDenied: (e) => denied.push(e.reason),
    });
    const result = await loop.run("hello");
    // Loop completes (model sends no tools on turn 2) without panic.
    expect(result.stopReason).toBe("complete");
    expect(denied).toEqual(["gate_error"]);
  });

  it("budget accumulates across calls in the same loop", async () => {
    const seen: number[] = [];
    const gate: CapabilityGate = {
      verify({ budgetUsed }) {
        seen.push(budgetUsed);
        return { allowed: true };
      },
    };
    const tools = makeRegistry();
    const provider = makeMockProvider([
      [
        { name: "fetch_rss", args: {} },
        { name: "fetch_rss", args: {} },
      ],
      [],
    ]);
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools,
      budget: createBudgetState({}),
      capabilityGate: gate,
      costPerToolCallUsd: 0.1,
    });
    await loop.run("hello");
    expect(seen[0]).toBe(0);
    // After 1 call accounted, second sees ~0.1 (allow path increments).
    expect(seen[1]).toBeGreaterThan(0);
  });
});
