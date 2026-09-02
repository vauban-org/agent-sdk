/**
 * minimal-loop cooperative cancellation via AbortSignal.
 *
 * Three scenarios:
 *   1. Signal already aborted at run start -> zero provider calls, stopReason "aborted".
 *   2. Signal fired between steps -> loop stops at next top-of-iteration check.
 *   3. No abortSignal passed -> identical behavior to before (backward-compat).
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

/** Provider that always requests one more tool call; never finishes on its own. */
function makeNeverEndingProvider(delayMs = 0): ProviderRouter & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async complete() {
      callCount += 1;
      if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
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

/** Provider that completes (no tool calls) on the first call. */
function makeCompletingProvider(): ProviderRouter & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async complete() {
      callCount += 1;
      return {
        provider: "mock",
        model: "mock",
        content: "done",
        toolCalls: [],
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
    execute: async (args) => ({ ok: true, echo: (args as { n: number }).n }),
  });
  return reg;
}

describe("minimal-loop abortSignal (cooperative cancellation)", () => {
  it("aborts immediately when signal is already fired before run() — zero provider calls", async () => {
    const provider = makeNeverEndingProvider(0);
    const controller = new AbortController();
    controller.abort(); // abort BEFORE run()

    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      abortSignal: controller.signal,
    });

    const result = await loop.run("start");

    expect(result.stopReason).toBe("aborted");
    // Signal was already aborted: the check at the top of the first iteration
    // fires before the provider is ever called.
    expect(provider.callCount).toBe(0);
  });

  it("aborts between steps — provider not called again after abort fires", async () => {
    // Provider has a 30ms delay per call so we can fire the abort after step 1.
    const provider = makeNeverEndingProvider(30);
    const controller = new AbortController();

    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      abortSignal: controller.signal,
    });

    // Abort after 50ms — enough for exactly one provider round-trip (30ms) but
    // the second iteration's top-of-loop check fires and sees the aborted signal.
    setTimeout(() => controller.abort(), 50);

    const result = await loop.run("start");

    expect(result.stopReason).toBe("aborted");
    // At least one provider call completed (the first step ran); the loop did
    // not keep calling after the signal fired.
    expect(provider.callCount).toBeGreaterThanOrEqual(1);
    // The loop stopped; it did not run until budget exhaustion or any other reason.
  });

  it("backward-compat: no abortSignal -> loop completes normally", async () => {
    const provider = makeCompletingProvider();

    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: makeRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      // no abortSignal
    });

    const result = await loop.run("finish");

    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("done");
    expect(provider.callCount).toBe(1);
  });
});
