/**
 * Tests for packages/agent-sdk/src/strategies/plan.ts
 *
 * Measured 2026-08-04 by the first full Stryker campaign on this repo:
 * plan.ts renders 0.00% mutation score (244 mutants with zero coverage).
 * ADR-ECO-117 kept this strategy as a user-selectable alternative
 * (`--pattern plan`) to the default grounded loop ; it had no test at all.
 *
 * Coverage:
 *   parsePlanFromText ; raw array, fenced block, malformed/invalid shapes
 *   PlanStrategy.run ; plan/execute/synthesize phases, tool vs LLM steps,
 *     maxSteps truncation, parse-failure fallback, tool throw vs registry-reject,
 *     abort handling, fail-soft hooks, synthesis-failure fallback text
 *
 * Ref: sprint-1084:quick-21
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type StrategyAgentContext,
  type StrategyLLMCompletionFn,
  type StrategyLLMResponse,
  type StrategyMessage,
  createPlanStrategy,
  noopLogger,
  parsePlanFromText,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRegistry(): ToolRegistryImpl {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "lookup_tool",
    description: "looks something up",
    parameters: z.object({ query: z.string().optional() }).strict(),
    execute: async (params) => ({ found: params.query ?? "default" }),
  });
  reg.register({
    name: "throwing_tool",
    description: "always throws inside its own handler",
    parameters: z.object({}).strict(),
    execute: async () => {
      throw new Error("tool blew up");
    },
  });
  return reg;
}

/** A registry whose `execute()` itself rejects for one tool name, bypassing
 * ToolRegistryImpl's internal try/catch ; exercises plan.ts's own catch block. */
class RejectingRegistry extends ToolRegistryImpl {
  constructor(
    private readonly rejectName: string,
    private readonly rejectMessage: string,
  ) {
    super();
  }

  override async execute(name: string, args: unknown) {
    if (name === this.rejectName) {
      throw new Error(this.rejectMessage);
    }
    return super.execute(name, args);
  }
}

function makeTrackingLogger() {
  const warnCalls: Array<{ obj: unknown; msg?: string }> = [];
  return {
    logger: {
      info: () => undefined,
      warn: (obj: unknown, msg?: string) => {
        warnCalls.push({ obj, msg });
      },
      error: () => undefined,
      debug: () => undefined,
    },
    warnCalls,
  };
}

function makeCtx(
  llmFn: StrategyLLMCompletionFn | undefined,
  overrides: Partial<StrategyAgentContext> = {},
): StrategyAgentContext {
  return {
    task: "Investigate the incident",
    systemPrompt: "You are a test planner.",
    tools: makeRegistry(),
    llmFn,
    maxSteps: 8,
    logger: noopLogger,
    runId: "test-run-plan",
    agentId: "agent-plan-test",
    ...overrides,
  };
}

function resp(content: string, extra: Partial<StrategyLLMResponse> = {}): StrategyLLMResponse {
  return {
    content,
    tokensIn: 3,
    tokensOut: 2,
    model: "test-model",
    provider: "test-provider",
    ...extra,
  };
}

/** Scripts successive llmFn calls in order; records the messages of every call. */
function makeSequentialLlm(steps: Array<StrategyLLMResponse | Error>): {
  llmFn: StrategyLLMCompletionFn;
  calls: StrategyMessage[][];
} {
  const calls: StrategyMessage[][] = [];
  let i = 0;
  const llmFn: StrategyLLMCompletionFn = async (messages) => {
    calls.push([...messages]);
    const step = steps[i];
    i++;
    if (step === undefined) {
      throw new Error(`makeSequentialLlm: no scripted response for call #${i}`);
    }
    if (step instanceof Error) throw step;
    return step;
  };
  return { llmFn, calls };
}

// ─── parsePlanFromText ──────────────────────────────────────────────────────

