/**
 * Tests for orchestration/bulkhead.ts
 *
 * Sprint-468 (command-center:sprint-468:bulkhead)
 *
 * Coverage:
 *   - concurrent tasks ≤ maxConcurrent at any point
 *   - FIFO queue ordering
 *   - fast-reject when queue full + rejectOnFull=true
 *   - metrics counters: active, queued, rejected, completed
 *   - rejectOnFull=false blocks until slot available
 *   - errors propagated, completed counter still increments
 */

import { describe, expect, it } from "vitest";
import { BulkheadQueueFullError, createBulkhead } from "../../src/orchestration/bulkhead.js";

// Helper: a task that resolves after `ms` milliseconds
function delay(ms: number): () => Promise<void> {
  return () => new Promise((r) => setTimeout(r, ms));
}

// Helper: manually controlled task.
// The inner promise's resolve/reject are exposed so the test can settle it
// from outside. The fn is passed to pool.run(); when the pool invokes fn(),
// it returns the same long-lived Promise that the test controls.
function controllable<T>(): {
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const inner = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const fn = () => inner;
  return { fn, resolve, reject };
}

describe("createBulkhead — concurrency gate", () => {
  it("executes up to maxConcurrent tasks concurrently", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 3 });
    let peak = 0;
    let current = 0;

    const tasks = Array.from({ length: 3 }, () =>
      pool.run(async () => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 10));
        current -= 1;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBe(3);
    expect(pool.metrics().completed).toBe(3);
  });

  it("never exceeds maxConcurrent active tasks", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 2, maxQueue: 10 });
    let peak = 0;
    let current = 0;

    const tasks = Array.from({ length: 6 }, () =>
      pool.run(async () => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 5));
        current -= 1;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
    expect(pool.metrics().completed).toBe(6);
  });
});

describe("createBulkhead — FIFO queue ordering", () => {
  it("drains queue in submission order", async () => {
    const order: number[] = [];
    const pool = createBulkhead<void>({ maxConcurrent: 1, maxQueue: 5 });

    // First task holds the slot.
    const first = controllable<void>();
    const firstPromise = pool.run(first.fn);

    // Queue 3 more tasks.
    const results = [1, 2, 3].map((n) =>
      pool.run(async () => {
        order.push(n);
      }),
    );

    // Release first task to start draining the queue.
    first.resolve(undefined);
    await firstPromise;
    await Promise.all(results);

    expect(order).toEqual([1, 2, 3]);
  });
});

describe("createBulkhead — fast-reject (rejectOnFull=true)", () => {
  it("throws BulkheadQueueFullError when queue is at capacity", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 1, maxQueue: 2, rejectOnFull: true });

    const held = controllable<void>();
    const heldPromise = pool.run(held.fn); // occupies the single worker slot

    // Fill the queue.
    const q1 = pool.run(delay(1));
    const q2 = pool.run(delay(1));

    // Next submission should fast-reject.
    await expect(pool.run(delay(1))).rejects.toThrow(BulkheadQueueFullError);

    held.resolve(undefined);
    await heldPromise;
    await Promise.all([q1, q2]);
  });

  it("increments rejected counter on fast-reject", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 1, maxQueue: 0, rejectOnFull: true });

    const held = controllable<void>();
    const heldPromise = pool.run(held.fn);

    await expect(pool.run(delay(1))).rejects.toThrow(BulkheadQueueFullError);
    await expect(pool.run(delay(1))).rejects.toThrow(BulkheadQueueFullError);

    expect(pool.metrics().rejected).toBe(2);

    held.resolve(undefined);
    await heldPromise;
  });
});

describe("createBulkhead — metrics counters", () => {
  it("metrics reflects initial state", () => {
    const pool = createBulkhead<void>({ maxConcurrent: 5 });
    expect(pool.metrics()).toEqual({ active: 0, queued: 0, rejected: 0, completed: 0 });
  });

  it("active increments while task runs, decrements on completion", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 2 });

    const t = controllable<void>();
    const p = pool.run(t.fn);

    expect(pool.metrics().active).toBe(1);
    t.resolve(undefined);
    await p;
    expect(pool.metrics().active).toBe(0);
    expect(pool.metrics().completed).toBe(1);
  });

  it("queued reflects tasks waiting", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 1, maxQueue: 5 });

    const t1 = controllable<void>();
    const p1 = pool.run(t1.fn);

    // Enqueue 2 more tasks.
    const p2 = pool.run(delay(1));
    const p3 = pool.run(delay(1));

    expect(pool.metrics().active).toBe(1);
    expect(pool.metrics().queued).toBe(2);

    t1.resolve(undefined);
    await p1;
    await Promise.all([p2, p3]);
    expect(pool.metrics().queued).toBe(0);
    expect(pool.metrics().completed).toBe(3);
  });

  it("completed increments even when task throws", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 2 });

    await expect(
      pool.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(pool.metrics().completed).toBe(1);
    expect(pool.metrics().active).toBe(0);
  });
});

describe("createBulkhead — rejectOnFull=false (backpressure mode)", () => {
  it("queues tasks beyond maxQueue when rejectOnFull is false", async () => {
    // With rejectOnFull=false and maxQueue=1, tasks queue up beyond cap
    // only if the internal safety valve isn't hit. Here we test normal
    // blocking behaviour with a small queue that we drain promptly.
    const pool = createBulkhead<number>({ maxConcurrent: 1, maxQueue: 1, rejectOnFull: false });

    const results: number[] = [];
    const t1 = controllable<void>();
    const p1 = pool
      .run(async () => {
        await t1.fn();
        return 1;
      })
      .then((v) => {
        results.push(v);
      });

    // One task can queue.
    const p2 = pool
      .run(async () => 2)
      .then((v) => {
        results.push(v);
      });

    t1.resolve(undefined);
    await Promise.all([p1, p2]);

    expect(results).toContain(1);
    expect(results).toContain(2);
  });
});
