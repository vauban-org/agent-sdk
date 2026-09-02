---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Port: LLMProviderPort

**Module:** `@vauban-org/agent-sdk` · **Since:** 0.17.0 (plan v6 §3.2)

## Purpose

`LLMProviderPort` is the BYOM abstraction for language model calls. Every OODA agent that needs an LLM depends **only** on this port — never on a concrete provider SDK. Concrete adapters are injected at boot via `AgentFactoryDeps.deps.llm` (or `OODAAgentDeps.llm`).

No model name is hardcoded in this interface or any file that re-exports it.

## Interface definition

```typescript
import type {
  LLMProviderPort,
  ChatRequest,
  ChatMessage,
  ChatUsage,
  ChatResponse,
  StreamDelta,
} from "@vauban-org/agent-sdk";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequest {
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

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;       // adapters that cannot compute cost omit this field
}

interface ChatResponse {
  content: string;
  usage: ChatUsage;
  model: string;
  finishReason: "stop" | "length" | "tool" | "error";
}

interface StreamDelta {
  delta: string;
  usage?: ChatUsage;      // only present in the final chunk
}

interface LLMProviderPort {
  complete(req: ChatRequest): Promise<ChatResponse>;
  stream?(req: ChatRequest): AsyncIterable<StreamDelta>;
  estimateCost?(req: ChatRequest): { usd: number };
}
```

**Contract:** `complete()` never rejects on model error — it returns `finishReason: "error"` instead. This prevents cascading failures in the OODA loop.

## Available adapters

| Adapter | Import | Backend |
|---------|--------|---------|
| `LiteLLMAdapter` | `@vauban-org/agent-sdk` | LiteLLM proxy (on-prem) |
| `AnthropicDirectAdapter` | `@vauban-org/agent-sdk` | Anthropic API |
| `CascadeAdapter` | `@vauban-org/agent-sdk` | Multi-provider fallback chain |

See [byom.md](../byom.md) for setup examples.

## Usage in a phase

```typescript
import type { OODAContext } from "@vauban-org/agent-sdk";

const orientPhase = {
  type: "retrieval" as const,
  readOnly: true,
  fn: async (obs: { data: string }, ctx: OODAContext) => {
    const response = await ctx.deps.llm?.complete({
      messages: [
        { role: "system", content: "You are a financial analyst." },
        { role: "user", content: `Analyze: ${obs.data}` },
      ],
      model: "qwen3-8b",
      maxTokens: 512,
    });
    return { analysis: response?.content ?? "" };
  },
};
```

## Implementing a custom adapter

```typescript
import type { LLMProviderPort, ChatRequest, ChatResponse } from "@vauban-org/agent-sdk";

class OpenRouterAdapter implements LLMProviderPort {
  constructor(private readonly apiKey: string, private readonly defaultModel: string) {}

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model ?? this.defaultModel,
        messages: req.messages,
        max_tokens: req.maxTokens,
      }),
    });
    // ... map response to ChatResponse
    throw new Error("TODO: implement response mapping");
  }
}
```
