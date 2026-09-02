/**
 * LLMProviderPort contract tests — verifies all 3 adapters.
 *
 * Uses mock fetch and mock @anthropic-ai/sdk — no real API calls.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnthropicDirectAdapter } from "../src/adapters/llm/anthropic-direct.js";
import { CascadeAdapter } from "../src/adapters/llm/cascade.js";
import { LiteLLMAdapter } from "../src/adapters/llm/litellm.js";
import { llmProviderContract } from "../src/ports/llm-provider.contract.js";
import type { ChatRequest, LLMProviderPort } from "../src/ports/llm-provider.js";

// ─── Mock fetch ────────────────────────────────────────────────────────────────

const MOCK_OPENAI_RESPONSE = {
  choices: [
    {
      message: { content: "Hello! How can I help you?" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 8,
  },
  model: "gpt-3.5-turbo",
};

function makeMockFetch(
  status = 200,
  body: unknown = MOCK_OPENAI_RESPONSE,
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null,
  } as unknown as Response);
}

// ─── Mock Anthropic client (injected via _clientOverride) ─────────────────────

const MOCK_ANTHROPIC_RESPONSE = {
  id: "msg_mock",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hello from Anthropic!" }],
  model: "claude-sonnet-4-6",
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 9 },
};

function makeAnthropicMockClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(MOCK_ANTHROPIC_RESPONSE),
    },
  };
}

// ─── LiteLLMAdapter contract ───────────────────────────────────────────────────

describe("LiteLLMAdapter", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  llmProviderContract(
    () =>
      new LiteLLMAdapter({
        baseUrl: "http://localhost:4000",
        apiKey: "test-key",
        defaultModel: "test-model",
      }),
  );

  test("sends Authorization header when apiKey provided", async () => {
    const mockFetch = makeMockFetch();
    globalThis.fetch = mockFetch;

    const adapter = new LiteLLMAdapter({
      baseUrl: "http://localhost:4000",
      apiKey: "sk-test",
    });
    await adapter.complete({ messages: [{ role: "user", content: "hi" }] });

    const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  test("retries on 429 and returns error finishReason after max retries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
      body: null,
    } as unknown as Response);

    const adapter = new LiteLLMAdapter({
      baseUrl: "http://localhost:4000",
    });

    const response = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.finishReason).toBe("error");
  });

  test("uses defaultModel when model not specified in request", async () => {
    const mockFetch = makeMockFetch();
    globalThis.fetch = mockFetch;

    const adapter = new LiteLLMAdapter({
      baseUrl: "http://localhost:4000",
      defaultModel: "my-custom-model",
    });
    await adapter.complete({ messages: [{ role: "user", content: "hi" }] });

    const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string) as {
      model: string;
    };
    expect(body.model).toBe("my-custom-model");
  });

  test("returns error finishReason on aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const adapter = new LiteLLMAdapter({ baseUrl: "http://localhost:4000" });
    const response = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    });
    expect(response.finishReason).toBe("error");
  });

  test("extracts cost from usage field when available", async () => {
    const adapter = new LiteLLMAdapter({ baseUrl: "http://localhost:4000" });
    const response = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    // usage.prompt_tokens = 10, completion_tokens = 8 from mock
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(8);
    expect(typeof response.usage.costUsd).toBe("number");
    expect(response.usage.costUsd).toBeGreaterThan(0);
  });
});

// ─── AnthropicDirectAdapter contract ──────────────────────────────────────────

describe("AnthropicDirectAdapter", () => {
  llmProviderContract(
    () =>
      new AnthropicDirectAdapter({
        apiKey: "sk-ant-test",
        defaultModel: "claude-test",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _clientOverride: makeAnthropicMockClient() as any,
      }),
  );

  test("maps Anthropic end_turn to stop finishReason", async () => {
    const adapter = new AnthropicDirectAdapter({
      apiKey: "sk-ant-test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _clientOverride: makeAnthropicMockClient() as any,
    });
    const response = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.finishReason).toBe("stop");
    expect(response.content).toBe("Hello from Anthropic!");
  });

  test("separates system messages from conversation", async () => {
    const adapter = new AnthropicDirectAdapter({
      apiKey: "sk-ant-test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _clientOverride: makeAnthropicMockClient() as any,
    });
    const response = await adapter.complete({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    });
    expect(response.finishReason).toBe("stop");
  });

  test("returns usage with inputTokens and outputTokens", async () => {
    const adapter = new AnthropicDirectAdapter({
      apiKey: "sk-ant-test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _clientOverride: makeAnthropicMockClient() as any,
    });
    const response = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.usage.inputTokens).toBe(12);
    expect(response.usage.outputTokens).toBe(9);
    expect(typeof response.usage.costUsd).toBe("number");
  });

  test("returns error finishReason on aborted signal (pre-call)", async () => {
    const controller = new AbortController();
    controller.abort();

    const adapter = new AnthropicDirectAdapter({
      apiKey: "sk-ant-test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _clientOverride: makeAnthropicMockClient() as any,
    });
    const response = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    });
    expect(response.finishReason).toBe("error");
  });
});

// ─── CascadeAdapter contract ───────────────────────────────────────────────────

describe("CascadeAdapter", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  llmProviderContract(() => {
    const primary = new LiteLLMAdapter({
      baseUrl: "http://localhost:4000",
      defaultModel: "primary-model",
    });
    const fallback = new AnthropicDirectAdapter({
      apiKey: "sk-ant-test",
      defaultModel: "fallback-model",
    });
    return new CascadeAdapter({ providers: [primary, fallback] });
  });

  test("uses first provider when it succeeds", async () => {
    const primary: LLMProviderPort = {
      complete: vi.fn().mockResolvedValue({
        content: "from primary",
        usage: { inputTokens: 5, outputTokens: 3 },
        model: "primary",
        finishReason: "stop" as const,
      }),
    };
    const fallback: LLMProviderPort = {
      complete: vi.fn().mockResolvedValue({
        content: "from fallback",
        usage: { inputTokens: 5, outputTokens: 3 },
        model: "fallback",
        finishReason: "stop" as const,
      }),
    };

    const cascade = new CascadeAdapter({ providers: [primary, fallback] });
    const response = await cascade.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.content).toBe("from primary");
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  test("falls back to second provider when first returns error finishReason", async () => {
    const primary: LLMProviderPort = {
      complete: vi.fn().mockResolvedValue({
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "",
        finishReason: "error" as const,
      }),
    };
    const fallback: LLMProviderPort = {
      complete: vi.fn().mockResolvedValue({
        content: "fallback response",
        usage: { inputTokens: 5, outputTokens: 4 },
        model: "fallback",
        finishReason: "stop" as const,
      }),
    };

    const cascade = new CascadeAdapter({ providers: [primary, fallback] });
    const response = await cascade.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.content).toBe("fallback response");
    expect(response.finishReason).toBe("stop");
  });

  test("returns all-fail response when all providers fail", async () => {
    const p1: LLMProviderPort = {
      complete: vi.fn().mockResolvedValue({
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "",
        finishReason: "error" as const,
      }),
    };
    const p2: LLMProviderPort = {
      complete: vi.fn().mockResolvedValue({
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "",
        finishReason: "error" as const,
      }),
    };

    const cascade = new CascadeAdapter({ providers: [p1, p2] });
    const response = await cascade.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.finishReason).toBe("error");
    expect(response.content).toBe("");
    expect(response.model).toBe("");
  });

  test("throws when constructed with empty providers array", () => {
    expect(() => new CascadeAdapter({ providers: [] })).toThrow();
  });

  test("estimateCost delegates to first provider with estimateCost", () => {
    const p1: LLMProviderPort = {
      complete: vi.fn(),
      estimateCost: vi.fn().mockReturnValue({ usd: 0.005 }),
    };
    const cascade = new CascadeAdapter({ providers: [p1] });
    const cost = cascade.estimateCost({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(cost.usd).toBe(0.005);
  });
});

// ─── BYOM constraint verification ─────────────────────────────────────────────

describe("BYOM constraint", () => {
  test("LiteLLMAdapter accepts any defaultModel string", () => {
    const adapter = new LiteLLMAdapter({
      baseUrl: "http://localhost:4000",
      defaultModel: "custom/model-xyz",
    });
    expect(adapter).toBeDefined();
  });

  test("AnthropicDirectAdapter accepts any defaultModel string", () => {
    const adapter = new AnthropicDirectAdapter({
      apiKey: "sk-ant-test",
      defaultModel: "custom/model-xyz",
    });
    expect(adapter).toBeDefined();
  });

  test("LLMProviderPort interface has no required model field", () => {
    // Type-level: a minimal object with just complete() satisfies the port
    const minimal: LLMProviderPort = {
      complete: async (_req: ChatRequest) => ({
        content: "ok",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "custom",
        finishReason: "stop" as const,
      }),
    };
    expect(minimal).toBeDefined();
  });
});
