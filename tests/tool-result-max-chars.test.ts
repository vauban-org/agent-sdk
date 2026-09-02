import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop, type ProviderRouter, createBudgetState } from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/**
 * toolResultMaxChars — the per-tool-result injection cap (ADR-ECO-117 follow-up).
 *
 * Unset: legacy byte-identical behavior (hard slice at 2000 chars, no marker) —
 * the 14 CC agents on quota-bound providers keep their exact context volume.
 * Set: the host-provided cap applies and a truncation is EXPLICIT (self-
 * describing marker) instead of a silent cut.
 */

/** Provider that records every request and answers: 1 tool call, then final. */
function recordingProvider(captured: Array<Array<{ role: string; content: string }>>) {
  let call = 0;
  const provider: ProviderRouter = {
    async complete(req) {
      const msgs = (req as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
      captured.push(msgs.map((m) => ({ role: m.role, content: m.content })));
      call++;
      if (call === 1) {
        return {
          provider: "mock",
          content: "",
          toolCalls: [{ name: "bigread", args: {} }],
          usage: { inputTokens: 10, outputTokens: 10 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        content: "done",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 0,
      };
    },
  };
  return provider;
}

function registryWithBigRead(payloadChars: number): ToolRegistryImpl {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "bigread",
    description: "returns a large payload",
    parameters: z.object({}).strict(),
    execute: async () => `PAYLOAD:${"x".repeat(payloadChars)}`,
  });
  return reg;
}

/** The tool message the model saw on the second LLM call. */
function toolMessageSeen(captured: Array<Array<{ role: string; content: string }>>): string {
  const last = captured[captured.length - 1] ?? [];
  const tool = last.find((m) => m.content.startsWith("PAYLOAD:"));
  expect(tool, "tool message not found in provider request").toBeDefined();
  return (tool as { content: string }).content;
}

describe("AgentLoop toolResultMaxChars", () => {
  it("unset: legacy hard slice at 2000 chars, no truncation marker (byte-identical)", async () => {
    const captured: Array<Array<{ role: string; content: string }>> = [];
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: recordingProvider(captured),
      tools: registryWithBigRead(5000),
      budget: createBudgetState({}),
    });
    const result = await loop.run("go");
    expect(result.stopReason).toBe("complete");
    const seen = toolMessageSeen(captured);
    expect(seen).toHaveLength(2000);
    expect(seen).not.toContain("[tool result truncated");
  });

  it("set high enough: the full result reaches the model untruncated", async () => {
    const captured: Array<Array<{ role: string; content: string }>> = [];
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: recordingProvider(captured),
      tools: registryWithBigRead(5000),
      budget: createBudgetState({}),
      toolResultMaxChars: 100_000,
    });
    const result = await loop.run("go");
    expect(result.stopReason).toBe("complete");
    const seen = toolMessageSeen(captured);
    expect(seen).toHaveLength("PAYLOAD:".length + 5000);
    expect(seen).not.toContain("[tool result truncated");
  });

  it("set below the result size: truncates at the cap with a self-describing marker", async () => {
    const captured: Array<Array<{ role: string; content: string }>> = [];
    const loop = new AgentLoop({
      agentId: "t",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: recordingProvider(captured),
      tools: registryWithBigRead(5000),
      budget: createBudgetState({}),
      toolResultMaxChars: 3000,
    });
    const result = await loop.run("go");
    expect(result.stopReason).toBe("complete");
    const seen = toolMessageSeen(captured);
    // cap chars of payload + an explicit marker that names both sizes
    expect(seen.startsWith(`PAYLOAD:${"x".repeat(3000 - "PAYLOAD:".length)}`)).toBe(true);
    expect(seen).toContain("[tool result truncated: showing 3000 of 5008 chars]");
  });
});
