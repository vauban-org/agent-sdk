import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop, type ProviderRouter, createBudgetState } from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/**
 * Context-window accounting + emergency-summary anchors (sprint-936 chat-wipe bug).
 *
 * Root cause of the founder-hit "fresh start every turn" chat bug:
 * (1) currentTokens ACCUMULATED usage.inputTokens each step, but the prompt of
 *     step N already re-sends the whole prefix — the counter grew quadratically
 *     vs real window occupancy and crossed the 90% emergency threshold on long
 *     multi-tool turns;
 * (2) the emergency summary then spliced the ENTIRE log away — system prompt
 *     and the user's task included — so the model literally saw only
 *     "[context recap] …" and restarted from scratch mid-turn.
 */

function toolStepsProvider(
  steps: number,
  usagePerStep: { inputTokens: number; outputTokens: number },
  captured?: Array<Array<{ role: string; content: string }>>,
): ProviderRouter {
  let call = 0;
  return {
    async complete(req) {
      const msgs = (req as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
      captured?.push(msgs.map((m) => ({ role: m.role, content: m.content })));
      call++;
      if (call <= steps) {
        return {
          provider: "mock",
          content: "",
          toolCalls: [{ name: "emit", args: { n: call } }],
          usage: { ...usagePerStep },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        content: "final",
        toolCalls: [],
        usage: { ...usagePerStep },
        latencyMs: 0,
      };
    },
  };
}

function registryWithEmit(): ToolRegistryImpl {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "emit",
    description: "emit",
    parameters: z.object({ n: z.number() }).strict(),
    execute: async ({ n }) => `payload-${n}`,
  });
  return reg;
}

describe("context-window accounting", () => {
  it("currentTokens tracks the LAST request occupancy, not the cumulative sum", async () => {
    const budget = createBudgetState({});
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: toolStepsProvider(5, { inputTokens: 1000, outputTokens: 100 }),
      tools: registryWithEmit(),
      budget,
    });
    const result = await loop.run("task");
    expect(result.stopReason).toBe("complete");
    // 6 LLM calls total (5 tool steps + final). Cumulative-sum bug would give
    // 6600; true occupancy is the last call's prompt+completion = 1100.
    expect(budget.contextWindow.currentTokens).toBe(1100);
  });

  it("zero-usage responses do not reset the occupancy counter", async () => {
    const budget = createBudgetState({});
    let call = 0;
    const provider: ProviderRouter = {
      async complete() {
        call++;
        return call === 1
          ? {
              provider: "mock",
              content: "",
              toolCalls: [{ name: "emit", args: { n: 1 } }],
              usage: { inputTokens: 900, outputTokens: 50 },
              latencyMs: 0,
            }
          : {
              provider: "mock",
              content: "final",
              toolCalls: [],
              // streaming providers that never emit a usage chunk report 0/0
              usage: { inputTokens: 0, outputTokens: 0 },
              latencyMs: 0,
            };
      },
    };
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: registryWithEmit(),
      budget,
    });
    await loop.run("task");
    expect(budget.contextWindow.currentTokens).toBe(950);
  });
});

describe("emergency summary anchors", () => {
  it("keeps the system prompt and the user task after an emergency context wipe", async () => {
    const captured: Array<Array<{ role: string; content: string }>> = [];
    // Tiny window + big reported usage -> emergency threshold crossed after
    // the first step; the NEXT request must still carry the anchors.
    const budget = createBudgetState({
      contextWindow: { maxTokens: 500, currentTokens: 0 },
    });
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "SYS-ANCHOR",
      provider: toolStepsProvider(2, { inputTokens: 5000, outputTokens: 100 }, captured),
      tools: registryWithEmit(),
      budget,
    });
    const result = await loop.run("USER-TASK-ANCHOR");
    expect(result.stopReason).toBe("complete");
    // A request after the wipe exists and still contains both anchors.
    const last = captured[captured.length - 1] ?? [];
    const roles = last.map((m) => `${m.role}:${m.content.slice(0, 20)}`).join(" | ");
    expect(
      last.some((m) => m.content.includes("SYS-ANCHOR")),
      roles,
    ).toBe(true);
    expect(
      last.some((m) => m.content.includes("USER-TASK-ANCHOR")),
      roles,
    ).toBe(true);
  });
});
