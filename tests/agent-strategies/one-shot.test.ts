/**
 * Tests for the one-shot strategy.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type StrategyAgentContext,
  type StrategyLLMCompletionFn,
  createOneShotStrategy,
} from "../../src/index.js";
import { ToolRegistryImpl } from "../../src/tools/index.js";

function makeRegistry() {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "noop",
    description: "no-op",
    parameters: z.object({}).strict(),
    execute: async () => ({ ok: true }),
  });
  return reg;
}

function makeCtx(llmFn: StrategyLLMCompletionFn, task = "Say hi"): StrategyAgentContext {
  return {
    task,
    systemPrompt: "test prompt",
    tools: makeRegistry(),
    llmFn,
    maxSteps: 10,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    runId: "test-run-1",
    agentId: "agent-test",
  };
}

describe("one-shot strategy", () => {
  it("returns the LLM response as finalMessage with stopReason=complete", async () => {
    const llm: StrategyLLMCompletionFn = async () => ({
      content: "Hello!",
      tokensIn: 10,
      tokensOut: 5,
      model: "test-model",
      provider: "test-provider",
    });
    const s = createOneShotStrategy();
    const result = await s.run(makeCtx(llm));
    expect(result.finalMessage).toBe("Hello!");
    expect(result.stopReason).toBe("complete");
    expect(result.stepCount).toBe(1);
    expect(result.tokensUsed.in).toBe(10);
    expect(result.tokensUsed.out).toBe(5);
    expect(result.model).toBe("test-model");
    expect(result.provider).toBe("test-provider");
  });

  it("fires onStep hook with strategy=one-shot", async () => {
    const events: Array<{ phase: string; strategy: string }> = [];
    const llm: StrategyLLMCompletionFn = async () => ({
      content: "ok",
      tokensIn: 1,
      tokensOut: 1,
      model: "m",
      provider: "p",
    });
    const ctx = {
      ...makeCtx(llm),
      hooks: {
        onStep: (e: { phase: string; strategy: string }) => {
          events.push({ phase: e.phase, strategy: e.strategy });
        },
      },
    };
    const s = createOneShotStrategy();
    await s.run(ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.strategy).toBe("one-shot");
  });

  it("returns stopReason=error when llmFn throws", async () => {
    const llm: StrategyLLMCompletionFn = async () => {
      throw new Error("boom");
    };
    const s = createOneShotStrategy();
    const result = await s.run(makeCtx(llm));
    expect(result.stopReason).toBe("error");
    expect(result.stepCount).toBe(0);
  });

  it("returns stopReason=error when llmFn is absent", async () => {
    const ctx: StrategyAgentContext = {
      task: "x",
      systemPrompt: "p",
      tools: makeRegistry(),
      maxSteps: 10,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      runId: "r",
      agentId: "a",
    };
    const s = createOneShotStrategy();
    const result = await s.run(ctx);
    expect(result.stopReason).toBe("error");
  });
});
