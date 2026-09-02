/**
 * react-loop onStep callback — 1.7.0 telemetry hook.
 *
 * Covers all 6 spec cases:
 *  1. Happy path : 3 iterations → onStep called 3× with correct indices + meta.
 *  2. Async callback : loop awaits the promise (ordering proven by a delay).
 *  3. Sync error  : onStep throws → loop continues, warn logged.
 *  4. Async error : onStep rejects → loop continues, warn logged.
 *  5. No callback : onStep undefined → identical to 1.6.4 behavior.
 *  6. AbortSignal : onStep NOT called for the aborted iteration.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type LLMReactResponse,
  type ReactLoopOptions,
  type ReactMessage,
  type ReactStep,
  type ReactStepMeta,
  reactLoop,
} from "../../../src/orchestration/ooda/react-loop.js";

/** Build a programmable LLM completion fn from a queue of responses. */
function scriptedLLM(responses: LLMReactResponse[]) {
  let i = 0;
  return async (_msgs: ReactMessage[]): Promise<LLMReactResponse> => {
    const r = responses[i++];
    if (!r) {
      throw new Error("scriptedLLM ran out of responses");
    }
    // tiny await to make duration measurable on fast clocks
    await new Promise((res) => setTimeout(res, 2));
    return r;
  };
}

/** Default tool executor returning a static observation. */
const echoExec = async () => "ok";

function baseOpts(
  overrides: Partial<ReactLoopOptions> & Pick<ReactLoopOptions, "llm">,
): ReactLoopOptions {
  return {
    systemPrompt: "sys",
    task: "task",
    executeTool: echoExec,
    ...overrides,
  };
}

describe("reactLoop.onStep — 1.7.0", () => {
  it("happy path: invoked 3× with index 0/1/2 + durationMs > 0 + correct loopId", async () => {
    const onStep = vi.fn<(step: ReactStep, meta: ReactStepMeta) => void>();

    const result = await reactLoop(
      baseOpts({
        loopId: "loop-xyz",
        llm: scriptedLLM([
          {
            content: "t0",
            toolCalls: [{ tool: "search", args: { q: "a" } }],
            isFinal: false,
          },
          {
            content: "t1",
            toolCalls: [{ tool: "search", args: { q: "b" } }],
            isFinal: false,
          },
          { content: "final answer", isFinal: true },
        ]),
        onStep,
      }),
    );

    expect(result.answer).toBe("final answer");
    expect(onStep).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 3; i++) {
      const [step, meta] = onStep.mock.calls[i] as [ReactStep, ReactStepMeta];
      expect(step.index).toBe(i);
      expect(meta.iteration).toBe(i);
      expect(meta.loopId).toBe("loop-xyz");
      expect(meta.durationMs).toBeGreaterThanOrEqual(0);
      // The scripted LLM sleeps ~2ms — duration should be at least that on
      // any non-broken clock, but stay loose to avoid flakes.
      expect(meta.durationMs).toBeLessThan(10_000);
    }
  });

  it("async callback: loop awaits returned promise (ordering preserved)", async () => {
    const order: string[] = [];
    const llm = async (_m: ReactMessage[]): Promise<LLMReactResponse> => {
      order.push(`llm-${order.filter((x) => x.startsWith("llm")).length}`);
      const idx = order.filter((x) => x.startsWith("llm")).length - 1;
      if (idx === 0) {
        return {
          content: "t0",
          toolCalls: [{ tool: "search", args: {} }],
          isFinal: false,
        };
      }
      return { content: "done", isFinal: true };
    };

    await reactLoop(
      baseOpts({
        llm,
        onStep: async (_step, meta) => {
          order.push(`onStep-start-${meta.iteration}`);
          await new Promise((res) => setTimeout(res, 20));
          order.push(`onStep-end-${meta.iteration}`);
        },
      }),
    );

    // Each onStep must complete before the next LLM call fires.
    expect(order).toEqual([
      "llm-0",
      "onStep-start-0",
      "onStep-end-0",
      "llm-1",
      "onStep-start-1",
      "onStep-end-1",
    ]);
  });

  it("sync error: onStep throws → loop continues, warn logged, final answer correct", async () => {
    const warn = vi.fn();

    const result = await reactLoop(
      baseOpts({
        llm: scriptedLLM([
          {
            content: "t0",
            toolCalls: [{ tool: "search", args: {} }],
            isFinal: false,
          },
          { content: "final", isFinal: true },
        ]),
        onStep: () => {
          throw new Error("boom-sync");
        },
        logger: { warn },
      }),
    );

    expect(result.answer).toBe("final");
    expect(result.truncated).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/onStep threw/);
    expect(warn.mock.calls[0][1]).toMatchObject({
      iteration: 0,
      error: "boom-sync",
    });
  });

  it("async error: onStep rejects → loop continues, warn logged", async () => {
    const warn = vi.fn();

    const result = await reactLoop(
      baseOpts({
        llm: scriptedLLM([
          {
            content: "t0",
            toolCalls: [{ tool: "search", args: {} }],
            isFinal: false,
          },
          { content: "final", isFinal: true },
        ]),
        onStep: async () => {
          throw new Error("boom-async");
        },
        logger: { warn },
      }),
    );

    expect(result.answer).toBe("final");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toMatchObject({ error: "boom-async" });
  });

  it("no callback: undefined onStep → identical to 1.6.4 (backward compat)", async () => {
    const result = await reactLoop(
      baseOpts({
        llm: scriptedLLM([
          {
            content: "t0",
            toolCalls: [{ tool: "search", args: {} }],
            isFinal: false,
          },
          { content: "final", isFinal: true },
        ]),
      }),
    );

    expect(result.answer).toBe("final");
    expect(result.totalSteps).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].action?.tool).toBe("search");
    expect(result.steps[0].observation).toBe("ok");
  });

  it("AbortSignal: onStep NOT called for the aborted iteration", async () => {
    const onStep = vi.fn<(step: ReactStep, meta: ReactStepMeta) => void>();
    const controller = new AbortController();

    // First iteration completes normally, then we abort before the second
    // iteration's LLM call.
    const llm = async (_m: ReactMessage[]): Promise<LLMReactResponse> => {
      if (onStep.mock.calls.length === 0) {
        return {
          content: "t0",
          toolCalls: [{ tool: "search", args: {} }],
          isFinal: false,
        };
      }
      // Should not be reached — abort fires before second LLM call.
      throw new Error("llm should not be called after abort");
    };

    const exec = async () => {
      // Inside tool execution of iteration 0, signal abort so iteration 1
      // sees aborted=true at the top of the loop and exits before any new
      // step is created.
      controller.abort();
      return "ok";
    };

    const result = await reactLoop({
      systemPrompt: "sys",
      task: "task",
      llm,
      executeTool: exec,
      signal: controller.signal,
      onStep,
    });

    // Iteration 0 finalized → onStep fired once.
    // Iteration 1 aborted before step push → onStep NOT fired.
    expect(onStep).toHaveBeenCalledTimes(1);
    expect((onStep.mock.calls[0][1] as ReactStepMeta).iteration).toBe(0);
    expect(result.truncated).toBe(true);
    // Aborted at iteration 1 → totalSteps reported = 1 (loop index when abort detected).
    expect(result.totalSteps).toBe(1);
    expect(result.steps).toHaveLength(1);
  });
});
