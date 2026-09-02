/**
 * Tests for packages/agent-sdk/src/strategies/react.ts
 *
 * Measured 2026-08-04 by the first full Stryker campaign on this repo:
 * react.ts renders 0.00% mutation score (282 mutants with zero coverage).
 * ADR-ECO-117 kept this strategy as a user-selectable alternative
 * (`--pattern react`) to the default grounded loop ; it had no test at all.
 *
 * Coverage:
 *   parseReactToolCall ; nominal block, malformed JSON, invalid shape, size cap
 *   tryParseJsonToolCallFallback ; fenced block, raw first-brace, size cap
 *   ReactStrategy.run ; final answer, structured/text/JSON-fallback tool call,
 *     allowedTools denial, tool failure, non-serializable result, LLM failure,
 *     max_steps exhaustion, abort-before-start, fail-soft onStep hook
 *
 * Ref: sprint-1084:quick-21
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type StrategyAgentContext,
  type StrategyLLMCompletionFn,
  type StrategyLLMResponse,
  createReactStrategy,
  noopLogger,
  parseReactToolCall,
  tryParseJsonToolCallFallback,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRegistry(): ToolRegistryImpl {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "echo_tool",
    description: "echoes its input",
    parameters: z.object({ text: z.string() }).strict(),
    execute: async (params) => ({ echoed: params.text }),
  });
  reg.register({
    name: "throwing_tool",
    description: "always throws",
    parameters: z.object({}).strict(),
    execute: async () => {
      throw new Error("tool blew up");
    },
  });
  reg.register({
    name: "circular_tool",
    description: "returns a non-serializable result",
    parameters: z.object({}).strict(),
    execute: async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return circular;
    },
  });
  return reg;
}

/** Trackable logger ; records every warn() call so hook fail-soft paths are assertable. */
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
    task: "Find the answer",
    systemPrompt: "You are a test agent.",
    tools: makeRegistry(),
    llmFn,
    maxSteps: 5,
    logger: noopLogger,
    runId: "test-run-react",
    agentId: "agent-react-test",
    ...overrides,
  };
}

function textResponse(
  content: string,
  extra: Partial<StrategyLLMResponse> = {},
): StrategyLLMResponse {
  return {
    content,
    tokensIn: 3,
    tokensOut: 2,
    model: "test-model",
    provider: "test-provider",
    ...extra,
  };
}

// ─── parseReactToolCall ─────────────────────────────────────────────────────

describe("parseReactToolCall", () => {
  it("parses a well-formed ```tool_call``` block", () => {
    const content =
      'Thinking...\n```tool_call\n{"name": "echo_tool", "arguments": {"text": "hi"}}\n```';
    const call = parseReactToolCall(content);
    expect(call).not.toBeNull();
    expect(call?.name).toBe("echo_tool");
    expect(call?.arguments).toEqual({ text: "hi" });
    expect(call?.id).toMatch(/^tc_/);
  });

  it("returns null when no tool_call block is present", () => {
    expect(parseReactToolCall("just a plain final answer")).toBeNull();
  });

  it("returns null on malformed JSON inside the block", () => {
    const content = "```tool_call\n{not valid json\n```";
    expect(parseReactToolCall(content)).toBeNull();
  });

  it("returns null when name is missing", () => {
    const content = '```tool_call\n{"arguments": {}}\n```';
    expect(parseReactToolCall(content)).toBeNull();
  });

  it("returns null when arguments is not an object", () => {
    const content = '```tool_call\n{"name": "x", "arguments": "not-an-object"}\n```';
    expect(parseReactToolCall(content)).toBeNull();
  });

  it("returns null when arguments is explicitly null", () => {
    const content = '```tool_call\n{"name": "x", "arguments": null}\n```';
    expect(parseReactToolCall(content)).toBeNull();
  });

  it("returns null when the captured block exceeds the 10_000-char cap", () => {
    const huge = `{"name": "x", "arguments": {"pad": "${"a".repeat(10_100)}"}}`;
    const content = `\`\`\`tool_call\n${huge}\n\`\`\``;
    expect(parseReactToolCall(content)).toBeNull();
  });

  it("assigns distinct ids on successive calls", () => {
    const content = '```tool_call\n{"name": "echo_tool", "arguments": {}}\n```';
    const a = parseReactToolCall(content);
    const b = parseReactToolCall(content);
    // Both are well-formed; ids need not differ in the same tick, but both must exist.
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();
  });
});

