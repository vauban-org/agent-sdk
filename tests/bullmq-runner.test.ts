/**
 * Tests for src/durable/bullmq-runner.ts — the BullMQRunner class itself
 * (constructor, createQueue, createWorker, flowProducer, dlqQueue,
 * runFlowReliable, queueRetryFn, close, DLQ routing).
 *
 * bullmq-archetype-policy.test.ts already covers the pure `archetypePolicy`
 * export; this file does not repeat it.
 *
 * Coverage:
 *   constructor — default redisDb/dlqName, redisFactory override vs the
 *     direct IORedis path with the shared connection options.
 *   createQueue — name validation, per-name caching, archetype-mismatch
 *     rejection on re-use, defaultJobOptions derived from the archetype and
 *     from config overrides, DLQ listener wired for every queue except the
 *     DLQ queue itself.
 *   createWorker — requires a registered queue, derives lockDuration from
 *     the archetype policy (clamped to [30s, 30min]), lets caller opts win,
 *     registers an error handler that logs without throwing.
 *   flowProducer / dlqQueue — lazy singletons, constructed at most once.
 *   runFlowReliable — input validation (empty children, unregistered parent
 *     queue), the FlowJob shape sent to FlowProducer.add, the
 *     completed/failed/mid-poll-child-failure/outer-timeout branches of the
 *     polling loop, and that a moveToFailed rejection is swallowed.
 *   queueRetryFn — adds to an "event" queue and returns job.id, falling
 *     back to "" when the job carries no id.
 *   close — idempotent, closes every worker/queue/QueueEvents/flow, and
 *     swallows a rejecting connection.quit().
 *   DLQ routing (attachDlqListener's "failed" handler + moveToDlq) —
 *     exhausted attempts, timeout by failure-reason regex, timeout by
 *     processedOn age, no-op when neither holds, no-op on a missing job,
 *     and a throwing getJob is caught rather than propagated.
 *
 * Ref: measured 2026-08-04 — 0.86% mutation score / 230 uncovered mutants on
 * this file; only the pure archetypePolicy helper had prior test coverage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// pino reads LOG_LEVEL at module-load time; keep test output clean.
process.env.LOG_LEVEL = "silent";

// ─── bullmq / ioredis / OTel doubles ───────────────────────────────────────
// BullMQRunner talks to Queue/Worker/FlowProducer/QueueEvents and to an
// ioredis connection; doubling at the library boundary (no real Redis)
// mirrors the existing cascade-adapter.test.ts style in this package.

interface JobInit {
  id?: string;
  data?: unknown;
  opts?: Record<string, unknown>;
  attemptsMade?: number;
  processedOn?: number;
  token?: string;
  states?: string[];
  depsSeq?: Array<{ failed?: string[] }>;
}

class MockJob {
  id: string | undefined;
  data: unknown;
  opts: Record<string, unknown>;
  attemptsMade: number;
  processedOn: number | undefined;
  token: string | undefined;
  moveToFailedCalls: Array<{ error: Error; token: string; removeChildDeps: boolean }> = [];
  moveToFailedImpl: (() => Promise<void>) | undefined;
  private readonly states: string[];
  private readonly depsSeq: Array<{ failed?: string[] }>;
  private stateIdx = 0;
  private depsIdx = 0;

  constructor(init: JobInit = {}) {
    // "id" absent → default fixture id "job-1". "id" explicitly undefined →
    // respect it (tests the no-id fallback path in queueRetryFn).
    this.id = "id" in init ? init.id : "job-1";
    this.data = init.data;
    this.opts = init.opts ?? {};
    this.attemptsMade = init.attemptsMade ?? 0;
    this.processedOn = init.processedOn;
    this.token = init.token;
    this.states = init.states ?? ["completed"];
    this.depsSeq = init.depsSeq ?? [{}];
  }

  async getState(): Promise<string> {
    const idx = Math.min(this.stateIdx, this.states.length - 1);
    this.stateIdx += 1;
    return this.states[idx] as string;
  }

  async getDependencies(_opts: unknown): Promise<{ failed?: string[] }> {
    const idx = Math.min(this.depsIdx, this.depsSeq.length - 1);
    this.depsIdx += 1;
    return this.depsSeq[idx] as { failed?: string[] };
  }

  async moveToFailed(error: Error, token: string, removeChildDeps: boolean): Promise<void> {
    this.moveToFailedCalls.push({ error, token, removeChildDeps });
    if (this.moveToFailedImpl) await this.moveToFailedImpl();
  }
}

class MockQueue {
  static instances: MockQueue[] = [];
  static reset(): void {
    MockQueue.instances = [];
  }

  name: string;
  opts: { defaultJobOptions?: Record<string, unknown> };
  addCalls: Array<{ name: string; data: unknown; opts?: unknown }> = [];
  jobsById = new Map<string, MockJob>();
  getJobImpl: ((id: string) => Promise<MockJob | null>) | undefined;
  addImpl: ((name: string, data: unknown, opts?: unknown) => Promise<MockJob>) | undefined;
  closeCalls = 0;

  constructor(name: string, opts: { defaultJobOptions?: Record<string, unknown> }) {
    this.name = name;
    this.opts = opts;
    MockQueue.instances.push(this);
  }

  async add(name: string, data: unknown, opts?: unknown): Promise<MockJob> {
    this.addCalls.push({ name, data, opts });
    if (this.addImpl) return this.addImpl(name, data, opts);
    const job = new MockJob({
      id: `job-${this.addCalls.length}`,
      data,
      opts: (opts as Record<string, unknown>) ?? {},
    });
    this.jobsById.set(job.id as string, job);
    return job;
  }

  async getJob(id: string): Promise<MockJob | null> {
    if (this.getJobImpl) return this.getJobImpl(id);
    return this.jobsById.get(id) ?? null;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class MockWorker {
  static instances: MockWorker[] = [];
  static reset(): void {
    MockWorker.instances = [];
  }

  name: string;
  processor: unknown;
  opts: Record<string, unknown>;
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  closeCalls = 0;

  constructor(name: string, processor: unknown, opts: Record<string, unknown>) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    MockWorker.instances.push(this);
  }

  on(event: string, cb: (...args: unknown[]) => unknown): this {
    this.handlers.set(event, cb);
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class MockFlowProducer {
  static instances: MockFlowProducer[] = [];
  static reset(): void {
    MockFlowProducer.instances = [];
  }

  opts: unknown;
  addCalls: unknown[] = [];
  addImpl: ((flowJob: unknown) => Promise<{ job: { id: string | undefined } }>) | undefined;
  closeCalls = 0;

  constructor(opts: unknown) {
    this.opts = opts;
    MockFlowProducer.instances.push(this);
  }

  async add(flowJob: unknown): Promise<{ job: { id: string | undefined } }> {
    this.addCalls.push(flowJob);
    if (this.addImpl) return this.addImpl(flowJob);
    return { job: { id: "parent-1" } };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class MockQueueEvents {
  static instances: MockQueueEvents[] = [];
  static reset(): void {
    MockQueueEvents.instances = [];
  }

  name: string;
  opts: unknown;
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  closeCalls = 0;

  constructor(name: string, opts: unknown) {
    this.name = name;
    this.opts = opts;
    MockQueueEvents.instances.push(this);
  }

  on(event: string, cb: (...args: unknown[]) => unknown): this {
    this.handlers.set(event, cb);
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

vi.mock("bullmq", () => ({
  Queue: MockQueue,
  Worker: MockWorker,
  FlowProducer: MockFlowProducer,
  QueueEvents: MockQueueEvents,
}));

class MockIORedis {
  static instances: MockIORedis[] = [];
  static reset(): void {
    MockIORedis.instances = [];
  }

  url: string;
  opts: unknown;
  quit = vi.fn().mockResolvedValue(undefined);

  constructor(url: string, opts: unknown) {
    this.url = url;
    this.opts = opts;
    MockIORedis.instances.push(this);
  }
}

vi.mock("ioredis", () => ({
  default: MockIORedis,
}));

function makeSpan() {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}

let lastSpan: ReturnType<typeof makeSpan>;

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
  trace: {
    getTracer: () => ({
      startSpan: () => {
        lastSpan = makeSpan();
        return lastSpan;
      },
    }),
  },
}));

const { BullMQRunner, createBullMQRunner } = await import("../src/durable/bullmq-runner.js");
type IORedisLikeFake = { quit: () => Promise<void> };

function fakeConnection(overrides: Partial<IORedisLikeFake> = {}): IORedisLikeFake {
  return { quit: vi.fn().mockResolvedValue(undefined), ...overrides };
}

beforeEach(() => {
  MockQueue.reset();
  MockWorker.reset();
  MockFlowProducer.reset();
  MockQueueEvents.reset();
  MockIORedis.reset();
});

// ─── constructor ────────────────────────────────────────────────────────────

describe("BullMQRunner constructor", () => {
  it("uses redisDb 3 and dlqName 'cc-dlq' by default", () => {
    const factory = vi.fn().mockReturnValue(fakeConnection());
    new BullMQRunner({ redisUrl: "redis://x", redisFactory: factory as never });
    expect(factory).toHaveBeenCalledWith("redis://x", 3);
  });

  it("honors an explicit redisDb override", () => {
    const factory = vi.fn().mockReturnValue(fakeConnection());
    new BullMQRunner({ redisUrl: "redis://x", redisDb: 9, redisFactory: factory as never });
    expect(factory).toHaveBeenCalledWith("redis://x", 9);
  });

  it("falls back to a direct IORedis connection when no redisFactory is given", () => {
    createBullMQRunner({ redisUrl: "redis://direct" });
    expect(MockIORedis.instances).toHaveLength(1);
    const conn = MockIORedis.instances[0] as MockIORedis;
    expect(conn.url).toBe("redis://direct");
    expect(conn.opts).toEqual({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      db: 3,
      lazyConnect: true,
    });
  });

  it("does not touch IORedis when a redisFactory is supplied", () => {
    new BullMQRunner({ redisUrl: "redis://x", redisFactory: () => fakeConnection() as never });
    expect(MockIORedis.instances).toHaveLength(0);
  });
});

// ─── createQueue ────────────────────────────────────────────────────────────

describe("BullMQRunner.createQueue", () => {
  function runner() {
    return new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
  }

  it("rejects an empty queue name", () => {
    expect(() => runner().createQueue("", "cron")).toThrow(/non-empty string/);
  });

  it("rejects a non-string queue name", () => {
    expect(() => runner().createQueue(undefined as unknown as string, "cron")).toThrow(
      /non-empty string/,
    );
  });

  it("caches a queue by name: two calls with the same archetype return the same instance", () => {
    const r = runner();
    const q1 = r.createQueue("orders", "event");
    const q2 = r.createQueue("orders", "event");
    expect(q1).toBe(q2);
    expect(MockQueue.instances).toHaveLength(1);
  });

  it("rejects re-creating an existing queue under a different archetype", () => {
    const r = runner();
    r.createQueue("orders", "event");
    expect(() => r.createQueue("orders", "cron")).toThrow(
      /already created with archetype "event", refusing "cron"/,
    );
  });

  it("derives defaultJobOptions from the cron archetype policy", () => {
    const q = runner().createQueue("cron-q", "cron");
    const opts = MockQueue.instances[0]?.opts.defaultJobOptions as Record<string, unknown>;
    expect(opts).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnFail: { count: 200 },
      removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
    });
    expect((opts.meta as { timeoutMs: number; archetype: string }).archetype).toBe("cron");
    expect(q).toBe(MockQueue.instances[0]);
  });

  it("interactive archetype yields no backoff (policy.backoff is null)", () => {
    runner().createQueue("interactive-q", "interactive");
    const opts = MockQueue.instances[0]?.opts.defaultJobOptions as Record<string, unknown>;
    expect(opts.backoff).toBeUndefined();
    expect(opts.attempts).toBe(1);
  });

  it("config overrides (defaultAttempts, defaultBackoff, jobTimeoutMs) win over the archetype policy", () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
      defaultAttempts: 7,
      defaultBackoff: { type: "fixed", delay: 999 },
      jobTimeoutMs: 12_345,
    });
    r.createQueue("event-q", "event");
    const opts = MockQueue.instances[0]?.opts.defaultJobOptions as Record<string, unknown>;
    expect(opts.attempts).toBe(7);
    expect(opts.backoff).toEqual({ type: "fixed", delay: 999 });
    expect(opts.meta).toEqual({ timeoutMs: 12_345, archetype: "event" });
  });

  it("wires a DLQ listener (QueueEvents) for a normal queue", () => {
    runner().createQueue("payments", "event");
    expect(MockQueueEvents.instances.map((e) => e.name)).toContain("payments");
  });

  it("does not wire a DLQ listener for the DLQ queue itself", () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
      dlqName: "my-dlq",
    });
    r.createQueue("my-dlq", "orchestration");
    expect(MockQueueEvents.instances.map((e) => e.name)).not.toContain("my-dlq");
  });
});

// ─── createWorker ───────────────────────────────────────────────────────────

describe("BullMQRunner.createWorker", () => {
  function runner() {
    return new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
  }

  it("throws when the queue was never registered via createQueue", () => {
    const r = runner();
    expect(() => r.createWorker("ghost", async () => undefined)).toThrow(/call createQueue first/);
  });

  it("computes lockDuration equal to the archetype timeout when under the 30min cap (cron)", () => {
    const r = runner();
    r.createQueue("cron-q", "cron");
    r.createWorker("cron-q", async () => undefined);
    expect(MockWorker.instances[0]?.opts.lockDuration).toBe(10 * 60_000);
  });

  it("clamps lockDuration to 30min for an archetype whose timeout exceeds the cap (interactive)", () => {
    const r = runner();
    r.createQueue("interactive-q", "interactive");
    r.createWorker("interactive-q", async () => undefined);
    expect(MockWorker.instances[0]?.opts.lockDuration).toBe(30 * 60_000);
  });

  it("lets caller-supplied opts override the computed lockDuration", () => {
    const r = runner();
    r.createQueue("event-q", "event");
    r.createWorker("event-q", async () => undefined, { lockDuration: 999 });
    expect(MockWorker.instances[0]?.opts.lockDuration).toBe(999);
  });

  it("registers an error handler that does not throw when invoked", () => {
    const r = runner();
    r.createQueue("event-q", "event");
    r.createWorker("event-q", async () => undefined);
    const worker = MockWorker.instances[0] as MockWorker;
    const handler = worker.handlers.get("error");
    expect(handler).toBeTypeOf("function");
    expect(() => handler?.(new Error("boom"))).not.toThrow();
  });
});

// ─── flowProducer / dlqQueue ────────────────────────────────────────────────

describe("BullMQRunner.flowProducer / dlqQueue", () => {
  it("flowProducer is a lazy singleton", () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    const f1 = r.flowProducer();
    const f2 = r.flowProducer();
    expect(f1).toBe(f2);
    expect(MockFlowProducer.instances).toHaveLength(1);
  });

  it("dlqQueue is a lazy singleton registered under the orchestration archetype", () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    const d1 = r.dlqQueue();
    const d2 = r.dlqQueue();
    expect(d1).toBe(d2);
    expect(MockQueue.instances.filter((q) => q.name === "cc-dlq")).toHaveLength(1);
    // Archetype mismatch on re-use proves dlqQueue() registered "orchestration".
    expect(() => r.createQueue("cc-dlq", "cron")).toThrow(/refusing "cron"/);
  });
});

// ─── runFlowReliable ────────────────────────────────────────────────────────

describe("BullMQRunner.runFlowReliable", () => {
  function runnerWithParentQueue(name = "parent-q") {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    r.createQueue(name, "orchestration");
    const queue = MockQueue.instances.find((q) => q.name === name) as MockQueue;
    return { r, queue };
  }

  it("rejects an empty children array", async () => {
    const { r } = runnerWithParentQueue();
    await expect(r.runFlowReliable({ name: "p", queueName: "parent-q" }, [])).rejects.toThrow(
      /children must be a non-empty array/,
    );
  });

  it("rejects when the parent queue was never registered", async () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    await expect(
      r.runFlowReliable({ name: "p", queueName: "unregistered-q" }, [
        { name: "c", queueName: "child-q" },
      ]),
    ).rejects.toThrow(/parent queue "unregistered-q" not registered/);
  });

  it("builds the FlowJob with mapped children and resolves 'completed'", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    queue.jobsById.set("parent-1", new MockJob({ id: "parent-1", states: ["completed"] }));

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q", data: { a: 1 } },
      [{ name: "child", queueName: "child-q", data: { b: 2 } }],
      { pollIntervalMs: 1 },
    );

    expect(result).toEqual({
      parentStatus: "completed",
      failedChildren: [],
      parentJobId: "parent-1",
    });
    expect(flow.addCalls[0]).toMatchObject({
      name: "parent",
      queueName: "parent-q",
      data: { a: 1 },
      children: [{ name: "child", queueName: "child-q", data: { b: 2 } }],
    });
  });

  it("keeps polling while the parent job has not yet materialized", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    const job = new MockJob({ id: "parent-1", states: ["completed"] });
    let calls = 0;
    queue.getJobImpl = async () => {
      calls += 1;
      return calls === 1 ? null : job;
    };

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q" },
      [{ name: "child", queueName: "child-q" }],
      { pollIntervalMs: 1 },
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.parentStatus).toBe("completed");
  });

  it("resolves 'failed' directly when the parent job reaches state 'failed'", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    queue.jobsById.set(
      "parent-1",
      new MockJob({ id: "parent-1", states: ["failed"], depsSeq: [{ failed: ["child-a"] }] }),
    );

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q" },
      [{ name: "child", queueName: "child-q" }],
      { pollIntervalMs: 1 },
    );

    expect(result).toEqual({
      parentStatus: "failed",
      failedChildren: ["child-a"],
      parentJobId: "parent-1",
    });
  });

  it("marks the parent failed as soon as a child failure is observed mid-poll", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    const job = new MockJob({
      id: "parent-1",
      token: "tok-1",
      states: ["waiting", "waiting"],
      depsSeq: [{}, { failed: ["child-b"] }],
    });
    queue.jobsById.set("parent-1", job);

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q" },
      [{ name: "child", queueName: "child-q" }],
      { pollIntervalMs: 1 },
    );

    expect(result).toEqual({
      parentStatus: "failed",
      failedChildren: ["child-b"],
      parentJobId: "parent-1",
    });
    expect(job.moveToFailedCalls).toHaveLength(1);
    expect(job.moveToFailedCalls[0]?.error.message).toBe("child_failed:child-b");
    expect(job.moveToFailedCalls[0]?.token).toBe("tok-1");
    expect(job.moveToFailedCalls[0]?.removeChildDeps).toBe(false);
  });

  it("swallows a moveToFailed rejection during mid-poll child failure and still returns", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    const job = new MockJob({
      id: "parent-1",
      states: ["waiting"],
      depsSeq: [{ failed: ["child-c"] }],
    });
    job.moveToFailedImpl = async () => {
      throw new Error("already terminal");
    };
    queue.jobsById.set("parent-1", job);

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q" },
      [{ name: "child", queueName: "child-q" }],
      { pollIntervalMs: 1 },
    );

    expect(result.parentStatus).toBe("failed");
    expect(result.failedChildren).toEqual(["child-c"]);
  });

  it("marks the parent failed with a timeout cause when the outer deadline is hit", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    const job = new MockJob({ id: "parent-1", states: ["waiting"], depsSeq: [{}] });
    queue.jobsById.set("parent-1", job);

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q" },
      [{ name: "child", queueName: "child-q" }],
      { pollIntervalMs: 1, maxWaitMs: 5 },
    );

    expect(result).toEqual({
      parentStatus: "failed",
      failedChildren: ["timeout"],
      parentJobId: "parent-1",
    });
    expect(job.moveToFailedCalls[0]?.error.message).toBe("parent_flow_timeout");
  });

  it("hits the outer deadline gracefully when the parent job never materializes", async () => {
    const { r, queue } = runnerWithParentQueue();
    const flow = r.flowProducer() as unknown as MockFlowProducer;
    flow.addImpl = async () => ({ job: { id: "parent-1" } });
    queue.getJobImpl = async () => null;

    const result = await r.runFlowReliable(
      { name: "parent", queueName: "parent-q" },
      [{ name: "child", queueName: "child-q" }],
      { pollIntervalMs: 1, maxWaitMs: 5 },
    );

    expect(result).toEqual({
      parentStatus: "failed",
      failedChildren: ["timeout"],
      parentJobId: "parent-1",
    });
  });
});

// ─── queueRetryFn ───────────────────────────────────────────────────────────

describe("BullMQRunner.queueRetryFn", () => {
  it("registers the queue under the 'event' archetype and adds a 'retry' job", async () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    const retry = r.queueRetryFn<{ n: number }>("retries");
    const id = await retry({ n: 1 });

    const queue = MockQueue.instances.find((q) => q.name === "retries") as MockQueue;
    expect(queue.addCalls[0]).toMatchObject({ name: "retry", data: { n: 1 } });
    expect(id).toBe(queue.jobsById.get(id)?.id);
    // Same queue is reused (archetype mismatch would throw otherwise).
    expect(() => r.createQueue("retries", "cron")).toThrow(/refusing "cron"/);
  });

  it("falls back to an empty string when the added job carries no id", async () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    const retry = r.queueRetryFn("no-id-q");
    const queue = MockQueue.instances.find((q) => q.name === "no-id-q") as MockQueue;
    queue.addImpl = async () => new MockJob({ id: undefined });

    const id = await retry({ any: true });
    expect(id).toBe("");
  });
});

// ─── close ──────────────────────────────────────────────────────────────────

describe("BullMQRunner.close", () => {
  it("closes every worker, queue, QueueEvents, and the flow producer", async () => {
    const conn = fakeConnection();
    const r = new BullMQRunner({ redisUrl: "redis://x", redisFactory: () => conn as never });
    r.createQueue("q1", "event");
    r.createWorker("q1", async () => undefined);
    r.flowProducer();

    await r.close();

    expect(MockQueue.instances[0]?.closeCalls).toBe(1);
    expect(MockWorker.instances[0]?.closeCalls).toBe(1);
    expect(MockQueueEvents.instances[0]?.closeCalls).toBe(1);
    expect(MockFlowProducer.instances[0]?.closeCalls).toBe(1);
    expect(conn.quit).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second close() does not re-close anything", async () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    r.createQueue("q1", "event");
    await r.close();
    const closesAfterFirst = MockQueue.instances[0]?.closeCalls;

    await r.close();

    expect(MockQueue.instances[0]?.closeCalls).toBe(closesAfterFirst);
  });

  it("swallows a rejecting connection.quit() instead of throwing", async () => {
    const conn = fakeConnection({ quit: vi.fn().mockRejectedValue(new Error("quit failed")) });
    const r = new BullMQRunner({ redisUrl: "redis://x", redisFactory: () => conn as never });

    await expect(r.close()).resolves.toBeUndefined();
  });

  it("does not attempt to close a flow producer that was never created", async () => {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    await expect(r.close()).resolves.toBeUndefined();
    expect(MockFlowProducer.instances).toHaveLength(0);
  });
});

// ─── DLQ routing (attachDlqListener + moveToDlq) ───────────────────────────

describe("BullMQRunner DLQ routing", () => {
  function setupQueueWithFailedHandler(archetype: "event" | "cron" = "event") {
    const r = new BullMQRunner({
      redisUrl: "redis://x",
      redisFactory: () => fakeConnection() as never,
    });
    r.createQueue("q1", archetype);
    const queue = MockQueue.instances.find((q) => q.name === "q1") as MockQueue;
    const events = MockQueueEvents.instances.find((e) => e.name === "q1") as MockQueueEvents;
    const onFailed = events.handlers.get("failed") as (args: {
      jobId: string;
      failedReason?: string;
    }) => Promise<void>;
    return { r, queue, onFailed };
  }

  // dlqQueue() is a lazy singleton: calling it again never creates a new
  // Queue, it just returns the same (mocked) instance.
  function dlqQueue(r: InstanceType<typeof BullMQRunner>): MockQueue {
    return r.dlqQueue() as unknown as MockQueue;
  }

  it("routes an exhausted-attempts failure to the DLQ with the expected payload", async () => {
    const { r, queue, onFailed } = setupQueueWithFailedHandler("event"); // policy.attempts = 5
    queue.jobsById.set("job-x", new MockJob({ id: "job-x", attemptsMade: 5, opts: {} }));

    await onFailed({ jobId: "job-x", failedReason: "boom" });

    const dlq = dlqQueue(r);
    expect(dlq.addCalls).toHaveLength(1);
    expect(dlq.addCalls[0]?.name).toBe("dlq-entry");
    expect(dlq.addCalls[0]?.data).toMatchObject({
      originalQueue: "q1",
      jobId: "job-x",
      failureReason: "boom",
      attemptsMade: 5,
    });
    expect((dlq.addCalls[0]?.data as { movedAt: string }).movedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(dlq.addCalls[0]?.opts).toEqual({
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(lastSpan.setStatus).toHaveBeenCalledWith({ code: "ERROR", message: "boom" });
    expect(lastSpan.end).toHaveBeenCalledTimes(1);
  });

  it("honors the job's own opts.attempts over the archetype policy default", async () => {
    const { r, queue, onFailed } = setupQueueWithFailedHandler("event");
    queue.jobsById.set(
      "job-y",
      new MockJob({ id: "job-y", attemptsMade: 2, opts: { attempts: 2 } }),
    );

    await onFailed({ jobId: "job-y", failedReason: "boom" });

    expect(dlqQueue(r).addCalls).toHaveLength(1);
  });

  it("routes to the DLQ on a timeout-shaped failure reason even with attempts remaining", async () => {
    const { r, queue, onFailed } = setupQueueWithFailedHandler("event");
    queue.jobsById.set("job-z", new MockJob({ id: "job-z", attemptsMade: 1, opts: {} }));

    await onFailed({ jobId: "job-z", failedReason: "Operation timed out" });

    expect(dlqQueue(r).addCalls).toHaveLength(1);
  });

  it("routes to the DLQ when processedOn age exceeds the archetype timeout", async () => {
    const { r, queue, onFailed } = setupQueueWithFailedHandler("event"); // 2min timeout
    queue.jobsById.set(
      "job-w",
      new MockJob({
        id: "job-w",
        attemptsMade: 1,
        opts: {},
        processedOn: Date.now() - (2 * 60_000 + 5_000),
      }),
    );

    await onFailed({ jobId: "job-w", failedReason: "generic error" });

    expect(dlqQueue(r).addCalls).toHaveLength(1);
  });

  it("does not route to the DLQ when attempts remain and the failure is not a timeout", async () => {
    const { r, queue, onFailed } = setupQueueWithFailedHandler("event");
    queue.jobsById.set("job-v", new MockJob({ id: "job-v", attemptsMade: 1, opts: {} }));

    await onFailed({ jobId: "job-v", failedReason: "transient error" });

    expect(dlqQueue(r).addCalls).toHaveLength(0);
  });

  it("is a no-op when the job cannot be found", async () => {
    const { queue, onFailed } = setupQueueWithFailedHandler("event");
    queue.getJobImpl = async () => null;

    await expect(onFailed({ jobId: "missing", failedReason: "boom" })).resolves.toBeUndefined();
  });

  it("catches an error thrown while looking up the job instead of propagating it", async () => {
    const { queue, onFailed } = setupQueueWithFailedHandler("event");
    queue.getJobImpl = async () => {
      throw new Error("redis down");
    };

    await expect(onFailed({ jobId: "job-x", failedReason: "boom" })).resolves.toBeUndefined();
  });
});
