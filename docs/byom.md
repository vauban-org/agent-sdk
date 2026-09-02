---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# BYOM — Bring Your Own Model

The SDK ships **zero default LLM provider**. Every agent injects the concrete adapter it needs at boot via `AgentFactoryDeps.deps.llm`. This design is called the BYOM (Bring Your Own Model) axiom.

**Why BYOM?** No model name is hardcoded in SDK source. Consumers can swap providers (LiteLLM, Anthropic Direct, custom) without touching agent logic. All cost accounting, circuit breaking, and streaming remain generic.

## The `LLMProviderPort` interface

```typescript
import type { LLMProviderPort, ChatRequest, ChatResponse, StreamDelta } from "@vauban-org/agent-sdk";

interface LLMProviderPort {
  complete(req: ChatRequest): Promise<ChatResponse>;
  stream?(req: ChatRequest): AsyncIterable<StreamDelta>;
  estimateCost?(req: ChatRequest): { usd: number };
}
```

See [ports/llm-provider.md](ports/llm-provider.md) for the full interface.

---

## LiteLLMAdapter

Use when you self-host an LLM proxy (recommended for on-prem deployments, cost control, or model fallback).

```typescript
import { LiteLLMAdapter } from "@vauban-org/agent-sdk";
import type { LiteLLMAdapterConfig } from "@vauban-org/agent-sdk";

const llm = new LiteLLMAdapter({
  baseUrl: process.env["LITELLM_URL"]!,
  apiKey: process.env["LITELLM_API_KEY"],   // optional, defaults to "sk-sdk"
  defaultModel: "qwen3-8b",                 // used when ChatRequest.model is absent
} satisfies LiteLLMAdapterConfig);
```

**Features:**
- OpenAI-compatible `/v1/chat/completions` endpoint
- Retry on 429 with exponential back-off + jitter (max 3 attempts, no external dep)
- Cost estimation from `usage.total_cost` when LiteLLM returns it

---

## AnthropicDirectAdapter

Use for direct Anthropic API access (`@anthropic-ai/sdk` peer dep required).

```typescript
import { AnthropicDirectAdapter } from "@vauban-org/agent-sdk";
import type { AnthropicDirectAdapterConfig } from "@vauban-org/agent-sdk";

const llm = new AnthropicDirectAdapter({
  apiKey: process.env["ANTHROPIC_API_KEY"]!,
  defaultModel: "claude-sonnet-4-6",        // used when ChatRequest.model is absent
} satisfies AnthropicDirectAdapterConfig);
```

**Features:**
- Maps Anthropic `MessageParam` ↔ `ChatMessage` canonical format
- Streaming via `AnthropicStream` → `StreamDelta`
- Cost estimation at $3/MTok input, $15/MTok output (approximation)

---

## CascadeAdapter

Use when you want automatic fallback across multiple providers.

```typescript
import { CascadeAdapter, LiteLLMAdapter, AnthropicDirectAdapter } from "@vauban-org/agent-sdk";
import type { CascadeAdapterConfig } from "@vauban-org/agent-sdk";

const llm = new CascadeAdapter({
  providers: [
    new LiteLLMAdapter({ baseUrl: process.env["LITELLM_URL"]! }),
    new AnthropicDirectAdapter({ apiKey: process.env["ANTHROPIC_API_KEY"]! }),
  ],
} satisfies CascadeAdapterConfig);
```

The cascade tries each provider in order. On non-retryable error it falls through to the next. All providers return the same `ChatResponse` shape.

---

## Custom adapter

Implement `LLMProviderPort` directly for any custom backend:

```typescript
import type { LLMProviderPort, ChatRequest, ChatResponse } from "@vauban-org/agent-sdk";

class MyCustomLLM implements LLMProviderPort {
  async complete(req: ChatRequest): Promise<ChatResponse> {
    // ... call your API
    return {
      content: "response text",
      usage: { inputTokens: 10, outputTokens: 20 },
      model: "my-model-v1",
      finishReason: "stop",
    };
  }
}
```

**Rule:** Never implement `LLMProviderPort` by re-exporting a provider SDK directly in agent business logic. Always wrap in an adapter that conforms to this port.
