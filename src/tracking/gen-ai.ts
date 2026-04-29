/**
 * tracking/gen-ai — OpenTelemetry GenAI semantic conventions wrapper.
 *
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Scope: thin helpers that create spans with the standard `gen_ai.*`
 * attribute set. Each helper returns the span so the caller can add
 * provider-specific attributes and call `.end()` when done — mirrors the
 * `@opentelemetry/api` ergonomics.
 *
 * Custom Vauban attributes (not in spec):
 *   - gen_ai.agent.run_id     (our runId; used for replay linkage)
 *   - gen_ai.agent.compacted  (event marker — emitted by AgentLoop)
 */

import { type Span, type Tracer, trace } from "@opentelemetry/api";

const TRACER_VERSION = "0.1.0";

export function getTracer(name = "vauban-agent-sdk"): Tracer {
  return trace.getTracer(name, TRACER_VERSION);
}

// ─── LLM span ─────────────────────────────────────────────────────────────

export function llmSpan(
  tracer: Tracer,
  request: {
    provider: string;
    model: string;
    maxTokens?: number;
    messageCount?: number;
  },
): Span {
  const span = tracer.startSpan(`gen_ai.${request.provider}.chat`);
  span.setAttribute("gen_ai.operation.name", "chat");
  span.setAttribute("gen_ai.system", request.provider);
  span.setAttribute("gen_ai.request.model", request.model);
  if (request.maxTokens !== undefined) {
    span.setAttribute("gen_ai.request.max_tokens", request.maxTokens);
  }
  if (request.messageCount !== undefined) {
    span.setAttribute("gen_ai.request.message_count", request.messageCount);
  }
  return span;
}

export function recordLlmUsage(
  span: Span,
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    finishReason?: string;
  },
): void {
  span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  span.setAttribute("gen_ai.latency_ms", usage.latencyMs);
  if (usage.finishReason) {
    span.setAttribute("gen_ai.response.finish_reasons", [usage.finishReason]);
  }
}

// ─── Tool span ────────────────────────────────────────────────────────────

export function toolSpan(
  tracer: Tracer,
  toolName: string,
  args: unknown,
): Span {
  const span = tracer.startSpan(`gen_ai.tool.${toolName}`);
  span.setAttribute("gen_ai.operation.name", "tool");
  span.setAttribute("gen_ai.tool.name", toolName);
  try {
    const serialized = JSON.stringify(args);
    if (typeof serialized === "string") {
      // Cap to avoid attribute bloat.
      span.setAttribute("gen_ai.tool.args_preview", serialized.slice(0, 500));
    }
  } catch {
    // Unserialisable args — skip the preview rather than fail the span.
  }
  return span;
}

export function recordToolResult(
  span: Span,
  result: {
    success: boolean;
    errorMessage?: string;
    outputSizeBytes?: number;
  },
): void {
  span.setAttribute("gen_ai.tool.success", result.success);
  if (result.errorMessage) {
    span.setAttribute("gen_ai.tool.error_message", result.errorMessage);
  }
  if (result.outputSizeBytes !== undefined) {
    span.setAttribute("gen_ai.tool.output_size_bytes", result.outputSizeBytes);
  }
}

// ─── Agent span ───────────────────────────────────────────────────────────

export function agentSpan(
  tracer: Tracer,
  opts: { agentId: string; agentVersion: string; runId: string },
): Span {
  const span = tracer.startSpan(`gen_ai.agent.${opts.agentId}`);
  span.setAttribute("gen_ai.operation.name", "agent");
  span.setAttribute("gen_ai.agent.id", opts.agentId);
  span.setAttribute("gen_ai.agent.version", opts.agentVersion);
  span.setAttribute("gen_ai.agent.run_id", opts.runId);
  return span;
}

/**
 * recordOutcome — convenience helper to stamp the final outcome of an agent
 * run onto an existing span. Call from the loop's finally block.
 */
export function recordOutcome(
  span: Span,
  outcome: {
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
    stepCount?: number;
  },
): void {
  span.setAttribute("gen_ai.agent.stop_reason", outcome.stopReason);
  span.setAttribute("gen_ai.usage.input_tokens", outcome.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", outcome.outputTokens);
  if (outcome.stepCount !== undefined) {
    span.setAttribute("gen_ai.agent.step_count", outcome.stepCount);
  }
}
