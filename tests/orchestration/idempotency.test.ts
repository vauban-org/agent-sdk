/**
 * Tests for orchestration/idempotency.ts
 *
 * Sprint-468 (command-center:sprint-468:idempotency-keys)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addIdempotencyHeader,
  computeIdempotencyKey,
  withIdempotency,
} from "../../src/orchestration/idempotency.js";

// ---------------------------------------------------------------------------
// computeIdempotencyKey
// ---------------------------------------------------------------------------

describe("computeIdempotencyKey", () => {
  it("returns a 64-char hex string", () => {
    const key = computeIdempotencyKey({
      content: "hello",
      author: "alice",
      category: "test",
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const payload = { content: "x", author: "y", category: "z" };
    expect(computeIdempotencyKey(payload)).toBe(computeIdempotencyKey(payload));
  });

  it("differs when content changes", () => {
    const base = { author: "a", category: "c" };
    const k1 = computeIdempotencyKey({ ...base, content: "abc" });
    const k2 = computeIdempotencyKey({ ...base, content: "xyz" });
    expect(k1).not.toBe(k2);
  });

  it("differs when author changes", () => {
    const base = { content: "c", category: "c" };
    const k1 = computeIdempotencyKey({ ...base, author: "alice" });
    const k2 = computeIdempotencyKey({ ...base, author: "bob" });
    expect(k1).not.toBe(k2);
  });

  it("differs when category changes", () => {
    const base = { content: "c", author: "a" };
    const k1 = computeIdempotencyKey({ ...base, category: "cat1" });
    const k2 = computeIdempotencyKey({ ...base, category: "cat2" });
    expect(k1).not.toBe(k2);
  });

  it("is field-order independent (same result regardless of construction order)", () => {
    // Both objects have the same field values; JS property order doesn't matter
    // because computeIdempotencyKey accesses fields by name.
    const k1 = computeIdempotencyKey({ content: "c", author: "a", category: "g" });
    const k2 = computeIdempotencyKey({ category: "g", content: "c", author: "a" });
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// withIdempotency
// ---------------------------------------------------------------------------

describe("withIdempotency", () => {
  // Use a fresh per-test store to isolate tests.
  let store: Map<string, { promise: Promise<unknown>; expiresAt: number }>;

  beforeEach(() => {
    store = new Map();
  });

  it("calls the factory once and returns the result", async () => {
    const factory = vi.fn().mockResolvedValue(42);
    const result = await withIdempotency(factory, "key1", undefined, store);
    expect(result).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent calls with the same key", async () => {
    let resolveInner!: (v: number) => void;
    const inner = new Promise<number>((r) => {
      resolveInner = r;
    });
    const factory = vi.fn().mockReturnValue(inner);

    const p1 = withIdempotency(factory, "key2", undefined, store);
    const p2 = withIdempotency(factory, "key2", undefined, store);

    // Factory invoked only once even though two callers attached.
    expect(factory).toHaveBeenCalledTimes(1);

    resolveInner(99);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(99);
    expect(r2).toBe(99);
  });

  it("does NOT cache failures — retry is possible", async () => {
    const factory = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");

    await expect(withIdempotency(factory, "key3", undefined, store)).rejects.toThrow("transient");
    // After failure the entry is evicted — second call succeeds.
    const result = await withIdempotency(factory, "key3", undefined, store);
    expect(result).toBe("ok");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("returns cached result on second call within TTL", async () => {
    const factory = vi.fn().mockResolvedValue("cached");
    await withIdempotency(factory, "key4", { ttlMs: 10_000 }, store);
    const second = await withIdempotency(factory, "key4", { ttlMs: 10_000 }, store);
    expect(second).toBe("cached");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("re-invokes after TTL expires", async () => {
    const factory = vi.fn().mockResolvedValueOnce("first").mockResolvedValue("second");

    // ttlMs=1 → expires almost immediately
    await withIdempotency(factory, "key5", { ttlMs: 1 }, store);
    // Wait past TTL
    await new Promise((r) => setTimeout(r, 5));
    const result = await withIdempotency(factory, "key5", { ttlMs: 1 }, store);
    expect(result).toBe("second");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("different keys do not interfere", async () => {
    const factoryA = vi.fn().mockResolvedValue("A");
    const factoryB = vi.fn().mockResolvedValue("B");
    const [a, b] = await Promise.all([
      withIdempotency(factoryA, "keyA", undefined, store),
      withIdempotency(factoryB, "keyB", undefined, store),
    ]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(factoryA).toHaveBeenCalledTimes(1);
    expect(factoryB).toHaveBeenCalledTimes(1);
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

  it("preserves existing headers", () => {
    const result = addIdempotencyHeader({ Authorization: "Bearer tok" }, "k1");
    expect(result.Authorization).toBe("Bearer tok");
    expect(result["X-Idempotency-Key"]).toBe("k1");
  });

  it("does not mutate the original headers object", () => {
    const original: Record<string, string> = { Accept: "application/json" };
    addIdempotencyHeader(original, "k2");
    expect(original["X-Idempotency-Key"]).toBeUndefined();
  });

  it("overwrites an existing X-Idempotency-Key", () => {
    const result = addIdempotencyHeader({ "X-Idempotency-Key": "old" }, "new");
    expect(result["X-Idempotency-Key"]).toBe("new");
  });
});
