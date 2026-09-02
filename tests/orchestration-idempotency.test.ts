/**
 * Tests for packages/agent-sdk/src/orchestration/idempotency.ts
 *
 * Coverage:
 *   computeIdempotencyKey — 64-char hex, deterministic, field-sensitive, unicode
 *   withIdempotency       — caching, TTL expiry, failure eviction, fan-out dedup
 *   addIdempotencyHeader  — header injection, immutability, correct key value
 *
 * Ref: sprint-468 idempotency primitives unit tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addIdempotencyHeader,
  computeIdempotencyKey,
  withIdempotency,
} from "../src/orchestration/idempotency.js";
// CacheEntry is not exported; use an opaque unknown type for the store Map
type CacheEntry<T> = { promise: Promise<T>; expiresAt: number };

// ---------------------------------------------------------------------------
// computeIdempotencyKey
// ---------------------------------------------------------------------------

describe("computeIdempotencyKey", () => {
  const base = { content: "hello", author: "forge", category: "brain-store" };

  it("returns a 64-character hex string", () => {
    const key = computeIdempotencyKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same payload produces the same key", () => {
    const k1 = computeIdempotencyKey(base);
    const k2 = computeIdempotencyKey({ ...base });
    expect(k1).toBe(k2);
  });

  it("different content produces a different key", () => {
    const k1 = computeIdempotencyKey(base);
    const k2 = computeIdempotencyKey({ ...base, content: "world" });
    expect(k1).not.toBe(k2);
  });

  it("different author produces a different key", () => {
    const k1 = computeIdempotencyKey(base);
    const k2 = computeIdempotencyKey({ ...base, author: "bastion" });
    expect(k1).not.toBe(k2);
  });

  it("different category produces a different key", () => {
    const k1 = computeIdempotencyKey(base);
    const k2 = computeIdempotencyKey({ ...base, category: "web-search" });
    expect(k1).not.toBe(k2);
  });

  it("field construction order does not affect the key (alphabetical ordering)", () => {
    // Explicit field ordering permutations — result must be equal
    const k1 = computeIdempotencyKey({
      content: "abc",
      author: "x",
      category: "y",
    });
    const k2 = computeIdempotencyKey({
      author: "x",
      category: "y",
      content: "abc",
    });
    const k3 = computeIdempotencyKey({
      category: "y",
      content: "abc",
      author: "x",
    });
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it("all empty strings still returns a 64-char hex string", () => {
    const key = computeIdempotencyKey({
      content: "",
      author: "",
      category: "",
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("unicode content produces a stable hash", () => {
    const payload = { content: "こんにちは", author: "👾", category: "🔐" };
    const k1 = computeIdempotencyKey(payload);
    const k2 = computeIdempotencyKey(payload);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same content with different author produces different keys", () => {
    const k1 = computeIdempotencyKey({
      content: "same",
      author: "alice",
      category: "c",
    });
    const k2 = computeIdempotencyKey({
      content: "same",
      author: "bob",
      category: "c",
    });
    expect(k1).not.toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// withIdempotency
// ---------------------------------------------------------------------------

describe("withIdempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes the factory on the first call", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const factory = vi.fn().mockResolvedValue("result-a");
    const result = await withIdempotency(factory, "key-1", undefined, store);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toBe("result-a");
  });

  it("returns the cached result on the second call without re-executing", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const factory = vi.fn().mockResolvedValue("result-b");
    await withIdempotency(factory, "key-2", undefined, store);
    const second = await withIdempotency(factory, "key-2", undefined, store);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toBe("result-b");
  });

  it("different keys execute the factory independently", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const factoryA = vi.fn().mockResolvedValue("a");
    const factoryB = vi.fn().mockResolvedValue("b");
    const ra = await withIdempotency(factoryA, "key-a", undefined, store);
    const rb = await withIdempotency(factoryB, "key-b", undefined, store);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
    expect(factoryA).toHaveBeenCalledTimes(1);
    expect(factoryB).toHaveBeenCalledTimes(1);
  });

  it("re-executes the factory after TTL expires", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const factory = vi.fn().mockResolvedValue("fresh");
    const ttlMs = 1_000;

    await withIdempotency(factory, "key-ttl", { ttlMs }, store);
    expect(factory).toHaveBeenCalledTimes(1);

    // Advance clock past TTL
    vi.advanceTimersByTime(ttlMs + 1);

    await withIdempotency(factory, "key-ttl", { ttlMs }, store);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a failed call (allows retry)", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const factory = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");

    await expect(withIdempotency(factory, "key-fail", undefined, store)).rejects.toThrow(
      "transient",
    );

    // Second call should invoke factory again
    const result = await withIdempotency(factory, "key-fail", undefined, store);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(result).toBe("ok");
  });

  it("concurrent calls with the same key only invoke factory once (fan-out dedup)", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    let resolve: (v: string) => void;
    const pending = new Promise<string>((res) => {
      resolve = res;
    });
    const factory = vi.fn().mockReturnValue(pending);

    // Fire two concurrent calls before factory resolves
    const p1 = withIdempotency(factory, "key-concurrent", undefined, store);
    const p2 = withIdempotency(factory, "key-concurrent", undefined, store);

    resolve!("shared");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
  });

  it("returns the correct result type", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const payload = { id: 42, name: "test" };
    const factory = vi.fn().mockResolvedValue(payload);
    const result = await withIdempotency(factory, "key-type", undefined, store);
    expect(result).toEqual(payload);
    expect((result as typeof payload).id).toBe(42);
  });

  it("uses the default 5-minute TTL when no options are provided", async () => {
    const store = new Map<string, CacheEntry<unknown>>();
    const factory = vi.fn().mockResolvedValue("default-ttl");

    await withIdempotency(factory, "key-default-ttl", undefined, store);

    // Advance just under 5 minutes — should still be cached
    vi.advanceTimersByTime(5 * 60_000 - 1);
    await withIdempotency(factory, "key-default-ttl", undefined, store);
    expect(factory).toHaveBeenCalledTimes(1);

    // Advance past 5 minutes — should re-execute
    vi.advanceTimersByTime(2);
    await withIdempotency(factory, "key-default-ttl", undefined, store);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("isolated stores do not share state", async () => {
    const store1 = new Map<string, CacheEntry<unknown>>();
    const store2 = new Map<string, CacheEntry<unknown>>();
    const factory = vi.fn().mockResolvedValue("isolated");

    await withIdempotency(factory, "key-iso", undefined, store1);
    await withIdempotency(factory, "key-iso", undefined, store2);

    // Each store is independent — factory called once per store
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// addIdempotencyHeader
// ---------------------------------------------------------------------------

describe("addIdempotencyHeader", () => {
  it("adds X-Idempotency-Key to an empty headers object", () => {
    const result = addIdempotencyHeader({}, "abc123");
    expect(result["X-Idempotency-Key"]).toBe("abc123");
  });

  it("does not overwrite existing headers", () => {
    const headers = {
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    };
    const result = addIdempotencyHeader(headers, "key-xyz");
    expect(result.Authorization).toBe("Bearer token");
    expect(result["Content-Type"]).toBe("application/json");
    expect(result["X-Idempotency-Key"]).toBe("key-xyz");
  });

  it("header value matches the key passed", () => {
    const key = computeIdempotencyKey({
      content: "test",
      author: "agent",
      category: "cat",
    });
    const result = addIdempotencyHeader({}, key);
    expect(result["X-Idempotency-Key"]).toBe(key);
  });

  it("returns a new object and does not mutate the input", () => {
    const original: Record<string, string> = { "X-Custom": "value" };
    const result = addIdempotencyHeader(original, "new-key");
    expect(original["X-Idempotency-Key"]).toBeUndefined();
    expect(result["X-Idempotency-Key"]).toBe("new-key");
    expect(result).not.toBe(original);
  });

  it("preserves all existing headers in the returned object", () => {
    const headers = { A: "1", B: "2", C: "3" };
    const result = addIdempotencyHeader(headers, "k");
    expect(Object.keys(result)).toHaveLength(4);
    expect(result.A).toBe("1");
    expect(result.B).toBe("2");
    expect(result.C).toBe("3");
  });
});
