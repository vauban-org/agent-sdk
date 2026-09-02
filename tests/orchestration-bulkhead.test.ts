/**
 * Tests for src/orchestration/bulkhead.ts — createBulkhead factory pool.
 *
 * Coverage:
 *   BulkheadQueueFullError — error shape, message content
 *   createBulkhead — factory return shape, initial metrics
 *   successful and failed tasks — completed counter
 *   concurrency control — maxConcurrent=1 serializes, maxConcurrent=2 parallelizes
 *   queued tasks — run after active slot is freed, queue depth reflected in metrics
 *   rejection — rejectOnFull=true throws synchronously, rejected counter increments
 *   FIFO ordering — tasks dequeue in submission order
 *   multi-task correctness — each task resolves independently, errors are isolated
 *   maxQueue default — equals maxConcurrent * 10
 */

import { describe, expect, it } from "vitest";
import { BulkheadQueueFullError, createBulkhead } from "../src/orchestration/bulkhead.js";

// ─── BulkheadQueueFullError ───────────────────────────────────────────────────

describe("BulkheadQueueFullError", () => {
  it("is an instance of Error", () => {
    const err = new BulkheadQueueFullError(1, 2, 2, 20);
    expect(err).toBeInstanceOf(Error);
  });

  it("name === 'BulkheadQueueFullError'", () => {
    const err = new BulkheadQueueFullError(1, 2, 2, 20);
    expect(err.name).toBe("BulkheadQueueFullError");
  });

  it("message contains active count", () => {
    const err = new BulkheadQueueFullError(3, 5, 4, 20);
    expect(err.message).toContain("active=3");
  });

  it("message contains queued count", () => {
    const err = new BulkheadQueueFullError(3, 5, 4, 20);
    expect(err.message).toContain("queued=5");
  });

  it("message contains maxConcurrent", () => {
    const err = new BulkheadQueueFullError(3, 5, 4, 20);
    expect(err.message).toContain("4");
  });

  it("message contains maxQueue", () => {
    const err = new BulkheadQueueFullError(3, 5, 4, 20);
    expect(err.message).toContain("20");
  });
});

// ─── createBulkhead basics ────────────────────────────────────────────────────

describe("createBulkhead — return shape", () => {
  it("returns an object with run and metrics methods", () => {
    const pool = createBulkhead<string>({ maxConcurrent: 2 });
    expect(typeof pool.run).toBe("function");
    expect(typeof pool.metrics).toBe("function");
  });

  it("metrics() initially shows active=0, queued=0, rejected=0, completed=0", () => {
    const pool = createBulkhead<number>({ maxConcurrent: 3 });
    expect(pool.metrics()).toEqual({
      active: 0,
      queued: 0,
      rejected: 0,
      completed: 0,
    });
  });
});

describe("createBulkhead — task completion", () => {
  it("successful task increments completed", async () => {
    const pool = createBulkhead<string>({ maxConcurrent: 2 });
    await pool.run(async () => "ok");
    expect(pool.metrics().completed).toBe(1);
  });

  it("failed task also increments completed (completion counts errors)", async () => {
    const pool = createBulkhead<never>({ maxConcurrent: 2 });
    await expect(
      pool.run(async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    expect(pool.metrics().completed).toBe(1);
  });

  it("metrics().active === 0 after task completes", async () => {
    const pool = createBulkhead<number>({ maxConcurrent: 2 });
    await pool.run(async () => 42);
    expect(pool.metrics().active).toBe(0);
  });

  it("run resolves with the task return value", async () => {
    const pool = createBulkhead<number>({ maxConcurrent: 2 });
    const result = await pool.run(async () => 99);
    expect(result).toBe(99);
  });
});

// ─── Concurrency control ──────────────────────────────────────────────────────

describe("createBulkhead — concurrency control", () => {
  it("maxConcurrent=1: second task queues while first is active", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 1 });
    let resolve1!: () => void;
    const blocking = new Promise<void>((r) => {
      resolve1 = r;
    });

    const p1 = pool.run(() => blocking);

    // After submitting p1, metrics should show active=1
    expect(pool.metrics().active).toBe(1);

    // Submit second task — it should queue (not start yet)
    const p2 = pool.run(async () => {});
    expect(pool.metrics().queued).toBe(1);

    resolve1();
    await p1;
    await p2;
  });

  it("maxConcurrent=2: two tasks run simultaneously", async () => {
    const pool = createBulkhead<void>({ maxConcurrent: 2 });
    let activeAtPeak = 0;

    let resolve1!: () => void;
    let resolve2!: () => void;
    const b1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    const b2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    const p1 = pool.run(async () => {
      await b1;
    });
    const p2 = pool.run(async () => {
      await b2;
    });

    activeAtPeak = pool.metrics().active;
    resolve1();
    resolve2();
    await Promise.all([p1, p2]);

    expect(activeAtPeak).toBe(2);
  });

  it("queued tasks run after active tasks complete", async () => {
    const pool = createBulkhead<number>({ maxConcurrent: 1 });
    let resolve1!: () => void;
    const blocking = new Promise<void>((r) => {
      resolve1 = r;
    });

    const p1 = pool.run(() => blocking.then(() => 1));
    const p2 = pool.run(async () => 2);

    expect(pool.metrics().queued).toBe(1);

    resolve1();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(pool.metrics().queued).toBe(0);
  });

  it("metrics().queued reflects waiting tasks", async () => {
    const pool = createBulkhead<void>({
      maxConcurrent: 1,
      maxQueue: 5,
    });

    const resolvers: Array<() => void> = [];
    const tasks = Array.from({ length: 3 }, () => {
      let res!: () => void;
      const p = new Promise<void>((r) => {
        res = r;
      });
      resolvers.push(res);
      return pool.run(() => p);
    });

    // 1 active, 2 queued
    expect(pool.metrics().active).toBe(1);
    expect(pool.metrics().queued).toBe(2);

    resolvers.forEach((r) => r());
    await Promise.all(tasks);
    expect(pool.metrics().queued).toBe(0);
  });
});

