/**
 * LiteLLMAdapter — OpenAI-compatible adapter for LiteLLM proxy.
 *
 * Uses native fetch (Node 18+). Retries transient failures (429, 5xx,
 * network errors) with exponential back-off + jitter via the shared
 * `retry()` primitive (max 3 attempts). No axios.
 * Cost extracted from usage field when available.
 *
 * BYOM: defaultModel is a constructor param default only.
 * No model string is hardcoded at module scope.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProviderPort,
  StreamDelta,
} from "../../ports/llm-provider.js";
import { type RetryConfig, retry } from "../../retry/index.js";

const ADAPTER_TRACER = trace.getTracer("vauban-agent-sdk.llm.litellm", "0.1.0");

/** @public */
export interface LiteLLMAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
}

/** OpenAI content block ; text or an inline image (vision-capable models). */
type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentBlock[];
}

/**
 * Map ChatMessages to OpenAI wire messages. A message with image attachments
 * becomes a content-block array (text + image_url data URLs) for a
 * vision-capable model ; a text-only message keeps a plain string (so the wire
 * shape is byte-identical to before for every existing caller).
 */
function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content };
    }
    const blocks: OpenAIContentBlock[] = [{ type: "text", text: m.content }];
    for (const a of m.attachments) {
      if (a.kind === "image") {
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${a.mediaType};base64,${a.dataBase64}` },
        });
      }
    }
    return { role: m.role, content: blocks };
  });
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

interface OpenAIChoice {
  message: { content: string | null };
  finish_reason: string | null;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
  model?: string;
}

// Tokens per USD — approximate LiteLLM defaults for cost estimation.
const INPUT_TOKENS_PER_USD = 500_000;
const OUTPUT_TOKENS_PER_USD = 250_000;

const MAX_RETRIES = 3;

// Base delay unified across error classes (network error, 5xx, 429) — the
// shared retry() primitive applies one RetryConfig per call, so the two
// distinct backoff bases the hand-rolled loop used (500ms / 1000ms) are
// collapsed to the transient-network base. Retry count and which
// conditions retry are unchanged.
const LITELLM_RETRY_BASE_MS = 500;
const LITELLM_RETRY_CAP_MS = 10_000;

/** Thrown when the fetch() call itself fails (network error, DNS, etc.). */
class LiteLLMNetworkError extends Error {
  constructor(cause: unknown) {
    super(`LiteLLM network error: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LiteLLMNetworkError";
  }
}

/** Thrown on a non-ok HTTP response. Retryable iff status is 429 or >= 500. */
class LiteLLMHttpError extends Error {
  constructor(public readonly status: number) {
    super(`LiteLLM HTTP ${status}`);
    this.name = "LiteLLMHttpError";
  }
}

/** Thrown when req.abortSignal is (or becomes) aborted. Never retryable. */
class LiteLLMAbortedError extends Error {
  constructor() {
    super("LiteLLM request aborted");
    this.name = "LiteLLMAbortedError";
  }
}

function buildRetryConfig(req: ChatRequest): RetryConfig {
  return {
    maxAttempts: MAX_RETRIES,
    baseDelayMs: LITELLM_RETRY_BASE_MS,
    maxDelayMs: LITELLM_RETRY_CAP_MS,
    exponentialBase: 2,
    jitter: true,
    retryIf: (err) => {
      if (req.abortSignal?.aborted) return false;
      if (err instanceof LiteLLMNetworkError) return true;
      if (err instanceof LiteLLMHttpError) return err.status === 429 || err.status >= 500;
      return false;
    },
  };
}

function estimateInputTokens(req: ChatRequest): number {
  // Rough approximation: 4 chars ≈ 1 token
  const chars = req.messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4);
}

function mapFinishReason(raw: string | null | undefined): ChatResponse["finishReason"] {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool";
    default:
      return "error";
  }
}

/** @public */
export class LiteLLMAdapter implements LLMProviderPort {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultModel: string;

