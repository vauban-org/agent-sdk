/**
 * AnthropicDirectAdapter — wraps @anthropic-ai/sdk for direct API access.
 *
 * BYOM: defaultModel is a constructor param default only.
 * No model string is hardcoded at module scope.
 *
 * Maps Anthropic SDK response to ChatResponse canonical format.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProviderPort,
  StreamDelta,
} from "../../ports/llm-provider.js";

const ADAPTER_TRACER = trace.getTracer("vauban-agent-sdk.llm.anthropic", "0.1.0");

/** @public */
export interface AnthropicDirectAdapterConfig {
  apiKey: string;
  /** Default model to use when ChatRequest.model is not specified. */
  defaultModel?: string;
  /** For testing only — inject a pre-built client instead of creating one. */
  _clientOverride?: Anthropic;
}

// Pricing approximation for cost estimation (input/output per token in USD)
const INPUT_USD_PER_TOKEN = 3 / 1_000_000; // $3 / MTok
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000; // $15 / MTok

function estimateInputTokens(req: ChatRequest): number {
  const chars = req.messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4);
}

function mapStopReason(raw: string | null | undefined): ChatResponse["finishReason"] {
  switch (raw) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool";
    default:
      return "error";
  }
}

/** @public */
export class AnthropicDirectAdapter implements LLMProviderPort {
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(config: AnthropicDirectAdapterConfig) {
    this.client = config._clientOverride ?? new Anthropic({ apiKey: config.apiKey });
    // BYOM: default only in adapter, never exposed in port
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-6";
  }

  estimateCost(req: ChatRequest): { usd: number } {
    const inputTokens = estimateInputTokens(req);
    const maxOutputTokens = req.maxTokens ?? 512;
    return {
      usd: inputTokens * INPUT_USD_PER_TOKEN + maxOutputTokens * OUTPUT_USD_PER_TOKEN,
    };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    return ADAPTER_TRACER.startActiveSpan(
      "llm-provider.complete",
      {
        attributes: {
          "gen_ai.system": "anthropic",
          "gen_ai.request.model": req.model ?? this.defaultModel,
          "gen_ai.request.message_count": req.messages.length,
          "vauban.port.name": "llm-provider",
          "vauban.port.impl": "AnthropicDirectAdapter",
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
          if (response.usage.cacheReadTokens !== undefined) {
            span.setAttribute("gen_ai.usage.cache_read_tokens", response.usage.cacheReadTokens);
          }
          if (response.usage.cacheCreationTokens !== undefined) {
            span.setAttribute(
              "gen_ai.usage.cache_creation_tokens",
              response.usage.cacheCreationTokens,
            );
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

  private async _doComplete(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;

    // Extract system message (Anthropic API separates system from messages)
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const conversationMessages = req.messages.filter((m) => m.role !== "system");

    const systemPrompt =
      systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n") : undefined;

    if (req.abortSignal?.aborted) {
      return {
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        finishReason: "error",
      };
    }

    try {
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: req.maxTokens ?? 1024,
        messages: conversationMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      };

      if (systemPrompt !== undefined) {
        if (systemPrompt.length >= 1024) {
          params.system = [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ] as Anthropic.Messages.TextBlockParam[];
        } else {
          params.system = systemPrompt;
        }
      }
      if (req.temperature !== undefined) {
        params.temperature = req.temperature;
      }

      const response = await this.client.messages.create(params);

      const rawUsage = response.usage;
      const usage: ChatUsage = {
        inputTokens: rawUsage.input_tokens,
        outputTokens: rawUsage.output_tokens,
        costUsd:
          rawUsage.input_tokens * INPUT_USD_PER_TOKEN +
          rawUsage.output_tokens * OUTPUT_USD_PER_TOKEN,
        ...(rawUsage.cache_creation_input_tokens != null && {
          cacheCreationTokens: rawUsage.cache_creation_input_tokens,
        }),
        ...(rawUsage.cache_read_input_tokens != null && {
          cacheReadTokens: rawUsage.cache_read_input_tokens,
        }),
      };

      const textBlock = response.content.find((b) => b.type === "text");
      const content = textBlock?.type === "text" ? textBlock.text : "";

      return {
        content,
        usage,
        model: response.model,
        finishReason: mapStopReason(response.stop_reason),
      };
    } catch (err) {
      if (req.abortSignal?.aborted) {
        return {
          content: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          model,
          finishReason: "error",
        };
      }
      // Map Anthropic errors — never rethrow, return error finishReason
      return {
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        finishReason: "error",
      };
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
    const model = req.model ?? this.defaultModel;

    const systemMessages = req.messages.filter((m) => m.role === "system");
    const conversationMessages = req.messages.filter((m) => m.role !== "system");
    const systemPrompt =
      systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n") : undefined;

    if (req.abortSignal?.aborted) {
      yield { delta: "", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    try {
      const params: Parameters<typeof this.client.messages.stream>[0] = {
        model,
        max_tokens: req.maxTokens ?? 1024,
        messages: conversationMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      };

      if (systemPrompt !== undefined) {
        params.system = systemPrompt;
      }
      if (req.temperature !== undefined) {
        params.temperature = req.temperature;
      }

      const stream = this.client.messages.stream(params);

      for await (const event of stream) {
        if (req.abortSignal?.aborted) break;

        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { delta: event.delta.text };
        }

        if (event.type === "message_delta" && event.usage) {
          yield {
            delta: "",
            usage: {
              inputTokens: 0,
              outputTokens: event.usage.output_tokens,
            },
          };
        }
      }
    } catch {
      // Stream error — yield empty and return
      yield { delta: "", usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }
}
