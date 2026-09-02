/**
 * LLMProviderPort — BYOM (Bring Your Own Model) abstraction.
 *
 * BYOM axiom (Brain entry 4fa36aad): the SDK ships ZERO default provider.
 * Callers inject the concrete adapter at boot. No model name is hardcoded
 * in this port file or any file that re-exports it.
 *
 * Plan v6 §3.2 — canonical interface.
 *
 * OTel instrumentation: import { createTracedLLMProviderPort } to wrap any
 * LLMProviderPort implementation with OpenTelemetry spans per completion.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 *
 * @public
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Optional non-text inputs attached to this message (multimodal). Adapters
   * that support vision (e.g. LiteLLMAdapter -> a vision-capable model) fold
   * these into the provider's content-block format ; text-only adapters ignore
   * them. Additive + optional by design: `content` stays the canonical text, so
   * every existing `{role, content}` caller is unaffected.
   * @since beyond-hermes-multimodal
   */
  attachments?: MessageAttachment[];
}

/**
 * A non-text input on a ChatMessage ; discriminated by `kind` for future media.
 * @public
 */
export interface ImageAttachment {
  kind: "image";
  /** IANA media type, e.g. "image/png", "image/jpeg", "image/webp". */
  mediaType: string;
  /** Base64-encoded image bytes (NO `data:` prefix ; adapters add it). */
  dataBase64: string;
}

/** @public */
export type MessageAttachment = ImageAttachment;

/** @public */
export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  metadata?: {
    tenantId?: string;
    agentId?: string;
    correlationId?: string;
  };
}

/** @public */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD. Optional — adapters that cannot compute it omit this field. */
  costUsd?: number;
  /** Tokens written to the prompt cache (Anthropic cache_creation_input_tokens). @since 1.13.0 */
  readonly cacheCreationTokens?: number;
  /** Tokens read from the prompt cache (Anthropic cache_read_input_tokens). @since 1.13.0 */
  readonly cacheReadTokens?: number;
}

/** @public */
export interface ChatResponse {
  content: string;
  usage: ChatUsage;
  model: string;
  finishReason: "stop" | "length" | "tool" | "error";
}

/** @public */
export interface StreamDelta {
  delta: string;
  usage?: ChatUsage;
}

/** @public */
export interface LLMProviderPort {
  /**
   * Blocking completion — resolves when the full response is available.
   * Never rejects on model error: return `finishReason: "error"` instead.
   */
  complete(req: ChatRequest): Promise<ChatResponse>;

  /**
   * Optional streaming completion.
   * Each yielded chunk carries at minimum `delta`; final chunk may carry `usage`.
   */
  stream?(req: ChatRequest): AsyncIterable<StreamDelta>;

  /**
   * Optional cost estimation before a real call.
   * Must be monotonically non-decreasing with token count.
   */
  estimateCost?(req: ChatRequest): { usd: number };
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Base class for all LLM provider errors.
 * Concrete implementations throw subclasses so callers can switch on error type.
 * @public
 */
export class LLMProviderError extends Error {
  /** The provider identifier (e.g. "groq", "litellm", "anthropic"). */
  readonly provider: string;
  /** The model that was being called (e.g. "llama-3.3-70b"). */
  readonly model: string;

  constructor(
    message: string,
    provider: string,
    model: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMProviderError";
    this.provider = provider;
    this.model = model;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the LLM provider returns 429 (rate limit exceeded).
 * Callers should retry after the delay indicated in `retryAfterMs`
 * or switch to a fallback provider.
 * @public
 */
export class LLMRateLimitError extends LLMProviderError {
  /** Retry-After delay in milliseconds. */
  readonly retryAfterMs: number;

  constructor(
    message: string,
    provider: string,
    model: string,
    retryAfterMs: number,
    cause?: unknown,
  ) {
    super(message, provider, model, cause);
    this.name = "LLMRateLimitError";
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── OTel-traced wrapper ──────────────────────────────────────────────────────

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const PORT_TRACER = trace.getTracer("vauban-agent-sdk.ports", "0.1.0");

/**
 * Wrap any LLMProviderPort implementation with OTel spans per complete() call.
 * The span captures the model, provider, and token usage on success.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 *
 * Usage:
 *   const raw: LLMProviderPort = buildAnthropicAdapter(...);
 *   const traced = createTracedLLMProviderPort(raw);
 *   const resp = await traced.complete(req) // emits "llm-provider.complete" span
 */
export function createTracedLLMProviderPort(impl: LLMProviderPort): LLMProviderPort {
  return {
    async complete(req) {
      return PORT_TRACER.startActiveSpan(
        "llm-provider.complete",
        {
          attributes: {
            "gen_ai.request.model": req.model ?? "unknown",
            "gen_ai.request.message_count": req.messages.length,
            "vauban.port.name": "llm-provider",
          },
        },
        async (span: Span) => {
          try {
            const resp = await impl.complete(req);
            span.setAttributes({
              "gen_ai.usage.input_tokens": resp.usage.inputTokens,
              "gen_ai.usage.output_tokens": resp.usage.outputTokens,
              "gen_ai.response.model": resp.model,
              "gen_ai.response.finish_reasons": [resp.finishReason],
            });
            if (resp.usage.costUsd !== undefined) {
              span.setAttribute("gen_ai.usage.cost_usd", resp.usage.costUsd);
            }
            span.setStatus({ code: SpanStatusCode.OK });
            return resp;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            if (err instanceof Error) span.recordException(err);
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },

    async *stream(req) {
      if (!impl.stream) return;
      for await (const chunk of impl.stream(req)) {
        yield chunk;
      }
    },

    estimateCost(req: ChatRequest): { usd: number } {
      return impl.estimateCost?.(req) ?? { usd: 0 };
    },
  };
}