  constructor(config: LiteLLMAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? "gpt-3.5-turbo";
  }

  estimateCost(req: ChatRequest): { usd: number } {
    const inputTokens = estimateInputTokens(req);
    const maxOutputTokens = req.maxTokens ?? 512;
    const inputCost = inputTokens / INPUT_TOKENS_PER_USD;
    const outputCost = maxOutputTokens / OUTPUT_TOKENS_PER_USD;
    return { usd: inputCost + outputCost };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    return ADAPTER_TRACER.startActiveSpan(
      "llm-provider.complete",
      {
        attributes: {
          "gen_ai.system": "litellm",
          "gen_ai.request.model": req.model ?? this.defaultModel,
          "gen_ai.request.message_count": req.messages.length,
          "vauban.port.name": "llm-provider",
          "vauban.port.impl": "LiteLLMAdapter",
        },
      },
      async (span: Span): Promise<ChatResponse> => {
        try {
          const response: ChatResponse = await this._doComplete(req);
          span.setAttributes({
            "gen_ai.usage.input_tokens": response.usage.inputTokens,
            "gen_ai.usage.output_tokens": response.usage.outputTokens,
            "gen_ai.response.model": response.model,
            "gen_ai.response.finish_reasons": [response.finishReason],
          });
          if (response.usage.costUsd !== undefined) {
            span.setAttribute("gen_ai.usage.cost_usd", response.usage.costUsd);
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
        } catch (_err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "span wrapper caught exception",
          });
          return {
            content: "",
            usage: { inputTokens: 0, outputTokens: 0 },
            model: req.model ?? this.defaultModel,
            finishReason: "error" as const,
          };
        } finally {
          span.end();
        }
      },
    );
  }

  /** Internal completion logic — extracted from complete() for span instrumentation. */
  private async _doComplete(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;
    const body = {
      model,
      messages: toOpenAIMessages(req.messages),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      // Pass tenant metadata as user field for tracking
      user: req.metadata?.tenantId,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    // Every error path below converges on the same error-shaped response, so
    // a single outer catch reconstructs it regardless of which condition
    // (network error, 429/5xx exhaustion, non-retryable 4xx, JSON parse
    // failure, or abort) produced the thrown error.
    try {
      return await retry(
        async () => {
          if (req.abortSignal?.aborted) {
            throw new LiteLLMAbortedError();
          }

          let response: Response;
          try {
            response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: req.abortSignal,
            });
          } catch (err) {
            if (req.abortSignal?.aborted) {
              throw new LiteLLMAbortedError();
            }
            throw new LiteLLMNetworkError(err);
          }

          if (!response.ok) {
            throw new LiteLLMHttpError(response.status);
          }

          const json = (await response.json()) as OpenAIResponse;

          const choice = json.choices?.[0];
          const rawUsage = json.usage;
          const usage: ChatUsage = {
            inputTokens: rawUsage?.prompt_tokens ?? estimateInputTokens(req),
            outputTokens: rawUsage?.completion_tokens ?? 0,
            costUsd: rawUsage
              ? rawUsage.prompt_tokens / INPUT_TOKENS_PER_USD +
                rawUsage.completion_tokens / OUTPUT_TOKENS_PER_USD
              : undefined,
          };

          return {
            content: choice?.message?.content ?? "",
            usage,
            model: json.model ?? model,
            finishReason: mapFinishReason(choice?.finish_reason),
          };
        },
        { config: buildRetryConfig(req) },
      );
    } catch {
      return {
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        finishReason: "error" as const,
      };
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
    const model = req.model ?? this.defaultModel;
    const body = {
      model,
      messages: toOpenAIMessages(req.messages),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
      user: req.metadata?.tenantId,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.abortSignal,
    });

    if (!response.ok || !response.body) {
      yield { delta: "", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            if (delta) yield { delta };
          } catch {
            // skip malformed chunk
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
