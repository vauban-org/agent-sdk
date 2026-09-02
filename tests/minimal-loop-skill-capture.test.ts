/**
 * tests/minimal-loop-skill-capture.test.ts
 *
 * Beyond-Hermes W2-T4 ; the SDK minimal-loop skill-capture completion hook. The
 * loop only NOTIFIES (best-effort, exactly once, only on a clean completion,
 * fail-soft, BEFORE run.finished) ; the governed write-time battery + sink live
 * in the host (preste's governedSkillCapture). Verifies: fires once on complete
 * with the summary, is fail-soft (a throwing hook does not change the run
 * result), and is NOT fired when the run errors.
 */

import { describe, expect, it } from "vitest";
import { AgentLoop, type ProviderRouter, createBudgetState } from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function completingProvider(): ProviderRouter {
  return {
    async complete() {
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

function throwingProvider(): ProviderRouter {
  return {
    async complete(): Promise<never> {
      throw new Error("provider exploded");
    },
  };
}

function makeLoop(over: Partial<ConstructorParameters<typeof AgentLoop>[0]>): AgentLoop {
  return new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider: completingProvider(),
    tools: new ToolRegistryImpl(),
    budget: createBudgetState({}),
    ...over,
  });
}

describe("minimal-loop skillCapture hook (Beyond-Hermes W2-T4)", () => {
  it("fires onComplete exactly once on clean completion, with the summary", async () => {
    const calls: Array<{
      runId: string;
      traceId: string;
      stopReason: string;
      finalMessage: string;
      stepCount: number;
    }> = [];
    const loop = makeLoop({
      skillCapture: {
        onComplete: (s) => {
          calls.push(s);
        },
      },
    });
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stopReason).toBe("complete");
    expect(calls[0]?.finalMessage).toBe("done");
    expect(calls[0]?.traceId).toBe(result.traceId);
    expect(typeof calls[0]?.runId).toBe("string");
    expect(calls[0]?.stepCount).toBeGreaterThanOrEqual(0);
  });

  it("is fail-soft: a throwing onComplete does not change the run result", async () => {
    const loop = makeLoop({
      skillCapture: {
        onComplete: () => {
          throw new Error("capture blew up");
        },
      },
    });
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("done");
  });

  it("does NOT fire onComplete when the run errors", async () => {
    let fired = 0;
    const loop = makeLoop({
      provider: throwingProvider(),
      skillCapture: {
        onComplete: () => {
          fired += 1;
        },
      },
    });
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("error");
    expect(fired).toBe(0);
  });
});