// ─── Queue full and rejection ──────────────────────────────────────────────────

describe("createBulkhead — queue full rejection", () => {
  it("rejectOnFull=true (default): rejects with BulkheadQueueFullError when queue full", async () => {
    const pool = createBulkhead<void>({
      maxConcurrent: 1,
      maxQueue: 1,
      rejectOnFull: true,
    });

    let resolve1!: () => void;
    const blocking = new Promise<void>((r) => {
      resolve1 = r;
    });

    const p1 = pool.run(() => blocking);
    // fills queue slot
    const p2 = pool.run(async () => {});

    // queue is now full — next should reject with BulkheadQueueFullError
    await expect(pool.run(async () => {})).rejects.toThrow(BulkheadQueueFullError);

    resolve1();
    await p1;
    await p2;
  });

  it("rejected counter increments on BulkheadQueueFullError", async () => {
    const pool = createBulkhead<void>({
      maxConcurrent: 1,
      maxQueue: 0,
      rejectOnFull: true,
    });

    let resolveBlock!: () => void;
    const blocking = new Promise<void>((r) => {
      resolveBlock = r;
    });
    const p1 = pool.run(() => blocking);

    // Queue is full immediately (maxQueue=0) — run() returns a rejected promise
    await expect(pool.run(async () => {})).rejects.toThrow(BulkheadQueueFullError);

    expect(pool.metrics().rejected).toBe(1);

    resolveBlock();
    await p1;
  });

  it("BulkheadQueueFullError surfaces via rejected promise (run is async)", async () => {
    const pool = createBulkhead<void>({
      maxConcurrent: 1,
      maxQueue: 0,
    });

    let resolveBlock!: () => void;
    const blocking = new Promise<void>((r) => {
      resolveBlock = r;
    });
    const p1 = pool.run(() => blocking);

    // run() returns a rejected Promise — not a synchronous throw
    const rejected = pool.run(async () => {});
    await expect(rejected).rejects.toBeInstanceOf(BulkheadQueueFullError);

    resolveBlock();
    await p1;
  });
});

// ─── FIFO ordering ────────────────────────────────────────────────────────────

describe("createBulkhead — FIFO ordering", () => {
  it("tasks complete in submission order when maxConcurrent=1", async () => {
    const pool = createBulkhead<number>({ maxConcurrent: 1, maxQueue: 10 });
    const completionOrder: number[] = [];

    const resolvers: Array<() => void> = [];
    const tasks = [1, 2, 3].map((n) => {
      let res!: () => void;
      const p = new Promise<void>((r) => {
        res = r;
      });
      resolvers.push(res);
      return pool.run(async () => {
        await p;
        completionOrder.push(n);
        return n;
      });
    });

    // resolve in order: 1, then 2, then 3
    resolvers[0]();
    await tasks[0];
    resolvers[1]();
    await tasks[1];
    resolvers[2]();
    await tasks[2];

    expect(completionOrder).toEqual([1, 2, 3]);
  });
});

// ─── Multiple tasks ───────────────────────────────────────────────────────────

describe("createBulkhead — multiple tasks", () => {
  it("all submitted tasks eventually resolve", async () => {
    const pool = createBulkhead<number>({ maxConcurrent: 2, maxQueue: 10 });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => pool.run(async () => n)));
    expect(results).toHaveLength(5);
    expect(pool.metrics().completed).toBe(5);
  });

  it("each task gets its own result value", async () => {
    const pool = createBulkhead<string>({ maxConcurrent: 3 });
    const [a, b, c] = await Promise.all([
      pool.run(async () => "alpha"),
      pool.run(async () => "beta"),
      pool.run(async () => "gamma"),
    ]);
    expect(a).toBe("alpha");
    expect(b).toBe("beta");
    expect(c).toBe("gamma");
  });

  it("error in one task does not affect other tasks", async () => {
    const pool = createBulkhead<string>({ maxConcurrent: 2, maxQueue: 10 });

    const okTask = pool.run(async () => "fine");
    const badTask = pool.run(async () => {
      throw new Error("boom");
    });

    const okResult = await okTask;
    await expect(badTask).rejects.toThrow("boom");

    expect(okResult).toBe("fine");
    // Both tasks counted as completed (error counts too)
    expect(pool.metrics().completed).toBe(2);
  });
});

// ─── maxQueue default ─────────────────────────────────────────────────────────

describe("createBulkhead — maxQueue default", () => {
  it("default maxQueue = maxConcurrent * 10", async () => {
    const maxConcurrent = 3;
    const expectedMaxQueue = maxConcurrent * 10; // 30
    const pool = createBulkhead<void>({
      maxConcurrent,
      rejectOnFull: true,
    });

    const resolvers: Array<() => void> = [];

    // Fill all slots: 3 active + 30 queued = 33 tasks total
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < maxConcurrent + expectedMaxQueue; i++) {
      let res!: () => void;
      const p = new Promise<void>((r) => {
        res = r;
      });
      resolvers.push(res);
      tasks.push(pool.run(() => p));
    }

    expect(pool.metrics().active).toBe(maxConcurrent);
    expect(pool.metrics().queued).toBe(expectedMaxQueue);

    // One more should be rejected
    await expect(pool.run(async () => {})).rejects.toThrow(BulkheadQueueFullError);

    resolvers.forEach((r) => r());
    await Promise.all(tasks);
  });
});
