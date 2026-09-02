/**
 * Tests for packages/agent-sdk/src/router/provider-router.ts
 *
 * Coverage:
 *   createProviderRouter — factory defaults, preferAnthropic flag,
 *                          no Anthropic key routes to Groq
 *   Anthropic path — text+tool_use blocks, system message extraction,
 *                    tool messages collapsed to user
 *   Fallback logic — 429 → Groq, 5xx → Groq, AbortError → Groq,
 *                    timeout message → Groq, non-retryable → throws directly
 *   Groq path — success with text, tool_calls JSON parse, malformed args,
 *               HTTP error → ProviderRouterError
 *   queueRetryFn — called when all providers fail
 *   ProviderRouterError — name, message, cause
 *
 * Ref: test coverage for agent-sdk/router/provider-router.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { ProviderRouterError, createProviderRouter } from "../src/router/provider-router.js";
import type { AnthropicLike, ProviderRouterRequest } from "../src/router/provider-router.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_REQUEST: ProviderRouterRequest = {
  messages: [{ role: "user", content: "hello" }],
};

function makeAnthropicClient(response: unknown): {
  client: AnthropicLike;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue(response);
  const client: AnthropicLike = { messages: { create } };
  return { client, create };
}

function makeGroqFetch(response: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(response),
    text: vi.fn().mockResolvedValue("error body"),
  });
}

const ANTHROPIC_TEXT_RESPONSE = {
  content: [{ type: "text", text: "Hello from Anthropic" }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

const ANTHROPIC_TOOL_RESPONSE = {
  content: [
    { type: "text", text: "thinking..." },
    { type: "tool_use", name: "my_tool", input: { key: "value" } },
  ],
  usage: { input_tokens: 20, output_tokens: 8 },
};

const GROQ_TEXT_RESPONSE = {
  choices: [{ message: { content: "Hello from Groq", tool_calls: undefined } }],
  usage: { prompt_tokens: 12, completion_tokens: 6 },
};

const GROQ_TOOL_RESPONSE = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            function: {
              name: "groq_tool",
              arguments: JSON.stringify({ x: 1, y: 2 }),
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 15, completion_tokens: 10 },
};

// ─── ProviderRouterError ───────────────────────────────────────────────────────

describe("ProviderRouterError", () => {
  it("name is ProviderRouterError", () => {
    const err = new ProviderRouterError("bad");
    expect(err.name).toBe("ProviderRouterError");
  });

  it("stores cause", () => {
    const cause = new Error("upstream");
    const err = new ProviderRouterError("wrap", cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── Anthropic path ───────────────────────────────────────────────────────────

describe("Anthropic path", () => {
  it("returns text content with provider=anthropic", async () => {
    const { client } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    const result = await router.complete(BASE_REQUEST);
    expect(result.content).toBe("Hello from Anthropic");
    expect(result.provider).toBe("anthropic");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns tool_use blocks as toolCalls", async () => {
    const { client } = makeAnthropicClient(ANTHROPIC_TOOL_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    const result = await router.complete(BASE_REQUEST);
    expect(result.content).toBe("thinking...");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      name: "my_tool",
      args: { key: "value" },
    });
  });

  it("extracts system messages and removes them from messages array", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    await router.complete({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hi" },
      ],
    });
    const params = create.mock.calls[0][0];
    expect(params.system).toBe("You are helpful");
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("concatenates multiple system messages", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    await router.complete({
      messages: [
        { role: "system", content: "Part A" },
        { role: "system", content: "Part B" },
        { role: "user", content: "go" },
      ],
    });
    const params = create.mock.calls[0][0];
    expect(params.system).toBe("Part A\n\nPart B");
  });

  it("collapses tool messages into user messages", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    await router.complete({
      messages: [
        { role: "user", content: "call tool" },
        { role: "tool", content: "result data" },
      ],
    });
    const params = create.mock.calls[0][0];
    const toolMsg = params.messages.find((m: { role: string; content: string }) =>
      m.content.startsWith("[tool]"),
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.role).toBe("user");
  });

  it("does not set system param when no system messages", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    await router.complete(BASE_REQUEST);
    const params = create.mock.calls[0][0];
    expect(params.system).toBeUndefined();
  });

  it("passes tools when provided", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    const tools = [{ name: "t1", description: "test tool" }];
    await router.complete({ ...BASE_REQUEST, tools });
    const params = create.mock.calls[0][0];
    expect(params.tools).toEqual(tools);
  });

  it("uses default maxTokens 4096 when not specified", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    await router.complete(BASE_REQUEST);
    const params = create.mock.calls[0][0];
    expect(params.max_tokens).toBe(4096);
  });

  it("uses custom model when provided", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({
      anthropicClient: client,
      model: { anthropic: "claude-opus-4-7" },
    });
    await router.complete(BASE_REQUEST);
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-4-7");
  });

  it("defaults to claude-sonnet-4-6 when no model is passed", async () => {
    const { client, create } = makeAnthropicClient(ANTHROPIC_TEXT_RESPONSE);
    const router = createProviderRouter({ anthropicClient: client });
    await router.complete(BASE_REQUEST);
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("claude-sonnet-4-6");
  });
});

// ─── Fallback: Anthropic 429 → Groq ──────────────────────────────────────────

describe("Anthropic 429 fallback to Groq", () => {
  it("falls back to Groq on 429", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), {
      status: 429,
    });
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(rateLimitErr);
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: "test-groq-key",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.provider).toBe("groq");
    expect(result.content).toBe("Hello from Groq");
  });

  it("falls back to Groq on 5xx", async () => {
    const serverErr = Object.assign(new Error("server error"), { status: 500 });
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(serverErr);
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: "test-groq-key",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.provider).toBe("groq");
  });

  it("falls back to Groq on AbortError", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(abortErr);
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: "test-groq-key",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.provider).toBe("groq");
  });

  it("falls back to Groq on timeout message", async () => {
    const timeoutErr = new Error("ETIMEDOUT connection timeout");
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutErr);
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: "test-groq-key",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.provider).toBe("groq");
  });

  it("throws ProviderRouterError directly on non-retryable Anthropic error", async () => {
    const authErr = Object.assign(new Error("unauthorized"), { status: 401 });
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(authErr);
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: "test-groq-key",
    });
    await expect(router.complete(BASE_REQUEST)).rejects.toThrow(ProviderRouterError);
  });
});

// ─── No Groq key: queue + throw ──────────────────────────────────────────────

describe("no Groq key after Anthropic fallback-eligible error", () => {
  it("calls queueRetryFn and throws when Groq key missing", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), {
      status: 429,
    });
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(rateLimitErr);
    const queueRetryFn = vi.fn().mockResolvedValue(undefined);
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: undefined,
      queueRetryFn,
    });
    await expect(router.complete(BASE_REQUEST)).rejects.toThrow(ProviderRouterError);
    expect(queueRetryFn).toHaveBeenCalledOnce();
  });

  it("still throws even if queueRetryFn rejects (best-effort)", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), {
      status: 429,
    });
    const { client } = makeAnthropicClient(null);
    (client.messages.create as ReturnType<typeof vi.fn>).mockRejectedValue(rateLimitErr);
    const queueRetryFn = vi.fn().mockRejectedValue(new Error("queue down"));
    const router = createProviderRouter({
      anthropicClient: client,
      groqApiKey: undefined,
      queueRetryFn,
    });
    await expect(router.complete(BASE_REQUEST)).rejects.toThrow(ProviderRouterError);
  });
});

// ─── Groq path ────────────────────────────────────────────────────────────────

describe("Groq path (preferAnthropic=false)", () => {
  it("returns Groq text content", async () => {
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.provider).toBe("groq");
    expect(result.content).toBe("Hello from Groq");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(6);
  });

  it("parses Groq tool_calls with JSON arguments", async () => {
    const fetchMock = makeGroqFetch(GROQ_TOOL_RESPONSE);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      name: "groq_tool",
      args: { x: 1, y: 2 },
    });
  });

  it("defaults to llama-3.3-70b-versatile when no Groq model is passed", async () => {
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    await router.complete(BASE_REQUEST);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe("llama-3.3-70b-versatile");
  });

  it("handles malformed JSON tool args with __raw fallback", async () => {
    const badArgsResponse = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ function: { name: "broken", arguments: "{not json" } }],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    const fetchMock = makeGroqFetch(badArgsResponse);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.toolCalls[0].args).toEqual({ __raw: "{not json" });
  });

  it("skips tool_calls without a function name", async () => {
    const noNameResponse = {
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [{ function: { arguments: '{"a":1}' } }],
          },
        },
      ],
      usage: {},
    };
    const fetchMock = makeGroqFetch(noNameResponse);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("throws ProviderRouterError on Groq HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue("rate limited by Groq"),
    });
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    await expect(router.complete(BASE_REQUEST)).rejects.toThrow(ProviderRouterError);
  });

  it("calls queueRetryFn and throws when Groq fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("Groq error"),
    });
    const queueRetryFn = vi.fn().mockResolvedValue(undefined);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
      queueRetryFn,
    });
    await expect(router.complete(BASE_REQUEST)).rejects.toThrow(ProviderRouterError);
    expect(queueRetryFn).toHaveBeenCalledOnce();
  });

  it("uses custom Groq model when provided", async () => {
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
      model: { groq: "llama-4-scout" },
    });
    await router.complete(BASE_REQUEST);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("llama-4-scout");
  });

  it("maps tool messages to user messages in Groq path", async () => {
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      preferAnthropic: false,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    await router.complete({
      messages: [
        { role: "user", content: "call it" },
        { role: "tool", content: "tool result" },
      ],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const toolMsg = body.messages.find((m: { role: string; content: string }) =>
      m.content.startsWith("[tool]"),
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.role).toBe("user");
  });
});

// ─── No Anthropic client, direct Groq routing ────────────────────────────────

describe("preferAnthropic=true but no Anthropic client configured", () => {
  it("routes directly to Groq when no anthropicClient and no API key", async () => {
    const fetchMock = makeGroqFetch(GROQ_TEXT_RESPONSE);
    const router = createProviderRouter({
      preferAnthropic: true,
      anthropicApiKey: undefined,
      anthropicClient: undefined,
      groqApiKey: "gk",
      fetchImpl: fetchMock,
    });
    const result = await router.complete(BASE_REQUEST);
    expect(result.provider).toBe("groq");
  });
});
