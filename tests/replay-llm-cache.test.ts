/**
 * Tests for LLM response cache utilities.
 *
 * Coverage:
 *   - hashLLMCacheKey is stable across repeated calls (same input → same hash).
 *   - Different messages produce different hashes.
 *   - Message array ORDER matters (different order → different hash).
 *   - InMemoryLLMResponseCache.get() returns undefined for unknown key.
 *   - put() then get() returns the stored entry.
 *   - Different seed value → different hash.
 *   - clear() wipes the store.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryLLMResponseCache,
  type LLMCacheKey,
  hashLLMCacheKey,
} from "../src/replay/llm-cache.js";

const baseKey: LLMCacheKey = {
  provider: "openai",
  model: "gpt-4",
  messages: [{ role: "user", content: "hi" }],
  temperature: 0,
};

describe("hashLLMCacheKey", () => {
  it("is stable across repeated calls with the same input", async () => {
    const h1 = await hashLLMCacheKey(baseKey);
    const h2 = await hashLLMCacheKey(baseKey);

    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex = 32 bytes = 64 hex chars
  });

  it("different messages produce different hashes", async () => {
    const h1 = await hashLLMCacheKey(baseKey);
    const h2 = await hashLLMCacheKey({
      ...baseKey,
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(h1).not.toBe(h2);
  });

  it("message array ORDER matters — different order yields different hash", async () => {
    const messagesA = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const messagesB = [
      { role: "assistant", content: "second" },
      { role: "user", content: "first" },
    ];

    const h1 = await hashLLMCacheKey({ ...baseKey, messages: messagesA });
    const h2 = await hashLLMCacheKey({ ...baseKey, messages: messagesB });

    expect(h1).not.toBe(h2);
  });

  it("different seed values produce different hashes", async () => {
    const h1 = await hashLLMCacheKey({ ...baseKey, seed: 1 });
    const h2 = await hashLLMCacheKey({ ...baseKey, seed: 2 });

    expect(h1).not.toBe(h2);
  });

  it("presence vs absence of seed produces different hashes", async () => {
    const withSeed = await hashLLMCacheKey({ ...baseKey, seed: 0 });
    const withoutSeed = await hashLLMCacheKey(baseKey); // seed: undefined → omitted

    expect(withSeed).not.toBe(withoutSeed);
  });

  it("different models produce different hashes", async () => {
    const h1 = await hashLLMCacheKey({ ...baseKey, model: "gpt-4o" });
    const h2 = await hashLLMCacheKey({ ...baseKey, model: "gpt-4-turbo" });

    expect(h1).not.toBe(h2);
  });

  it("different temperatures produce different hashes", async () => {
    const h1 = await hashLLMCacheKey({ ...baseKey, temperature: 0 });
    const h2 = await hashLLMCacheKey({ ...baseKey, temperature: 0.7 });

    expect(h1).not.toBe(h2);
  });
});

describe("InMemoryLLMResponseCache", () => {
  it("get() returns undefined for an unknown key", async () => {
    const cache = new InMemoryLLMResponseCache();

    const result = await cache.get(baseKey);
    expect(result).toBeUndefined();
  });

  it("put() then get() returns the stored entry with correct fields", async () => {
    const cache = new InMemoryLLMResponseCache();
    const response = { choices: [{ message: { content: "Hello" } }] };

    await cache.put(baseKey, response);
    const entry = await cache.get(baseKey);

    expect(entry).toBeDefined();
    expect(entry?.response).toEqual(response);
    expect(entry?.key).toHaveLength(64);
    expect(typeof entry?.recordedAt).toBe("number");
    expect(entry?.recordedAt).toBeGreaterThan(0);
  });

  it("put() overwrites existing entry for the same key", async () => {
    const cache = new InMemoryLLMResponseCache();
    const first = { content: "first" };
    const second = { content: "second" };

    await cache.put(baseKey, first);
    await cache.put(baseKey, second);
    const entry = await cache.get(baseKey);

    expect(entry?.response).toEqual(second);
  });

  it("different keys are stored independently", async () => {
    const cache = new InMemoryLLMResponseCache();
    const keyA = baseKey;
    const keyB = { ...baseKey, model: "gpt-4o" };

    await cache.put(keyA, { tag: "a" });
    await cache.put(keyB, { tag: "b" });

    const entryA = await cache.get(keyA);
    const entryB = await cache.get(keyB);

    expect(entryA?.response).toEqual({ tag: "a" });
    expect(entryB?.response).toEqual({ tag: "b" });
  });

  it("clear() wipes all stored entries", async () => {
    const cache = new InMemoryLLMResponseCache();
    await cache.put(baseKey, { data: "something" });

    cache.clear?.();

    const entry = await cache.get(baseKey);
    expect(entry).toBeUndefined();
  });
});
