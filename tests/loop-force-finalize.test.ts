/**
 * minimal-loop forceFinalizeBeforeBudget — convert a tool-looping child's
 * budget_exhausted-with-no-answer into a produced final answer.
 *
 * Mirrors the Vera validation failure mode: a research child loops on a tool and
 * never finalises. With the flag, the loop injects ONE finalize directive on the
 * last allowed step; a model that honours it produces an answer (stopReason
 * "complete") instead of budget_exhausted. Strictly non-regressive: a model that
 * ignores it ends in budget_exhausted exactly as before.
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

/**
 * Provider that calls a tool every step UNTIL it sees the force-finalize
 * directive in the latest user message, then returns a final text answer.
 * Models the cooperative case (most models honour a strong final-step directive).
 */
function makeFinalizeAwareProvider(): ProviderRouter {
  return {
    async complete(req) {
      const last = req.messages[req.messages.length - 1];
      const sawDirective =
        typeof last?.content === "string" &&
        last.content.includes("STEP BUDGET REACHED");
      if (sawDirective) {
        return {
          provider: "mock",
          model: "mock",
          content: "FINAL ANSWER: synthesised from what I gathered.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        model: "mock",
        content: "calling tool again",
        toolCalls: [
          { id: `c${Math.random()}`, name: "noop", args: { n: Math.random() } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

/** Provider that ALWAYS calls a tool, ignoring any directive (worst case). */
function makeStubbornProvider(): ProviderRouter {
  return {
    async complete() {
      return {
        provider: "mock",
        model: "mock",
        content: "ignoring directive, calling tool",
        toolCalls: [
          { id: `c${Math.random()}`, name: "noop", args: { n: Math.random() } },
        ],
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

function build(provider: ProviderRouter, force: boolean): AgentLoop {
  return new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider,
    tools: makeRegistry(),
    budget: createBudgetState({ maxSteps: 4 }),
    disableLoopDetection: true,
    ...(force ? { forceFinalizeBeforeBudget: true } : {}),
  });
}

describe("minimal-loop forceFinalizeBeforeBudget", () => {
  it("produces a final answer on the last step when the model honours the directive", async () => {
    const result = await build(makeFinalizeAwareProvider(), true).run(
      "research X",
    );
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toMatch(/FINAL ANSWER/);
  });

  it("without the flag, the same looping model hits budget_exhausted (baseline)", async () => {
    const result = await build(makeFinalizeAwareProvider(), false).run(
      "research X",
    );
    expect(result.stopReason).toBe("budget_exhausted");
  });

  it("is non-regressive: a stubborn model still ends in budget_exhausted", async () => {
    const result = await build(makeStubbornProvider(), true).run("research X");
    expect(result.stopReason).toBe("budget_exhausted");
  });
});
