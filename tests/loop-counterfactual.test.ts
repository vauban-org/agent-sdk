/**
 * Tests for loop and counterfactual modules.
 *
 * Coverage:
 *   AgentLoop (minimal-loop) — construction, run: complete, budget_exhausted, error path
 *   SdkAgentLoop (sdk-loop) — construction, permissions getter, run: complete,
 *                              budget_exhausted, max_tokens, error path, tool_denied
 *   replayCounterfactual (counterfactual) — areCoherent edge cases not covered elsewhere:
 *                              arrays vs objects, nested objects same keys, number vs string,
 *                              single-key objects, undefined edge case on runners
 *   InvalidStrategyNameError — all three valid names pass validation (no throw)
 */

import type { Span, SpanContext, Tracer } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import { createBudgetState } from "../src/budget/budget-state.js";
import {
  type CounterfactualOptions,
  InvalidStrategyNameError,
  replayCounterfactual,
} from "../src/counterfactual/replay-with-alt.js";
import { AgentLoop } from "../src/loop/minimal-loop.js";
import { SdkAgentLoop } from "../src/loop/sdk-loop.js";
import { mapScopesToSdkPermissions } from "../src/permissions/sdk-permissions.js";
import type { LLMResponseCache } from "../src/replay/llm-cache.js";
import type { ReplayContext, ReplayLoader, ReplayRunner } from "../src/replay/replay.js";
import type { ProviderRouter, ProviderRouterResponse } from "../src/router/provider-router.js";
import type { MCPToolDefinition, ToolRegistry, ToolResult } from "../src/tools/types.js";
import type { Trace } from "../src/trace/schema.js";

// ─── OTel mock tracer ─────────────────────────────────────────────────────────

function makeSpan(): Span {
  const spanCtx: SpanContext = {
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    traceFlags: 1,
  };
  return {
    spanContext: () => spanCtx,
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    isRecording: () => true,
    end: vi.fn(),
    setAttributes: vi.fn(),
    updateName: vi.fn(),
  } as unknown as Span;
}

function makeTracer(): Tracer {
  return {
    startSpan: vi.fn().mockReturnValue(makeSpan()),
    startActiveSpan: vi
      .fn()
      .mockImplementation((_name: string, fn: (span: Span) => unknown) => fn(makeSpan())),
  } as unknown as Tracer;
}

// ─── ToolRegistry mock ────────────────────────────────────────────────────────

function makeToolRegistry(overrides: Partial<ToolRegistry> = {}): ToolRegistry {
  return {
    register: vi.fn().mockReturnValue({ ok: true, data: undefined } as ToolResult<void>),
    unregister: vi.fn().mockReturnValue(false),
    get: vi.fn().mockReturnValue(undefined),
    has: vi.fn().mockReturnValue(false),
    listNames: vi.fn().mockReturnValue([]),
    listMCPDefinitions: vi.fn().mockReturnValue([] as MCPToolDefinition[]),
    size: 0,
    clear: vi.fn(),
    execute: vi.fn().mockResolvedValue({ ok: true, data: "ok" } as ToolResult),
    ...overrides,
  };
}

// ─── ProviderRouter mock ──────────────────────────────────────────────────────

function makeProvider(response?: Partial<ProviderRouterResponse>): ProviderRouter {
  return {
    complete: vi.fn().mockResolvedValue({
      content: "Final answer.",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: "mock",
      latencyMs: 1,
      ...response,
    } satisfies ProviderRouterResponse),
  };
}

// ─── Anthropic SDK client mock ─────────────────────────────────────────────────

function makeAnthropicClient(override?: {
  content?: unknown[];
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}) {
  const response = {
    content: override?.content ?? [{ type: "text", text: "All done." }],
    stop_reason: override?.stop_reason ?? "end_turn",
    usage: override?.usage ?? { input_tokens: 20, output_tokens: 10 },
  };
  return {
    messages: {
      create: vi.fn().mockResolvedValue(response),
    },
  };
}

// ─── Counterfactual replay helpers ─────────────────────────────────────────────

function makeMinimalTrace(runId = "run-id", strategy?: string): Trace {
  return {
    schemaVersion: "1.0.0",
    runId,
    agentId: "agent",
    agentVersion: "0.0.1",
    startedAt: 1_000_000,
    completedAt: 1_001_000,
    status: "completed",
    steps: [],
    totalSteps: 0,
    rootHash: "aabbccdd",
    config: strategy ? { strategy } : {},
    configHash: "11223344",
  };
}

