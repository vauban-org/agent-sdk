/**
 * Tests for AnthropicDirectAdapter — prompt caching + ChatUsage mapping.
 * @since 1.13.0
 */

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest } from "../../ports/llm-provider.js";
import { AnthropicDirectAdapter } from "./anthropic-direct.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUsage(overrides: Partial<Anthropic.Messages.Usage> = {}): Anthropic.Messages.Usage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...overrides,
  };
}

function makeFakeResponse(
  usage: Anthropic.Messages.Usage,
  text = "hello",
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

/**
 * Build a mock Anthropic client that captures params and returns a fake response.
 * The `createSpy` is exposed so tests can inspect what params were passed.
 */
function makeMockClient(usage: Anthropic.Messages.Usage, text = "hello") {
  const createSpy = vi.fn().mockResolvedValue(makeFakeResponse(usage, text));
  const client = {
    messages: {
      create: createSpy,
      stream: vi.fn(),
    },
  } as unknown as Anthropic;
  return { client, createSpy };
}

function makeRequest(systemPrompt: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "ping" },
    ],
    model: "claude-sonnet-4-6",
    ...extra,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AnthropicDirectAdapter — prompt caching", () => {
  describe("system prompt shape", () => {
    it("passes system prompt as string when < 1024 chars", async () => {
      const { client, createSpy } = makeMockClient(makeUsage());
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const shortPrompt = "You are a helpful assistant."; // << 1024
      expect(shortPrompt.length).toBeLessThan(1024);

      await adapter.complete(makeRequest(shortPrompt));

      const params = createSpy.mock.calls[0][0];
      expect(typeof params.system).toBe("string");
      expect(params.system).toBe(shortPrompt);
    });

    it("wraps system prompt as TextBlockParam[] with cache_control when >= 1024 chars", async () => {
      const { client, createSpy } = makeMockClient(makeUsage());
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const longPrompt = "x".repeat(1024); // exactly at threshold
      expect(longPrompt.length).toBeGreaterThanOrEqual(1024);

      await adapter.complete(makeRequest(longPrompt));

      const params = createSpy.mock.calls[0][0];
      expect(Array.isArray(params.system)).toBe(true);
      expect(params.system).toHaveLength(1);
      expect(params.system[0]).toEqual({
        type: "text",
        text: longPrompt,
        cache_control: { type: "ephemeral" },
      });
    });

    it("wraps system prompt > 1024 chars with cache_control", async () => {
      const { client, createSpy } = makeMockClient(makeUsage());
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const veryLongPrompt = "y".repeat(2048);

      await adapter.complete(makeRequest(veryLongPrompt));

      const params = createSpy.mock.calls[0][0];
      expect(Array.isArray(params.system)).toBe(true);
      expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    });
  });

  describe("ChatUsage cache token propagation", () => {
    it("propagates cache_read_input_tokens when present", async () => {
      const usage = makeUsage({ cache_read_input_tokens: 200 });
      const { client } = makeMockClient(usage);
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const result = await adapter.complete(makeRequest("x".repeat(1024)));

      expect(result.usage.cacheReadTokens).toBe(200);
      expect(result.usage.cacheCreationTokens).toBeUndefined();
    });

    it("propagates cache_creation_input_tokens when present", async () => {
      const usage = makeUsage({ cache_creation_input_tokens: 350 });
      const { client } = makeMockClient(usage);
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const result = await adapter.complete(makeRequest("x".repeat(1024)));

      expect(result.usage.cacheCreationTokens).toBe(350);
      expect(result.usage.cacheReadTokens).toBeUndefined();
    });

    it("omits cache fields from ChatUsage when API returns null", async () => {
      const usage = makeUsage({
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      });
      const { client } = makeMockClient(usage);
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const result = await adapter.complete(makeRequest("hello")); // < 1024, no cache

      expect(result.usage.cacheCreationTokens).toBeUndefined();
      expect(result.usage.cacheReadTokens).toBeUndefined();
      // Core fields still present
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
    });

    it("propagates both cache fields simultaneously", async () => {
      const usage = makeUsage({
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 300,
      });
      const { client } = makeMockClient(usage);
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const result = await adapter.complete(makeRequest("x".repeat(1024)));

      expect(result.usage.cacheCreationTokens).toBe(500);
      expect(result.usage.cacheReadTokens).toBe(300);
    });
  });

  describe("backward compatibility", () => {
    it("returns correct finishReason and content without cache fields", async () => {
      const { client } = makeMockClient(makeUsage(), "world");
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      const result = await adapter.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "claude-sonnet-4-6",
      });

      expect(result.content).toBe("world");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.usage.cacheCreationTokens).toBeUndefined();
      expect(result.usage.cacheReadTokens).toBeUndefined();
    });

    it("does not set system param when no system message", async () => {
      const { client, createSpy } = makeMockClient(makeUsage());
      const adapter = new AnthropicDirectAdapter({
        apiKey: "test",
        _clientOverride: client,
      });

      await adapter.complete({
        messages: [{ role: "user", content: "hello" }],
        model: "claude-sonnet-4-6",
      });

      const params = createSpy.mock.calls[0][0];
      expect(params.system).toBeUndefined();
    });
  });
});