describe("parsePlanFromText", () => {
  it("parses a raw JSON array", () => {
    const text = JSON.stringify([{ id: 1, description: "do a thing" }]);
    expect(parsePlanFromText(text)).toEqual([{ id: 1, description: "do a thing" }]);
  });

  it("parses a JSON array embedded in a markdown fence", () => {
    const text = '```json\n[{"id": 1, "description": "fenced step"}]\n```';
    expect(parsePlanFromText(text)).toEqual([{ id: 1, description: "fenced step" }]);
  });

  it("keeps tool and tool_args when both are well-typed", () => {
    const text = JSON.stringify([
      { id: 1, description: "call a tool", tool: "lookup_tool", tool_args: { query: "x" } },
    ]);
    expect(parsePlanFromText(text)).toEqual([
      { id: 1, description: "call a tool", tool: "lookup_tool", tool_args: { query: "x" } },
    ]);
  });

  it("drops tool/tool_args when their types are wrong instead of failing the whole step", () => {
    const text = JSON.stringify([
      { id: 1, description: "bad fields", tool: 42, tool_args: "nope" },
    ]);
    expect(parsePlanFromText(text)).toEqual([{ id: 1, description: "bad fields" }]);
  });

  it("returns null when there is no '[' in the text", () => {
    expect(parsePlanFromText("no array here")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parsePlanFromText("[{not valid json]")).toBeNull();
  });

  it("returns null when the parsed value is not an array", () => {
    expect(parsePlanFromText('{"id": 1, "description": "x"}')).toBeNull();
  });

  it("returns null when any item is missing a numeric id", () => {
    const text = JSON.stringify([{ description: "no id" }]);
    expect(parsePlanFromText(text)).toBeNull();
  });

  it("returns null when any item is missing a string description", () => {
    const text = JSON.stringify([{ id: 1 }]);
    expect(parsePlanFromText(text)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(parsePlanFromText("[]")).toBeNull();
  });
});

// ─── PlanStrategy.run ───────────────────────────────────────────────────────

describe("PlanStrategy.run", () => {
  it("returns stopReason=error with zero steps/tokens when llmFn is absent", async () => {
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(undefined));
    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toBe("");
    expect(result.stepCount).toBe(0);
    expect(result.tokensUsed).toEqual({ in: 0, out: 0 });
  });

  it("aborts the whole cycle with stopReason=error when the planning call throws", async () => {
    const { llmFn } = makeSequentialLlm([new Error("planner unreachable")]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn));
    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toBe("Error during planning phase: planner unreachable");
    expect(result.stepCount).toBe(0);
    expect(result.tokensUsed).toEqual({ in: 0, out: 0 });
  });

  it("runs a tool step then an LLM step then synthesizes a final answer", async () => {
    const plan = [
      { id: 1, description: "look something up", tool: "lookup_tool", tool_args: { query: "q1" } },
      { id: 2, description: "reason about it" },
    ];
    const { llmFn, calls } = makeSequentialLlm([
      resp(JSON.stringify(plan)),
      resp("reasoned conclusion"),
      resp("FINAL SYNTHESIS"),
    ]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn));

    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("FINAL SYNTHESIS");
    expect(result.stepCount).toBe(2);

    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.result).toBe(JSON.stringify({ found: "q1" }));
    expect(trace[1]?.result).toBe("reasoned conclusion");

    // Synthesis call (3rd) must carry both the plan summary and the step results.
    const synthUser = calls[2]?.[1]?.content ?? "";
    expect(synthUser).toContain("look something up");
    expect(synthUser).toContain(JSON.stringify({ found: "q1" }));
    expect(synthUser).toContain("reasoned conclusion");
  });

  it("falls back to a single direct-execution step when the plan cannot be parsed", async () => {
    const longTask = `T${"x".repeat(260)}`; // > 200 chars, exercises the slice(0, 200) truncation
    const { llmFn } = makeSequentialLlm([
      resp("not a json plan at all"),
      resp("direct answer"),
      resp("FINAL"),
    ]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn, { task: longTask }));

    expect(result.stopReason).toBe("complete");
    expect(result.stepCount).toBe(1);
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.description).toBe(`Execute task directly: ${longTask.slice(0, 200)}`);
  });

  it("truncates the plan to ctx.maxSteps", async () => {
    const plan = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, description: `step ${i + 1}` }));
    const { llmFn } = makeSequentialLlm([
      resp(JSON.stringify(plan)),
      resp("r1"),
      resp("r2"),
      resp("FINAL"),
    ]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn, { maxSteps: 2 }));
    expect(result.stepCount).toBe(2);
  });

  it("records the tool's own error message when the tool handler throws (caught by the registry)", async () => {
    const plan = [{ id: 1, description: "explode", tool: "throwing_tool" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("FINAL")]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn));

    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.error).toBe('Tool "throwing_tool" execution failed: tool blew up');
  });

  it("records a rejected tools.execute() call via its own catch block (registry bypass)", async () => {
    const plan = [{ id: 1, description: "hard fail", tool: "boom_tool" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("FINAL")]);
    const registry = new RejectingRegistry("boom_tool", "connection refused");
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn, { tools: registry }));

    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.error).toBe("connection refused");
  });

  it("defaults tool_args to {} when the plan step omits them", async () => {
    const plan = [{ id: 1, description: "no args", tool: "lookup_tool" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("FINAL")]);
    const registry = makeRegistry();
    const executeSpy = vi.spyOn(registry, "execute");
    const strategy = createPlanStrategy();
    await strategy.run(makeCtx(llmFn, { tools: registry }));
    expect(executeSpy).toHaveBeenCalledWith("lookup_tool", {});
  });

  it("only carries the last 3 prior results into an LLM step's context", async () => {
    const plan = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, description: `step ${i + 1}` }));
    const { llmFn, calls } = makeSequentialLlm([
      resp(JSON.stringify(plan)),
      resp("R1"),
      resp("R2"),
      resp("R3"),
      resp("R4"),
      resp("R5"),
      resp("FINAL"),
    ]);
    const strategy = createPlanStrategy();
    await strategy.run(makeCtx(llmFn, { maxSteps: 5 }));

    // Call index 5 is the 5th execution step (id=5); its context must show
    // results for steps 2, 3, 4 only ; step 1's result must have been dropped.
    const step5Context = calls[5]?.[1]?.content ?? "";
    expect(step5Context).toContain("step 2): R2");
    expect(step5Context).toContain("step 3): R3");
    expect(step5Context).toContain("step 4): R4");
    expect(step5Context).not.toContain("step 1): R1");
  });

  it("keeps executing later steps after an LLM-only step throws, but flags the cycle as error", async () => {
    const plan = [
      { id: 1, description: "will fail" },
      { id: 2, description: "still runs" },
    ];
    const { llmFn } = makeSequentialLlm([
      resp(JSON.stringify(plan)),
      new Error("mid-plan LLM outage"),
      resp("recovered"),
      resp("FINAL"),
    ]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn));

    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.error).toBe("mid-plan LLM outage");
    expect(trace[1]?.result).toBe("recovered");
    // The failed step does not abort the cycle, but the reported outcome stays "error".
    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toBe("FINAL");
  });

  it("fires onPhaseComplete with the resolved plan", async () => {
    const plan = [{ id: 1, description: "only step" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("r1"), resp("FINAL")]);
    const phases: Array<{ phase: string; output: unknown }> = [];
    const ctx = makeCtx(llmFn, {
      hooks: { onPhaseComplete: (phase, output) => phases.push({ phase, output }) },
    });
    const strategy = createPlanStrategy();
    await strategy.run(ctx);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.phase).toBe("plan");
    expect(phases[0]?.output).toEqual(plan);
  });

  it("swallows a throwing onPhaseComplete hook without crashing the cycle", async () => {
    const plan = [{ id: 1, description: "only step" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("r1"), resp("FINAL")]);
    const ctx = makeCtx(llmFn, {
      hooks: {
        onPhaseComplete: () => {
          throw new Error("phase hook exploded");
        },
      },
    });
    const strategy = createPlanStrategy();
    const result = await strategy.run(ctx);
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("FINAL");
  });

  it("logs a warning and continues when onStep throws (fail-soft)", async () => {
    const plan = [{ id: 1, description: "only step" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("r1"), resp("FINAL")]);
    const { logger, warnCalls } = makeTrackingLogger();
    const ctx = makeCtx(llmFn, {
      logger,
      hooks: {
        onStep: () => {
          throw new Error("onStep exploded");
        },
      },
    });
    const strategy = createPlanStrategy();
    const result = await strategy.run(ctx);
    expect(result.stopReason).toBe("complete");
    expect(warnCalls.some((c) => c.msg === "plan.onStep_failed")).toBe(true);
  });

  it("accumulates tokensIn/tokensOut across the plan, execute and synthesize phases", async () => {
    const plan = [{ id: 1, description: "only step" }];
    const { llmFn } = makeSequentialLlm([
      resp(JSON.stringify(plan), { tokensIn: 10, tokensOut: 1 }),
      resp("r1", { tokensIn: 20, tokensOut: 2 }),
      resp("FINAL", { tokensIn: 30, tokensOut: 3 }),
    ]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn));
    expect(result.tokensUsed).toEqual({ in: 60, out: 6 });
  });

  it("falls back to a diagnostic message when synthesis fails but step results exist", async () => {
    const plan = [{ id: 1, description: "only step" }];
    const { llmFn } = makeSequentialLlm([
      resp(JSON.stringify(plan)),
      resp("some result"),
      new Error("synth provider down"),
    ]);
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn));

    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toContain("Synthesis failed (synth provider down)");
    expect(result.finalMessage).toContain("some result");
  });

  it("reports 'no results to synthesize' when the cycle was cancelled before any step ran and synthesis also fails", async () => {
    // NB: the abort check only guards the per-step execute loop; the plan
    // and synthesize LLM calls both run unconditionally even when the signal
    // is already aborted (documented, not fixed ; see final report).
    const plan = [{ id: 1, description: "never runs" }];
    const { llmFn } = makeSequentialLlm([resp(JSON.stringify(plan)), new Error("synth also down")]);
    const controller = new AbortController();
    controller.abort();
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn, { signal: controller.signal }));

    expect(result.stepCount).toBe(0);
    // stoppedReason was already "user_cancelled" from the empty execute loop;
    // a subsequent synthesis failure must not override it back to "error".
    expect(result.stopReason).toBe("user_cancelled");
    expect(result.finalMessage).toBe("No results to synthesize. Error: synth also down");
  });

  it("still runs the planning and synthesis LLM calls even when the signal is pre-aborted", async () => {
    const plan = [{ id: 1, description: "never runs" }];
    const { llmFn, calls } = makeSequentialLlm([resp(JSON.stringify(plan)), resp("FINAL ANYWAY")]);
    const controller = new AbortController();
    controller.abort();
    const strategy = createPlanStrategy();
    const result = await strategy.run(makeCtx(llmFn, { signal: controller.signal }));

    expect(calls).toHaveLength(2); // plan call + synthesize call ; no per-step call
    expect(result.stopReason).toBe("user_cancelled");
    expect(result.finalMessage).toBe("FINAL ANYWAY");
  });
});