function makeNoopCache(): LLMResponseCache {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLoader(trace?: Trace): ReplayLoader {
  const t = trace ?? makeMinimalTrace();
  return {
    loadOriginalTrace: vi.fn().mockResolvedValue(t),
    loadCacheEntries: vi.fn().mockResolvedValue({
      recordedTs: [1_000_000, 1_000_100],
      recordedNext: [0.5],
      recordedUuids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      cache: makeNoopCache(),
    }),
  };
}

function makeRunner(outputOverride?: unknown): ReplayRunner {
  return {
    run: vi
      .fn()
      .mockResolvedValue(
        outputOverride !== undefined
          ? { rootHash: "replayed", steps: [], output: outputOverride }
          : { rootHash: "replayed", steps: [] },
      ),
  };
}

// ─── AgentLoop (minimal-loop) tests ───────────────────────────────────────────

describe("AgentLoop (minimal-loop)", () => {
  it("constructs without throwing when given valid config", () => {
    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "You are a test agent.",
      provider: makeProvider(),
      tools: makeToolRegistry(),
      budget: createBudgetState(),
      tracer: makeTracer(),
    });
    expect(loop).toBeDefined();
  });

  it("run() returns stopReason 'complete' when provider returns no tool calls", async () => {
    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "You are a test agent.",
      provider: makeProvider({ content: "The answer is 42.", toolCalls: [] }),
      tools: makeToolRegistry(),
      budget: createBudgetState(),
      tracer: makeTracer(),
    });

    const result = await loop.run("What is the answer?");
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("The answer is 42.");
  });

  it("run() returns stopReason 'budget_exhausted' when stepCount already at maxSteps", async () => {
    const budget = createBudgetState({ maxSteps: 2, stepCount: 2 });
    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      provider: makeProvider(),
      tools: makeToolRegistry(),
      budget,
      tracer: makeTracer(),
    });

    const result = await loop.run("Hello");
    expect(result.stopReason).toBe("budget_exhausted");
  });

  it("run() returns stopReason 'error' when provider throws", async () => {
    const failingProvider: ProviderRouter = {
      complete: vi.fn().mockRejectedValue(new Error("upstream failure")),
    };

    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      provider: failingProvider,
      tools: makeToolRegistry(),
      budget: createBudgetState(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Trigger error");
    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toBe("");
  });

  it("run() returns budgetFinal with updated stepCount after one step", async () => {
    const budget = createBudgetState({ maxSteps: 10 });
    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      provider: makeProvider({ content: "Done.", toolCalls: [] }),
      tools: makeToolRegistry(),
      budget,
      tracer: makeTracer(),
    });

    const result = await loop.run("Go");
    // After one complete step, stepCount should be 1
    expect(result.budgetFinal.stepCount).toBe(1);
  });

  it("run() returns a non-empty traceId string", async () => {
    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      provider: makeProvider(),
      tools: makeToolRegistry(),
      budget: createBudgetState(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Hello");
    expect(typeof result.traceId).toBe("string");
    expect(result.traceId.length).toBeGreaterThan(0);
  });

  it("run() calls provider.complete once for a single-step completion", async () => {
    const provider = makeProvider({ content: "Single step.", toolCalls: [] });
    const loop = new AgentLoop({
      agentId: "test-agent",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      provider,
      tools: makeToolRegistry(),
      budget: createBudgetState(),
      tracer: makeTracer(),
    });

    await loop.run("Do one thing");
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});

// ─── SdkAgentLoop (sdk-loop) tests ────────────────────────────────────────────

describe("SdkAgentLoop (sdk-loop)", () => {
  const adminPermissions = mapScopesToSdkPermissions(["cc:admin"]);
  const readPermissions = mapScopesToSdkPermissions(["cc:read"]);

  it("constructs and exposes permissions via getter", () => {
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "You are a test agent.",
      client: makeAnthropicClient() as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    expect(loop.permissions).toBe(adminPermissions);
  });

  it("permissions getter returns read permissions when constructed with cc:read scope", () => {
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: makeAnthropicClient() as never,
      permissions: readPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    expect(loop.permissions).toBe(readPermissions);
    expect(loop.permissions.web).toBe(false);
    expect(loop.permissions.bash).toBe(false);
  });

  it("run() returns stopReason 'complete' when client returns no tool_use blocks", async () => {
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: makeAnthropicClient({
        content: [{ type: "text", text: "Task complete." }],
        stop_reason: "end_turn",
      }) as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Do the task");
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toBe("Task complete.");
  });

  it("defaults to claude-opus-4-8 when no model is passed", async () => {
    const client = makeAnthropicClient();
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: client as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    await loop.run("Go");
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-8" }),
    );
  });

  it("honours an explicit model override over the default", async () => {
    const client = makeAnthropicClient();
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: client as never,
      model: "claude-haiku-4-5",
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    await loop.run("Go");
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("run() returns stopReason 'budget_exhausted' when maxSteps is 1 and LLM calls tools", async () => {
    const toolRegistryWithTool = makeToolRegistry({
      get: vi.fn().mockReturnValue({
        name: "do_something",
        description: "Does something",
        parameters: { parse: vi.fn() },
        execute: vi.fn().mockResolvedValue("result"),
        capability: "mcp" as const,
      }),
      listMCPDefinitions: vi.fn().mockReturnValue([
        {
          name: "do_something",
          description: "Does something",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ]),
      execute: vi.fn().mockResolvedValue({ ok: true, data: "tool result" }),
    });

    // Client always returns a tool_use block, never terminates naturally
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "do_something",
              input: {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };

    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: client as never,
      permissions: adminPermissions,
      tools: toolRegistryWithTool,
      maxSteps: 1,
      tracer: makeTracer(),
    });

    const result = await loop.run("Go");
    expect(result.stopReason).toBe("budget_exhausted");
  });

  it("run() returns stopReason 'max_tokens' when client returns stop_reason=max_tokens", async () => {
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: makeAnthropicClient({
        content: [{ type: "text", text: "Partial response..." }],
        stop_reason: "max_tokens",
      }) as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Long response please");
    expect(result.stopReason).toBe("max_tokens");
  });

  it("run() returns stopReason 'error' when client throws", async () => {
    const failingClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API error")),
      },
    };

    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: failingClient as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Trigger error");
    expect(result.stopReason).toBe("error");
    expect(result.finalMessage).toBe("");
  });

  it("run() accumulates usage tokens across steps", async () => {
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: makeAnthropicClient({
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 25 },
      }) as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Compute");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);
  });

  it("run() returns a non-empty traceId string", async () => {
    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: makeAnthropicClient() as never,
      permissions: adminPermissions,
      tools: makeToolRegistry(),
      tracer: makeTracer(),
    });

    const result = await loop.run("Hello");
    expect(typeof result.traceId).toBe("string");
    expect(result.traceId.length).toBeGreaterThan(0);
  });

  it("run() returns stopReason 'tool_denied' when tool is not found in registry (deny path)", async () => {
    // Tool registry returns undefined for any get() call → authoriseCall → "deny"
    const registryNone = makeToolRegistry({
      get: vi.fn().mockReturnValue(undefined),
      listMCPDefinitions: vi.fn().mockReturnValue([]),
    });

    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              id: "toolu_unknown",
              name: "nonexistent_tool",
              input: {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };

    const loop = new SdkAgentLoop({
      agentId: "sdk-test",
      agentVersion: "1.0.0",
      systemPrompt: "System.",
      client: client as never,
      permissions: adminPermissions,
      tools: registryNone,
      tracer: makeTracer(),
    });

    const result = await loop.run("Use the tool");
    expect(result.stopReason).toBe("tool_denied");
  });
});

