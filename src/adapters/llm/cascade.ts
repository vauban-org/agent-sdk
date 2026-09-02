/**
 * CascadeAdapter — composition helper for LLMProviderPort.
 *
 * Tries providers in order. Falls back to the next provider on:
 *   - Timeout (AbortError)
 *   - 500-class errors (mapped to finishReason: "error")
 *   - 429 after all retries (mapped to finishReason: "error")
 *
 * If all providers fail or return finishReason: "error",
 * returns the canonical all-fail response.
 *
 * BYOM: no default model hardcoded.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  ChatRequest,
  ChatResponse,
  LLMProviderPort,
  StreamDelta,
} from "../../ports/llm-provider.js";

const ADAPTER_TRACER = trace.getTracer("vauban-agent-sdk.llm.cascade", "0.1.0");

const ALL_FAIL_RESPONSE: ChatResponse = {
  content: "",
  usage: { inputTokens: 0, outputTokens: 0 },
  model: "",
  finishReason: "error",
};

/** @public */
export interface CascadeAdapterConfig {
  providers: LLMProviderPort[];
}

/** @public */
export class CascadeAdapter implements LLMProviderPort {
  private readonly providers: LLMProviderPort[];

  constructor(config: CascadeAdapterConfig) {
    if (config.providers.length === 0) {
      throw new Error("CascadeAdapter requires at least one provider");
    }
    this.providers = config.providers;
  }

  estimateCost(req: ChatRequest): { usd: number } {
    // Use the first provider that supports estimateCost
    for (const provider of this.providers) {
      if (provider.estimateCost) {
        return provider.estimateCost(req);
      }
    }
    return { usd: 0 };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    return ADAPTER_TRACER.startActiveSpan(
      "llm-provider.complete",
      {
        attributes: {
          "gen_ai.system": "cascade",
          "gen_ai.request.model": req.model ?? "cascade",
          "gen_ai.request.message_count": req.messages.length,
          "vauban.port.name": "llm-provider",
          "vauban.port.impl": "CascadeAdapter",
          "vauban.cascade.provider_count": this.providers.length,
        },
      },
      async (span: Span) => {
        try {
          let attemptCount = 0;
          for (const provider of this.providers) {
            attemptCount++;
            if (req.abortSignal?.aborted) {
              span.setAttribute("vauban.cascade.attempts", attemptCount);
              span.setStatus({ code: SpanStatusCode.OK });
              return { ...ALL_FAIL_RESPONSE };
            }

            let response: ChatResponse;
            try {
              response = await provider.complete(req);
            } catch {
              // Unexpected throw — treat as failure, try next
              continue;
            }

            if (response.finishReason !== "error") {
              span.setAttribute("vauban.cascade.attempts", attemptCount);
              span.setAttributes({
                "gen_ai.usage.input_tokens": response.usage.inputTokens,
                "gen_ai.usage.output_tokens": response.usage.outputTokens,
                "gen_ai.response.model": response.model,
                "gen_ai.response.finish_reasons": [response.finishReason],
              });
              span.setStatus({ code: SpanStatusCode.OK });
              return response;
            }
            // finishReason === "error" → try next provider
          }
          span.setAttribute("vauban.cascade.attempts", attemptCount);
          span.setAttribute("vauban.cascade.all_failed", true);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "all providers failed",
          });
          return { ...ALL_FAIL_RESPONSE };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          if (err instanceof Error) span.recordException(err);
          return { ...ALL_FAIL_RESPONSE };
        } finally {
          span.end();
        }
      },
    );
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
    for (const provider of this.providers) {
      if (req.abortSignal?.aborted) {
        return;
      }

      if (!provider.stream) {
        // This provider doesn't support streaming — try next
        continue;
      }

      let hadContent = false;
      let errored = false;

      try {
        for await (const chunk of provider.stream(req)) {
          if (req.abortSignal?.aborted) return;
          hadContent = true;
          yield chunk;
        }
      } catch {
        errored = true;
      }

      if (hadContent && !errored) {
        return;
      }
      // No content or error — try next provider
    }

    // All providers failed
    yield { delta: "", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
