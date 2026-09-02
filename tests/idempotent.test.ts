/**
 * Tests for packages/agent-sdk/src/resilience/idempotent.ts
 *
 * Coverage:
 *   BoundedTtlCache — get miss, get hit, TTL expiry, LRU eviction on maxEntries
 *   idempotent — dedupes identical keyed calls, does NOT cache failures,
 *                calls fn exactly once on repeated same-key calls
 *   hashKey — deterministic, handles undefined, string, object
 *
 * Ref: test coverage for agent-sdk/resilience/idempotent.ts (no prior tests)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedTtlCache, hashKey, idempotent } from "../src/resilience/idempotent.js";

// ─── BoundedTtlCache ──────────────────────────────────────────────────────────

describe("BoundedTtlCache", () => {
  it("returns undefined for unknown key", () => {
    const cache = new BoundedTtlCache<number>(10, 60_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns stored value before TTL", () => {
    const now = vi.fn().mockReturnValue(1000);
    const cache = new BoundedTtlCache<string>(10, 60_000, now);
    cache.set("k", "hello");
    now.mockReturnValue(2000); // still within TTL
    expect(cache.get("k")).toBe("hello");
  });

  it("returns undefined after TTL expires", () => {
    const now = vi.fn().mockReturnValue(1000);
    const cache = new BoundedTtlCache<string>(10, 5_000, now);
    cache.set("k", "value");
    now.mockReturnValue(7000); // 6s later, past TTL
    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts oldest entry when maxEntries exceeded", () => {
    const cache = new BoundedTtlCache<number>(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a" (oldest)
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("delete removes entry", () => {
    const cache = new BoundedTtlCache<string>(10, 60_000);
    cache.set("k", "v");
    cache.delete("k");
    expect(cache.get("k")).toBeUndefined();
  });

  it("size tracks entry count", () => {
    const cache = new BoundedTtlCache<number>(10, 60_000);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
  });
});

// ─── idempotent ───────────────────────────────────────────────────────────────

describe("idempotent", () => {
  it("calls fn exactly once for repeated same-key calls", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const safe = idempotent(fn, { keyFor: (x: string) => x });
    await safe("key-1");
    await safe("key-1");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("returns cached result on second call", async () => {
    const fn = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const safe = idempotent(fn, { keyFor: (x: string) => x });
    const r1 = await safe("k");
    const r2 = await safe("k");
    expect(r1).toBe("first");
    expect(r2).toBe("first"); // cached
  });

  it("calls fn independently for different keys", async () => {
    const fn = vi.fn().mockResolvedValue("x");
    const safe = idempotent(fn, { keyFor: (x: string) => x });
    await safe("key-a");
    await safe("key-b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache failures — retries are allowed", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValueOnce("success");
    const safe = idempotent(fn, { keyFor: (x: string) => x });
    await expect(safe("k")).rejects.toThrow("fail");
    const result = await safe("k");
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("accepts a custom cache implementation", async () => {
    const customCache = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const fn = vi.fn().mockResolvedValue(42);
    const safe = idempotent(fn, { keyFor: () => "k", cache: customCache });
    await safe();
    expect(customCache.set).toHaveBeenCalledWith("k", 42);
  });
});

// ─── hashKey ──────────────────────────────────────────────────────────────────

describe("hashKey", () => {
  it("returns a 64-char hex string", () => {
    expect(hashKey("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    expect(hashKey("a", "b", 3)).toBe(hashKey("a", "b", 3));
  });

  it("differs for different inputs", () => {
    expect(hashKey("x")).not.toBe(hashKey("y"));
  });

  it("handles undefined without throwing", () => {
    expect(() => hashKey(undefined, "defined")).not.toThrow();
    expect(hashKey(undefined, "x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles objects (JSON-serialized)", () => {
    const k1 = hashKey({ a: 1, b: 2 });
    const k2 = hashKey({ a: 1, b: 2 });
    expect(k1).toBe(k2);
  });
});
