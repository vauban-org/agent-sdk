/**
 * minimal-loop wall-clock + max-steps stop conditions (sprint-737).
 *
 * Verifies the SOTA antifragile backstop: an autonomous loop that never
 * finalises is bounded by maxWallClockMs (semantic, predictable) rather than
 * an arbitrary step cap. Also asserts loopDetail.reason distinguishes the
 * stop sub-reason.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/** Provider that ALWAYS calls a tool — the loop never finalises on its own. */
function makeNeverEndingProvider(delayMs = 0): ProviderRouter {
  return {
    async complete() {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        provider: "mock",
        model: "mock",
        content: "calling tool again",
        toolCalls: [{ id: `c${Math.random()}`, name: "noop", args: { n: Math.random() } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "noop",
    description: "no-op tool",
    parameters: z.object({ n: z.number() }).strict(),
    // Distinct output each call so the world-state hash never collides.
    execute: async (args) => ({ ok: true, echo: (args as { n: number }).n }),
  });
  return reg;
}

describe("minimal-loop wall-clock backstop (sprint-737)", () => {
  it("stops a never-ending loop via maxWallClockMs", async () => {
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeNeverEndingProvider(10),
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }), // unlimited steps
      disableLoopDetection: true, // no heuristic stops — only wall clock
      maxWallClockMs: 150,
    });
    const start = Date.now();
    const result = await loop.run("loop forever");
    const elapsed = Date.now() - start;

    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.loopDetail?.reason).toBe("max_time");
    // Bounded: should stop close to the 150ms ceiling, not run unbounded.
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it("stops via maxSteps when a step cap is set", async () => {
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeNeverEndingProvider(0),
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 3 }),
      disableLoopDetection: true,
    });
    const result = await loop.run("loop");
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.loopDetail?.reason).toBe("max_steps");
    expect(result.budgetFinal.stepCount).toBe(3);
  });

  it("stops via maxCostUsd once accumulated cost reaches the ceiling", async () => {
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeNeverEndingProvider(0),
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      maxCostUsd: 0.05,
      // Flat $0.02 per step → ceiling reached after 3 steps (0.00→0.06).
      costFn: () => 0.02,
    });
    const result = await loop.run("burn budget");
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.loopDetail?.reason).toBe("max_cost");
    // 3 steps accumulate 0.06 ≥ 0.05; the 4th iteration's top-of-loop check fires.
    expect(result.costUsd).toBeGreaterThanOrEqual(0.05);
  });

  it("maxCostUsd is inert without a costFn", async () => {
    let turn = 0;
    const provider: ProviderRouter = {
      async complete() {
        turn += 1;
        const done = turn >= 2;
        return {
          provider: "mock",
          model: "mock",
          content: done ? "done" : "more",
          toolCalls: done ? [] : [{ id: `c${turn}`, name: "noop", args: { n: turn } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      maxCostUsd: 0.0001, // tiny ceiling — but no costFn → never enforced
    });
    const result = await loop.run("finish naturally");
    expect(result.stopReason).toBe("complete");
    expect(result.costUsd).toBe(0);
  });

  it("maxWallClockMs=0 means unlimited (cap inert)", async () => {
    // A provider that finalises on turn 3 — proves a 0 cap does not abort.
    let turn = 0;
    const provider: ProviderRouter = {
      async complete() {
        turn += 1;
        const done = turn >= 3;
        return {
          provider: "mock",
          model: "mock",
          content: done ? "done" : "more",
          toolCalls: done ? [] : [{ id: `c${turn}`, name: "noop", args: { n: turn } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      maxWallClockMs: 0,
    });
    const result = await loop.run("finish naturally");
    expect(result.stopReason).toBe("complete");
  });
});
