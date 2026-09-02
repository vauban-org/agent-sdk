/**
 * Tests for packages/agent-sdk/src/tracking/gen-ai.ts
 *
 * Coverage:
 *   llmSpan — required attributes, optional attributes (only set when provided)
 *   recordLlmUsage — input/output tokens, model, finish reason
 *   toolSpan — name, required attributes, args preview (capped at 500)
 *   recordToolResult — success flag, error message, output size
 *   agentSpan — agent attributes
 *   recordOutcome — stop reason, tokens, optional stepCount
 *
 * Ref: test coverage for agent-sdk/tracking/gen-ai.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";

// Mock OTEL API
function makeSpan() {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    setAttribute: vi.fn((k: string, v: unknown) => {
      attrs[k] = v;
    }),
    end: vi.fn(),
  };
}

function makeTracer() {
  const span = makeSpan();
  return {
    span,
    startSpan: vi.fn().mockReturnValue(span),
  };
}

vi.mock("@opentelemetry/api", () => ({
  trace: { getTracer: vi.fn() },
}));

const { llmSpan, recordLlmUsage, toolSpan, recordToolResult, agentSpan, recordOutcome } =
  await import("../src/tracking/gen-ai.js");

// ─── llmSpan ──────────────────────────────────────────────────────────────────

describe("llmSpan", () => {
  it("sets required gen_ai attributes", () => {
    const tracer = makeTracer();
    llmSpan(tracer as never, { provider: "groq", model: "llama-3.3-70b" });
    const span = tracer.span;
    expect(span.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(span.attrs["gen_ai.system"]).toBe("groq");
    expect(span.attrs["gen_ai.request.model"]).toBe("llama-3.3-70b");
  });

  it("sets optional attributes when provided", () => {
    const tracer = makeTracer();
    llmSpan(tracer as never, {
      provider: "groq",
      model: "llama",
      maxTokens: 4096,
      temperature: 0.7,
      topP: 0.9,
      seed: 42,
      messageCount: 3,
    });
    const span = tracer.span;
    expect(span.attrs["gen_ai.request.max_tokens"]).toBe(4096);
    expect(span.attrs["gen_ai.request.temperature"]).toBe(0.7);
    expect(span.attrs["gen_ai.request.top_p"]).toBe(0.9);
    expect(span.attrs["gen_ai.request.seed"]).toBe(42);
    expect(span.attrs["gen_ai.request.message_count"]).toBe(3);
  });

  it("does NOT set optional attributes when absent", () => {
    const tracer = makeTracer();
    llmSpan(tracer as never, { provider: "groq", model: "llama" });
    const span = tracer.span;
    expect(span.attrs["gen_ai.request.max_tokens"]).toBeUndefined();
    expect(span.attrs["gen_ai.request.temperature"]).toBeUndefined();
  });
});

// ─── recordLlmUsage ───────────────────────────────────────────────────────────

describe("recordLlmUsage", () => {
  it("records tokens, latency, and finish reason", () => {
    const span = makeSpan();
    recordLlmUsage(span as never, {
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 250,
      finishReason: "stop",
    });
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(span.attrs["gen_ai.latency_ms"]).toBe(250);
    expect(span.attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
  });

  it("does not set finish_reasons when absent", () => {
    const span = makeSpan();
    recordLlmUsage(span as never, {
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });
    expect(span.attrs["gen_ai.response.finish_reasons"]).toBeUndefined();
  });
});

// ─── toolSpan ─────────────────────────────────────────────────────────────────

describe("toolSpan", () => {
  it("sets tool name and gen_ai.operation.name", () => {
    const tracer = makeTracer();
    toolSpan(tracer as never, "brain.query", {});
    const span = tracer.span;
    expect(span.attrs["gen_ai.tool.name"]).toBe("brain.query");
    expect(span.attrs["gen_ai.operation.name"]).toBe("tool");
  });

  it("serializes args as preview (capped at 500 chars)", () => {
    const tracer = makeTracer();
    const longArgs = { data: "x".repeat(1000) };
    toolSpan(tracer as never, "t", longArgs);
    const preview = tracer.span.attrs["gen_ai.tool.args_preview"] as string;
    expect(typeof preview).toBe("string");
    expect(preview.length).toBeLessThanOrEqual(500);
  });

  it("sets args_preview for serializable args", () => {
    const tracer = makeTracer();
    toolSpan(tracer as never, "t", { key: "val" });
    expect(typeof tracer.span.attrs["gen_ai.tool.args_preview"]).toBe("string");
  });
});

// ─── recordToolResult ─────────────────────────────────────────────────────────

describe("recordToolResult", () => {
  it("records success flag", () => {
    const span = makeSpan();
    recordToolResult(span as never, { success: true });
    expect(span.attrs["gen_ai.tool.success"]).toBe(true);
  });

  it("records error message when provided", () => {
    const span = makeSpan();
    recordToolResult(span as never, {
      success: false,
      errorMessage: "timeout",
    });
    expect(span.attrs["gen_ai.tool.error_message"]).toBe("timeout");
  });

  it("does not set error_message when absent", () => {
    const span = makeSpan();
    recordToolResult(span as never, { success: true });
    expect(span.attrs["gen_ai.tool.error_message"]).toBeUndefined();
  });

  it("records output size when provided", () => {
    const span = makeSpan();
    recordToolResult(span as never, { success: true, outputSizeBytes: 1024 });
    expect(span.attrs["gen_ai.tool.output_size_bytes"]).toBe(1024);
  });
});

// ─── agentSpan ────────────────────────────────────────────────────────────────

describe("agentSpan", () => {
  it("sets agent id, version, and run_id", () => {
    const tracer = makeTracer();
    agentSpan(tracer as never, {
      agentId: "forge",
      agentVersion: "1.0.0",
      runId: "run-abc",
    });
    const span = tracer.span;
    expect(span.attrs["gen_ai.agent.id"]).toBe("forge");
    expect(span.attrs["gen_ai.agent.version"]).toBe("1.0.0");
    expect(span.attrs["gen_ai.agent.run_id"]).toBe("run-abc");
    expect(span.attrs["gen_ai.operation.name"]).toBe("agent");
  });
});

// ─── recordOutcome ────────────────────────────────────────────────────────────

describe("recordOutcome", () => {
  it("records stop reason and token counts", () => {
    const span = makeSpan();
    recordOutcome(span as never, {
      stopReason: "max_steps",
      inputTokens: 5000,
      outputTokens: 1200,
    });
    expect(span.attrs["gen_ai.agent.stop_reason"]).toBe("max_steps");
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(5000);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(1200);
  });

  it("records stepCount when provided", () => {
    const span = makeSpan();
    recordOutcome(span as never, {
      stopReason: "done",
      inputTokens: 100,
      outputTokens: 50,
      stepCount: 7,
    });
    expect(span.attrs["gen_ai.agent.step_count"]).toBe(7);
  });

  it("does not set step_count when absent", () => {
    const span = makeSpan();
    recordOutcome(span as never, {
      stopReason: "done",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(span.attrs["gen_ai.agent.step_count"]).toBeUndefined();
  });
});