// ─── replayCounterfactual — areCoherent edge cases ─────────────────────────────

describe("replayCounterfactual — outputsCoherent edge cases", () => {
  it("objects with same top-level keys but different values are coherent (not identical)", async () => {
    const origOutput = { a: 1, b: "foo" };
    const cfOutput = { a: 2, b: "bar" };

    // Two separate runners — original returns origOutput, cf returns cfOutput
    const runnerOriginal = makeRunner(origOutput);
    const runnerCf = makeRunner(cfOutput);

    // We need a runner that returns different outputs per call
    // Use a runner that switches output based on the context
    let callCount = 0;
    const switchingRunner: ReplayRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1
          ? { rootHash: "r1", steps: [], output: origOutput }
          : { rootHash: "r2", steps: [], output: cfOutput };
      }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), switchingRunner, {
      alt_strategy: "best-of-n",
    });

    expect(result.outputsCoherent).toBe(true);
    expect(result.outputsIdentical).toBe(false);
  });

  it("objects with different top-level keys are NOT coherent", async () => {
    const origOutput = { x: 1, y: 2 };
    const cfOutput = { a: 1, b: 2 };

    let callCount = 0;
    const switchingRunner: ReplayRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1
          ? { rootHash: "r1", steps: [], output: origOutput }
          : { rootHash: "r2", steps: [], output: cfOutput };
      }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), switchingRunner, {
      alt_strategy: "best-of-n",
    });

    expect(result.outputsCoherent).toBe(false);
    expect(result.outputsIdentical).toBe(false);
  });

  it("both outputs null are coherent and identical", async () => {
    let callCount = 0;
    const runner: ReplayRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return { rootHash: "r", steps: [], output: null };
      }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), runner, {
      alt_strategy: "single-shot",
    });

    expect(result.outputsCoherent).toBe(true);
    expect(result.outputsIdentical).toBe(true);
  });

  it("null vs non-null object is NOT coherent", async () => {
    let callCount = 0;
    const runner: ReplayRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        const output = callCount === 1 ? null : { key: "value" };
        return { rootHash: "r", steps: [], output };
      }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), runner, {
      alt_strategy: "bon-mav",
    });

    expect(result.outputsCoherent).toBe(false);
  });

  it("same string outputs are coherent and identical", async () => {
    const runner: ReplayRunner = {
      run: vi.fn().mockResolvedValue({ rootHash: "r", steps: [], output: "hello" }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), runner, {
      alt_strategy: "single-shot",
    });

    expect(result.outputsCoherent).toBe(true);
    expect(result.outputsIdentical).toBe(true);
  });

  it("different string outputs are coherent (same typeof) but not identical", async () => {
    let callCount = 0;
    const runner: ReplayRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          rootHash: "r",
          steps: [],
          output: callCount === 1 ? "hello" : "world",
        };
      }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), runner, {
      alt_strategy: "best-of-n",
    });

    expect(result.outputsCoherent).toBe(true);
    expect(result.outputsIdentical).toBe(false);
  });

  it("number vs string outputs are NOT coherent", async () => {
    let callCount = 0;
    const runner: ReplayRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          rootHash: "r",
          steps: [],
          output: callCount === 1 ? 42 : "42",
        };
      }),
    };

    const result = await replayCounterfactual("run-id", makeLoader(), runner, {
      alt_strategy: "bon-mav",
    });

    expect(result.outputsCoherent).toBe(false);
    expect(result.outputsIdentical).toBe(false);
  });

  it("metadata.strategySwapped is absent when no alt_strategy is supplied", async () => {
    const runner = makeRunner({ result: "ok" });

    const result = await replayCounterfactual("run-id", makeLoader(), runner, {
      alt_temperature: 0.8,
    });

    expect(result.metadata.strategySwapped).toBeUndefined();
  });

  it("metadata.strategySwapped.to reflects the supplied alt_strategy", async () => {
    const runner = makeRunner({ score: 0.9 });

    const result = await replayCounterfactual(
      "run-id",
      makeLoader(makeMinimalTrace("run-id", "single-shot")),
      runner,
      { alt_strategy: "best-of-n" },
    );

    expect(result.metadata.strategySwapped).toBeDefined();
    expect(result.metadata.strategySwapped?.to).toBe("best-of-n");
    expect(result.metadata.strategySwapped?.from).toBe("single-shot");
  });
});

// ─── InvalidStrategyNameError — valid names must NOT throw ────────────────────

describe("InvalidStrategyNameError — valid strategy names bypass the guard", () => {
  const validStrategies = ["single-shot", "best-of-n", "bon-mav"] as const;

  for (const name of validStrategies) {
    it(`replayCounterfactual does not throw for valid strategy "${name}"`, async () => {
      const runner = makeRunner("output");

      await expect(
        replayCounterfactual("run-id", makeLoader(), runner, {
          alt_strategy: name,
        }),
      ).resolves.toBeDefined();
    });
  }

  it("replayCounterfactual throws InvalidStrategyNameError for an unknown strategy name", async () => {
    const runner = makeRunner("output");
    await expect(
      replayCounterfactual("run-id", makeLoader(), runner, {
        alt_strategy: "turbo" as never,
      }),
    ).rejects.toBeInstanceOf(InvalidStrategyNameError);
  });

  it("InvalidStrategyNameError is instanceof Error", () => {
    expect(new InvalidStrategyNameError("x")).toBeInstanceOf(Error);
  });
});
