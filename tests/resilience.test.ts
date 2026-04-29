/**
 * Tests for resilience primitives (Sprint-468).
 */

import { describe, expect, it, vi } from "vitest";
import {
  BoundedTtlCache,
  bulkhead,
  BulkheadFullError,
  circuitBreaker,
  CircuitOpenError,
  hashKey,
  idempotent,
} from "../src/resilience/index.js";

// ─── circuitBreaker ──────────────────────────────────────────────────────

describe("circuitBreaker", () => {
  it("passes through while below threshold", async () => {
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    const cb = circuitBreaker(fn, { name: "test", failureThreshold: 3 });

    for (let i = 0; i < 10; i++) {
      const result = await cb();
      expect(result).toBe("ok");
    }
    expect(cb.state).toBe("closed");
  });

  it("trips OPEN after N consecutive failures", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const cb = circuitBreaker(fn, { name: "test", failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await expect(cb()).rejects.toThrow("boom");
    }
    expect(cb.state).toBe("open");

    // Next call fast-fails without invoking fn.
    await expect(cb()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("transitions OPEN → HALF-OPEN after resetAfterMs", async () => {
    let t = 0;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"))
      .mockResolvedValue("recovered");

    const cb = circuitBreaker(fn, {
      name: "test",
      failureThreshold: 3,
      resetAfterMs: 1_000,
      now: () => t,
    });

    for (let i = 0; i < 3; i++) await cb().catch(() => undefined);
    expect(cb.state).toBe("open");

    t = 1_500; // past resetAfterMs
    const result = await cb();
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
  });

  it("resets failureCount on any success", async () => {
    let flip = true; // starts true → first call fails, alternates thereafter
    const fn = vi.fn().mockImplementation(async () => {
      flip = !flip;
      if (!flip) throw new Error("fail");
      return "ok";
    });
    const cb = circuitBreaker(fn, { name: "test", failureThreshold: 3 });

    // fail, ok, fail, ok — never hits threshold consecutively.
    await cb().catch(() => undefined);
    await cb();
    await cb().catch(() => undefined);
    await cb();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("isFailure predicate can exempt errors", async () => {
    class SkipMe extends Error {}
    const fn = vi.fn().mockRejectedValue(new SkipMe());
    const cb = circuitBreaker(fn, {
      name: "test",
      failureThreshold: 3,
      isFailure: (e) => !(e instanceof SkipMe),
    });

    for (let i = 0; i < 10; i++) await cb().catch(() => undefined);
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("reset() forces back to CLOSED", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    const cb = circuitBreaker(fn, { name: "test", failureThreshold: 1 });
    await cb().catch(() => undefined);
    expect(cb.state).toBe("open");
    cb.reset();
    expect(cb.state).toBe("closed");
  });
});

// ─── idempotent ──────────────────────────────────────────────────────────

describe("idempotent", () => {
  it("calls fn once per key", async () => {
    const fn = vi.fn(async (x: number) => x * 2);
    const safe = idempotent(fn, { keyFor: (x) => String(x) });

    expect(await safe(3)).toBe(6);
    expect(await safe(3)).toBe(6);
    expect(await safe(3)).toBe(6);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("distinct keys do not share results", async () => {
    const fn = vi.fn(async (x: number) => x + 1);
    const safe = idempotent(fn, { keyFor: (x) => String(x) });

    expect(await safe(1)).toBe(2);
    expect(await safe(2)).toBe(3);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("failures are not cached — next call re-tries", async () => {
    let flip = true;
    const fn = vi.fn(async (x: number) => {
      if (flip) {
        flip = false;
        throw new Error("fail");
      }
      return x * 2;
    });
    const safe = idempotent(fn, { keyFor: (x) => String(x) });

    await expect(safe(3)).rejects.toThrow("fail");
    expect(await safe(3)).toBe(6);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("BoundedTtlCache evicts oldest when full", () => {
    const c = new BoundedTtlCache<string>(2, 10_000);
    c.set("a", "A");
    c.set("b", "B");
    c.set("c", "C");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("B");
    expect(c.get("c")).toBe("C");
  });

  it("BoundedTtlCache expires past TTL", () => {
    let t = 0;
    const c = new BoundedTtlCache<string>(10, 100, () => t);
    c.set("a", "A");
    t = 50;
    expect(c.get("a")).toBe("A");
    t = 200;
    expect(c.get("a")).toBeUndefined();
  });

  it("hashKey is deterministic for identical parts", () => {
    const k1 = hashKey({ content: "x", author: "y" });
    const k2 = hashKey({ content: "x", author: "y" });
    expect(k1).toBe(k2);
    const k3 = hashKey({ content: "x", author: "z" });
    expect(k3).not.toBe(k1);
  });
});

// ─── bulkhead ────────────────────────────────────────────────────────────

describe("bulkhead", () => {
  it("bounds concurrent active calls to maxConcurrent", async () => {
    let active = 0;
    let peak = 0;
    const fn = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    });
    const safe = bulkhead(fn, { name: "test", maxConcurrent: 3, maxQueued: 20 });

    await Promise.all(Array.from({ length: 10 }, () => safe()));
    expect(peak).toBeLessThanOrEqual(3);
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it("rejects with BulkheadFullError when queue is full", async () => {
    const fn = vi.fn(
      () => new Promise<void>((r) => setTimeout(r, 50)),
    );
    const safe = bulkhead(fn, { name: "test", maxConcurrent: 1, maxQueued: 1 });

    const first = safe();          // active
    const second = safe();         // queued
    await expect(safe()).rejects.toBeInstanceOf(BulkheadFullError); // rejected
    await first;
    await second;
  });

  it("stats expose active + queued depth", async () => {
    const fn = vi.fn(() => new Promise<void>((r) => setTimeout(r, 20)));
    const safe = bulkhead(fn, { name: "test", maxConcurrent: 2, maxQueued: 10 });

    const pending = Array.from({ length: 5 }, () => safe());
    await new Promise((r) => setTimeout(r, 5));
    expect(safe.stats.active).toBe(2);
    expect(safe.stats.queued).toBe(3);
    await Promise.all(pending);
  });
});
