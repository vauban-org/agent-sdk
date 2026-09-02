import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop, type ProviderRouter, createBudgetState } from "../src/index.js";
import { createCompactor } from "../src/run-memory/compactor.js";
import { FileRunJournal } from "../src/run-memory/file-run-journal.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/**
 * Scripted provider: N tool-call responses then one final answer. The
 * compactor's summarizer shares this same provider in the loop, so summarizer
 * calls (a single user message carrying the compression prompt) are detected
 * and answered WITHOUT advancing the tool-call script — otherwise the summary
 * would eat a scripted slot and desync the count.
 */
function scriptedProvider(toolSteps: number): ProviderRouter {
  let call = 0;
  return {
    async complete(req) {
      const msgs = (req as { messages?: Array<{ content: string }> }).messages ?? [];
      const isSummarizer =
        msgs.length === 1 && msgs[0]?.content.includes("compressing an agent conversation");
      if (isSummarizer) {
        return {
          provider: "mock",
          content: "SUMMARY",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 5 },
          latencyMs: 0,
        };
      }
      call++;
      if (call <= toolSteps) {
        return {
          provider: "mock",
          content: "",
          toolCalls: [{ name: "emit", args: { n: call } }],
          usage: { inputTokens: 10, outputTokens: 10 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        content: "final answer",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 0,
      };
    },
  };
}

function registryWithEmit(): ToolRegistryImpl {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "emit",
    description: "emit a payload",
    parameters: z.object({ n: z.number() }).strict(),
    execute: async ({ n }) => `payload-${n} ${"z".repeat(400)}`,
  });
  return reg;
}

function journalFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "rl-")), "run.jsonl");
}

describe("AgentLoop + runMemory", () => {
  it("journals assistant tool-call steps and tool results during the run", async () => {
    const journal = new FileRunJournal(journalFile());
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: scriptedProvider(3),
      tools: registryWithEmit(),
      budget: createBudgetState({ maxSteps: 0 }),
      runMemory: { journal, compactor: createCompactor() },
    });
    const result = await loop.run("do it");
    expect(result.stopReason).toBe("complete");
    const steps = await journal.read({ from: 0, to: 999 });
    expect(steps.filter((s) => s.role === "tool")).toHaveLength(3);
    expect(steps.filter((s) => s.role === "assistant").length).toBeGreaterThanOrEqual(3);
    // the final no-tool-call assistant answer is NOT journaled (host sink owns it)
    expect(steps.some((s) => s.content === "final answer")).toBe(false);
  });

  it("fires grounded compaction (small window) and the run still completes with full journal", async () => {
    const journal = new FileRunJournal(journalFile());
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: scriptedProvider(8),
      tools: registryWithEmit(),
      budget: createBudgetState({
        maxSteps: 0,
        contextWindow: { maxTokens: 800, currentTokens: 0 },
      }),
      runMemory: { journal, compactor: createCompactor({ keepLast: 2 }) },
    });
    const result = await loop.run("long task");
    expect(result.stopReason).toBe("complete");
    // everything evicted from the window is still in the journal — nothing lost.
    // The load-bearing claim: all 8 tool results survive despite compaction to keepLast=2.
    const steps = await journal.read({ from: 0, to: 999 });
    expect(steps.filter((s) => s.role === "tool")).toHaveLength(8);
    expect(steps.length).toBeGreaterThanOrEqual(15);
  });

  it("without runMemory: zero journal writes, legacy behavior preserved", async () => {
    const file = journalFile();
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: scriptedProvider(2),
      tools: registryWithEmit(),
      budget: createBudgetState({}),
    });
    const result = await loop.run("do it");
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("final answer");
    const probe = new FileRunJournal(file);
    expect(await probe.read({ from: 0, to: 999 })).toHaveLength(0);
  });
});
