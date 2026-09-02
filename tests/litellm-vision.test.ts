/**
 * tests/litellm-vision.test.ts ; Beyond-Hermes multimodal (photo input).
 *
 * The LiteLLMAdapter folds ChatMessage image attachments into OpenAI
 * `image_url` content blocks for a vision-capable model (e.g. DeepSeek-VL via
 * LiteLLM), while keeping a plain string for text-only messages so the wire
 * shape is byte-identical to before for every existing caller. Verified by
 * capturing the request body sent to a stubbed `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiteLLMAdapter } from "../src/adapters/llm/litellm.js";
import type { ChatRequest } from "../src/ports/llm-provider.js";

let captured: { messages: Array<{ role: string; content: unknown }> } | null = null;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
        model: "deepseek-vl",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  captured = null;
});

const adapter = () =>
  new LiteLLMAdapter({
    baseUrl: "https://litellm.test",
    apiKey: "k",
    defaultModel: "deepseek-vl",
  });

describe("LiteLLMAdapter vision (image attachments)", () => {
  it("folds an image attachment into an OpenAI image_url content block", async () => {
    const req: ChatRequest = {
      messages: [
        {
          role: "user",
          content: "what is in this image?",
          attachments: [{ kind: "image", mediaType: "image/png", dataBase64: "AAAA" }],
        },
      ],
    };
    const res = await adapter().complete(req);
    expect(res.finishReason).toBe("stop");

    const content = captured!.messages[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({
      type: "text",
      text: "what is in this image?",
    });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("keeps a plain string for a text-only message (wire back-compat)", async () => {
    const req: ChatRequest = {
      messages: [{ role: "user", content: "hello" }],
    };
    await adapter().complete(req);
    expect(captured!.messages[0]!.content).toBe("hello");
  });

  it("folds multiple images into one message", async () => {
    const req: ChatRequest = {
      messages: [
        {
          role: "user",
          content: "compare these",
          attachments: [
            { kind: "image", mediaType: "image/jpeg", dataBase64: "AAAA" },
            { kind: "image", mediaType: "image/webp", dataBase64: "BBBB" },
          ],
        },
      ],
    };
    await adapter().complete(req);
    const content = captured!.messages[0]!.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content).toHaveLength(3); // text + 2 images
    expect(content[1]!.image_url!.url).toBe("data:image/jpeg;base64,AAAA");
    expect(content[2]!.image_url!.url).toBe("data:image/webp;base64,BBBB");
  });
});