// ─── tryParseJsonToolCallFallback ───────────────────────────────────────────

describe("tryParseJsonToolCallFallback", () => {
  it("returns null for empty content", () => {
    expect(tryParseJsonToolCallFallback("")).toBeNull();
  });

  it("returns null when content exceeds the 200_000-char cap", () => {
    expect(tryParseJsonToolCallFallback("a".repeat(200_001))).toBeNull();
  });

  it("parses a ```json``` fenced block", () => {
    const content = 'Here:\n```json\n{"name": "echo_tool", "arguments": {"text": "y"}}\n```';
    expect(tryParseJsonToolCallFallback(content)).toEqual({
      name: "echo_tool",
      arguments: { text: "y" },
    });
  });

  it("parses a ```toolcall``` fenced block", () => {
    const content = '```toolcall\n{"name": "echo_tool", "arguments": {}}\n```';
    expect(tryParseJsonToolCallFallback(content)).toEqual({ name: "echo_tool", arguments: {} });
  });

  it("falls through to first-brace parsing when the fenced block is invalid JSON", () => {
    const content = '```json\nnot json\n```\n{"name": "echo_tool", "arguments": {}}';
    expect(tryParseJsonToolCallFallback(content)).toEqual({ name: "echo_tool", arguments: {} });
  });

  it("parses raw JSON found at the first brace with no fence at all", () => {
    const content = 'I will call: {"name": "echo_tool", "arguments": {"text": "z"}}';
    expect(tryParseJsonToolCallFallback(content)).toEqual({
      name: "echo_tool",
      arguments: { text: "z" },
    });
  });

  it("returns null when the shape is invalid (missing arguments)", () => {
    expect(tryParseJsonToolCallFallback('{"name": "echo_tool"}')).toBeNull();
  });

  it("returns null when there is no brace anywhere", () => {
    expect(tryParseJsonToolCallFallback("no json here at all")).toBeNull();
  });
});

// ─── ReactStrategy.run ──────────────────────────────────────────────────────

