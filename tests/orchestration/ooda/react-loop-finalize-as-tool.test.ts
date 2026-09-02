/**
 * react-loop `finalizeAsTool` option — 1.10.0 (Brief #6).
 *
 * Covers all 6 spec cases :
 *  1. Default (`finalizeAsTool: false`) → existing 1.6 — 1.9 behaviour
 *     (isFinal short-circuits, `content` is the answer, executeTool NOT
 *     called).
 *  2. `finalizeAsTool: true` + LLM emits a `finalize` tool call →
 *     executeTool invoked once with the finalize call, return value
 *     becomes `result.answer`.
 *  3. Custom `finalizeToolName: "return_final"` → executeTool invoked
 *     with that name.
 *  4. `finalizeAsTool: true` + isFinal but NO matching finalize call →
 *     warn logged, fall back to LLM content as answer, executeTool NOT
 *     called.
 *  5. `finalizeAsTool: true` + executeTool throws → error propagates.
 *  6. onStep fired for the finalize step with `step.action` populated.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type LLMReactResponse,
  type ReactLoopOptions,
  type ReactMessage,
  type ReactStep,
  type ReactStepMeta,
  type ToolCall,
  reactLoop,
} from "../../../src/orchestration/ooda/react-loop.js";

function scriptedLLM(responses: LLMReactResponse[]) {
  let i = 0;
  return async (_msgs: ReactMessage[]): Promise<LLMReactResponse> => {
    const r = responses[i++];
    if (!r) {
      throw new Error("scriptedLLM ran out of responses");
    }
    return r;
  };
}

function baseOpts(
  overrides: Partial<ReactLoopOptions> & Pick<ReactLoopOptions, "llm">,
): ReactLoopOptions {
  return {
    systemPrompt: "sys",
    task: "task",
    executeTool: async () => "ok",
    ...overrides,
  };
}

describe("reactLoop.finalizeAsTool — 1.10.0", () => {
  it("default (false): isFinal short-circuits without calling executeTool", async () => {
    const executeTool = vi.fn(async () => "should-not-be-called");

    const result = await reactLoop(
      baseOpts({
        llm: scriptedLLM([
          {
            content: "the answer is 42",
            toolCalls: [{ tool: "finalize", args: { answer: "42" } }],
            isFinal: true,
          },
        ]),
        executeTool,
      }),
    );

    expect(result.answer).toBe("the answer is 42");
    expect(result.totalSteps).toBe(1);
    expect(result.truncated).toBe(false);
    // CRITICAL backward-compat : executeTool MUST NOT be called when
    // finalizeAsTool is undefined / false.
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("finalizeAsTool: true + finalize tool call → executeTool invoked, return value becomes answer", async () => {
    const executeTool = vi.fn(async (_call: ToolCall) => "VALIDATED:42");

    const result = await reactLoop(
      baseOpts({
        finalizeAsTool: true,
        llm: scriptedLLM([
          {
            content: "thought before final",
            toolCalls: [{ tool: "finalize", args: { answer: "42" } }],
            isFinal: true,
          },
        ]),
        executeTool,
      }),
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith({
      tool: "finalize",
      args: { answer: "42" },
    });
    expect(result.answer).toBe("VALIDATED:42");
    expect(result.totalSteps).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.steps[0].observation).toBe("VALIDATED:42");
    expect(result.steps[0].action).toEqual({
      tool: "finalize",
      args: { answer: "42" },
    });
  });

  it("custom finalizeToolName: executeTool invoked with that name", async () => {
    const executeTool = vi.fn(async (call: ToolCall) => `RX:${call.tool}`);

    const result = await reactLoop(
      baseOpts({
        finalizeAsTool: true,
        finalizeToolName: "return_final",
        llm: scriptedLLM([
          {
            content: "done",
            toolCalls: [{ tool: "return_final", args: { value: "x" } }],
            isFinal: true,
          },
        ]),
        executeTool,
      }),
    );

    expect(executeTool).toHaveBeenCalledWith({
      tool: "return_final",
      args: { value: "x" },
    });
    expect(result.answer).toBe("RX:return_final");
  });

  it("finalizeAsTool: true + isFinal but no matching call → warn + fallback to LLM content", async () => {
    const warn = vi.fn();
    const executeTool = vi.fn(async () => "should-not-run");

    const result = await reactLoop(
      baseOpts({
        finalizeAsTool: true,
        llm: scriptedLLM([
          {
            // LLM signals final but forgot the finalize tool call. Don't
            // crash the loop — fall back to content, warn the operator.
            content: "I am final but lazy",
            isFinal: true,
          },
        ]),
        executeTool,
        logger: { warn },
      }),
    );

    expect(result.answer).toBe("I am final but lazy");
    expect(executeTool).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/finalizeAsTool.*no matching finalize tool call/);
    expect(warn.mock.calls[0][1]).toMatchObject({
      iteration: 0,
      expectedTool: "finalize",
    });
  });

  it("finalizeAsTool: true + executeTool throws → error propagates", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("validation-failed");
    });

    await expect(
      reactLoop(
        baseOpts({
          finalizeAsTool: true,
          llm: scriptedLLM([
            {
              content: "almost done",
              toolCalls: [{ tool: "finalize", args: { answer: "boom" } }],
              isFinal: true,
            },
          ]),
          executeTool,
        }),
      ),
    ).rejects.toThrow("validation-failed");

    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("finalizeAsTool: true → onStep fired once with step.action recorded", async () => {
    const onStep = vi.fn<(step: ReactStep, meta: ReactStepMeta) => void>();

    await reactLoop(
      baseOpts({
        finalizeAsTool: true,
        loopId: "loop-fin",
        llm: scriptedLLM([
          {
            content: "thought",
            toolCalls: [{ tool: "finalize", args: { answer: "X" } }],
            isFinal: true,
          },
        ]),
        executeTool: async () => "RESULT",
        onStep,
      }),
    );

    expect(onStep).toHaveBeenCalledTimes(1);
    const [step, meta] = onStep.mock.calls[0] as [ReactStep, ReactStepMeta];
    expect(step.action).toEqual({
      tool: "finalize",
      args: { answer: "X" },
    });
    expect(step.observation).toBe("RESULT");
    expect(meta.iteration).toBe(0);
    expect(meta.loopId).toBe("loop-fin");
  });

  it("finalizeAsTool: true + mid-loop tool calls + final finalize tool call (multi-step)", async () => {
    // Realistic flow : 2 search tool calls, then a finalize tool call.
    const executeTool = vi.fn(async (call: ToolCall) => {
      if (call.tool === "finalize") {
        return `FINAL:${(call.args as { answer: string }).answer}`;
      }
      return `searched-${(call.args as { q: string }).q}`;
    });

    const result = await reactLoop(
      baseOpts({
        finalizeAsTool: true,
        llm: scriptedLLM([
          {
            content: "first search",
            toolCalls: [{ tool: "search", args: { q: "a" } }],
            isFinal: false,
          },
          {
            content: "second search",
            toolCalls: [{ tool: "search", args: { q: "b" } }],
            isFinal: false,
          },
          {
            content: "wrapping up",
            toolCalls: [{ tool: "finalize", args: { answer: "42" } }],
            isFinal: true,
          },
        ]),
        executeTool,
      }),
    );

    expect(result.totalSteps).toBe(3);
    expect(result.answer).toBe("FINAL:42");
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls[2][0]).toEqual({
      tool: "finalize",
      args: { answer: "42" },
    });
  });
});