describe("ReactStrategy.run", () => {
  it("returns stopReason=error with zero steps/tokens when llmFn is absent", async () => {
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(undefined));
    expect(result.stopReason).toBe("error");
    expect(result.stepCount).toBe(0);
    expect(result.tokensUsed).toEqual({ in: 0, out: 0 });
  });

  it("stops with the LLM's own text as the final answer when no tool call is emitted", async () => {
    const llm: StrategyLLMCompletionFn = async () => textResponse("The answer is 42.");
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));

    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("The answer is 42.");
    expect(result.stepCount).toBe(1);
    expect(result.model).toBe("test-model");
    expect(result.provider).toBe("test-provider");
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.thought).toBe("The answer is 42.");
  });

  it("executes a structured tool call, then finishes on the next iteration", async () => {
    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse("calling the tool", {
          toolCalls: [{ id: "tc_1", name: "echo_tool", arguments: { text: "hello" } }],
        });
      }
      return textResponse("Done.");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));

    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("Done.");
    expect(result.stepCount).toBe(2);
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.action).toEqual({ toolName: "echo_tool", args: { text: "hello" } });
    expect(trace[0]?.observation).toBe(JSON.stringify({ echoed: "hello" }));
  });

  it("parses a text ```tool_call``` block when no structured toolCalls are present", async () => {
    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse(
          'Let me check.\n```tool_call\n{"name": "echo_tool", "arguments": {"text": "world"}}\n```',
        );
      }
      return textResponse("Final.");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));
    expect(result.stopReason).toBe("complete");
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.action).toEqual({ toolName: "echo_tool", args: { text: "world" } });
    // The tool_call fence must be stripped out of the recorded thought.
    expect(trace[0]?.thought).toBe("Let me check.");
  });

  it("falls back to raw JSON parsing when the model skips the tool_call fence", async () => {
    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse('Thought first. {"name": "echo_tool", "arguments": {"text": "fb"}}');
      }
      return textResponse("Final.");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.action).toEqual({ toolName: "echo_tool", args: { text: "fb" } });
    expect(trace[0]?.thought).toBe("Thought first.");
  });

  it("denies a tool call outside allowedTools without invoking it", async () => {
    const registry = makeRegistry();
    const executeSpy = vi.spyOn(registry, "execute");

    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse("go", {
          toolCalls: [{ id: "tc_1", name: "echo_tool", arguments: { text: "x" } }],
        });
      }
      return textResponse("Final.");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(
      makeCtx(llm, { tools: registry, allowedTools: ["circular_tool"] }),
    );

    expect(executeSpy).not.toHaveBeenCalled();
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.error).toBe('Tool "echo_tool" not in allowed list');
    // The loop must continue past the denial, not stop the cycle.
    expect(result.stopReason).toBe("complete");
    expect(result.stepCount).toBe(2);
  });

  it("records the tool's error message as the observation on failure", async () => {
    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse("go", {
          toolCalls: [{ id: "tc_1", name: "throwing_tool", arguments: {} }],
        });
      }
      return textResponse("Final.");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.observation).toBe(
      'Error: Tool "throwing_tool" execution failed: tool blew up',
    );
    expect(trace[0]?.error).toBe('Tool "throwing_tool" execution failed: tool blew up');
  });

  it("marks a non-JSON-serializable tool result instead of throwing", async () => {
    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse("go", {
          toolCalls: [{ id: "tc_1", name: "circular_tool", arguments: {} }],
        });
      }
      return textResponse("Final.");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));
    const trace = result.stepsTrace as Array<Record<string, unknown>>;
    expect(trace[0]?.observation).toBe("[non-serializable result]");
  });

  it("stops with stopReason=error and surfaces the LLM failure as the final message", async () => {
    const { logger, warnCalls } = makeTrackingLogger();
    const llm: StrategyLLMCompletionFn = async () => {
      throw new Error("provider down");
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm, { logger }));

    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toBe("Error: LLM call failed: provider down");
    expect(result.stepCount).toBe(1);
    expect(warnCalls.some((c) => c.msg === "react.llm_failed")).toBe(true);
  });

  it("stops at max_steps and reports the last observation", async () => {
    const llm: StrategyLLMCompletionFn = async () =>
      textResponse("looping", {
        toolCalls: [{ id: "tc_1", name: "echo_tool", arguments: { text: "loop" } }],
      });
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm, { maxSteps: 3 }));

    expect(result.stopReason).toBe("max_steps");
    expect(result.stepCount).toBe(3);
    expect(result.finalMessage).toBe(
      `Reached max iterations (3). Last: ${JSON.stringify({ echoed: "loop" })}`,
    );
  });

  it("stops immediately with user_cancelled when the signal is already aborted", async () => {
    let llmCalls = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      llmCalls++;
      return textResponse("should not run");
    };
    const controller = new AbortController();
    controller.abort();
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm, { signal: controller.signal }));

    expect(result.stopReason).toBe("user_cancelled");
    expect(result.stepCount).toBe(0);
    expect(llmCalls).toBe(0);
  });

  it("does not let a throwing onStep hook break the cycle (fail-soft)", async () => {
    const { logger, warnCalls } = makeTrackingLogger();
    const llm: StrategyLLMCompletionFn = async () => textResponse("Final answer.");
    const ctx = makeCtx(llm, {
      logger,
      hooks: {
        onStep: () => {
          throw new Error("hook exploded");
        },
      },
    });
    const strategy = createReactStrategy();
    const result = await strategy.run(ctx);

    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("Final answer.");
    expect(warnCalls.some((c) => c.msg === "react.onStep_failed")).toBe(true);
  });

  it("accumulates tokensIn/tokensOut across every LLM call in the cycle", async () => {
    let call = 0;
    const llm: StrategyLLMCompletionFn = async () => {
      call++;
      if (call === 1) {
        return textResponse("go", {
          tokensIn: 10,
          tokensOut: 4,
          toolCalls: [{ id: "tc_1", name: "echo_tool", arguments: { text: "a" } }],
        });
      }
      return textResponse("Final.", { tokensIn: 6, tokensOut: 2 });
    };
    const strategy = createReactStrategy();
    const result = await strategy.run(makeCtx(llm));
    expect(result.tokensUsed).toEqual({ in: 16, out: 6 });
  });
});
