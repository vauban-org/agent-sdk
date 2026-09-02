/**
 * TelemetryBus — fanout, isolation, backpressure tests.
 *
 * Ref: command-center:sprint-693:telemetry-bus
 */

import { describe, expect, it, vi } from "vitest";

import { createTelemetryBus } from "./bus.js";
import type { TelemetrySink } from "./port.js";

function makeSink(name: string, behavior: "ok" | "throw" = "ok"): TelemetrySink {
  const calls = { start: 0, step: 0, finish: 0 };
  return {
    name,
    async start() {
      calls.start += 1;
      if (behavior === "throw") throw new Error(`${name}.start failed`);
    },
    async step() {
      calls.step += 1;
      if (behavior === "throw") throw new Error(`${name}.step failed`);
    },
    async finish() {
      calls.finish += 1;
      if (behavior === "throw") throw new Error(`${name}.finish failed`);
    },
    // expose counters via name munging — vitest reads `(sink as any).calls`
    // @ts-expect-error — test affordance
    calls,
  };
}

const RUN_START = {
  runId: "11111111-1111-1111-1111-111111111111",
  agentId: "agent-x",
  agentVersion: "1.0.0",
  model: "test",
  provider: "test",
  startedAt: "2026-05-16T17:00:00.000Z",
};

const STEP_DELTA = {
  stepIndex: 0,
  kind: "observe",
  status: "completed" as const,
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.001,
};

const FINISH = {
  status: "success" as const,
  finishedAt: "2026-05-16T17:00:05.000Z",
};

describe("createTelemetryBus", () => {
  it("returns a NOOP sink when sinks=[]", async () => {
    const bus = createTelemetryBus({ sinks: [] });
    expect(bus.name).toBe("noop");
    await expect(bus.start(RUN_START)).resolves.toBeUndefined();
    expect(bus.counters.dispatched).toBe(0);
  });

  it("fans out start/step/finish to every sink (blocking mode)", async () => {
    const a = makeSink("a");
    const b = makeSink("b");
    const bus = createTelemetryBus({
      sinks: [a, b],
      nonBlocking: false,
    });

    await bus.start(RUN_START);
    await bus.step(RUN_START.runId, STEP_DELTA);
    await bus.finish(RUN_START.runId, FINISH);

    // @ts-expect-error — test affordance
    expect(a.calls).toEqual({ start: 1, step: 1, finish: 1 });
    // @ts-expect-error — test affordance
    expect(b.calls).toEqual({ start: 1, step: 1, finish: 1 });
    expect(bus.counters.dispatched).toBe(6); // 3 events × 2 sinks
    expect(bus.counters.sinkErrors).toBe(0);
  });

  it("isolates failures — one sink throwing does not affect others", async () => {
    const good = makeSink("good");
    const bad = makeSink("bad", "throw");
    const warn = vi.fn();
    const bus = createTelemetryBus({
      sinks: [good, bad],
      logger: { warn, error: () => {} },
      nonBlocking: false,
    });

    await bus.start(RUN_START);
    await bus.step(RUN_START.runId, STEP_DELTA);
    await bus.finish(RUN_START.runId, FINISH);

    // @ts-expect-error
    expect(good.calls).toEqual({ start: 1, step: 1, finish: 1 });
    // @ts-expect-error
    expect(bad.calls).toEqual({ start: 1, step: 1, finish: 1 });
    expect(bus.counters.sinkErrors).toBe(3);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]![1]).toMatch(/isolated/);
  });

  it("backpressure: drops oldest events when queue exceeds maxQueueDepth", async () => {
    // Pending-resolver sink — caller controls when each call resolves.
    const pending: Array<() => void> = [];
    const blockingSink: TelemetrySink = {
      name: "slow",
      async start() {
        await new Promise<void>((res) => {
          pending.push(res);
        });
      },
      async step() {},
      async finish() {},
    };
    const warn = vi.fn();
    const bus = createTelemetryBus({
      sinks: [blockingSink],
      logger: { warn, error: () => {} },
      nonBlocking: true,
      maxQueueDepth: 3,
    });

    // Enqueue 6 starts — 1 enters dispatch and blocks; the next 3 fill the
    // queue; the 5th and 6th cause overflow (drop oldest).
    for (let i = 0; i < 6; i++) {
      await bus.start({ ...RUN_START, runId: `run-${i}` });
    }
    expect(bus.counters.dropped).toBeGreaterThanOrEqual(1);

    // Release all pending dispatches so flush() resolves.
    while (pending.length > 0 || bus.counters.dispatched < 4) {
      const r = pending.shift();
      r?.();
      await new Promise((res) => setTimeout(res, 0));
    }
    await bus.flush();
  }, 10_000);

  it("non-blocking mode returns immediately", async () => {
    let resolveSink: (() => void) | undefined;
    const sink: TelemetrySink = {
      name: "slow",
      async start() {
        await new Promise<void>((res) => {
          resolveSink = res;
        });
      },
      async step() {},
      async finish() {},
    };
    const bus = createTelemetryBus({ sinks: [sink], nonBlocking: true });

    const t0 = Date.now();
    await bus.start(RUN_START); // should return immediately
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(bus.counters.dispatched).toBe(0); // not dispatched yet

    resolveSink?.();
    await bus.flush();
  });

  it("flush awaits in-flight dispatches", async () => {
    const sink = makeSink("a");
    const bus = createTelemetryBus({ sinks: [sink], nonBlocking: true });

    await bus.start(RUN_START);
    await bus.step(RUN_START.runId, STEP_DELTA);
    await bus.finish(RUN_START.runId, FINISH);
    await bus.flush();

    // @ts-expect-error
    expect(sink.calls).toEqual({ start: 1, step: 1, finish: 1 });
    expect(bus.counters.dispatched).toBe(3);
  });

  it("preserves FIFO order per sink", async () => {
    const events: string[] = [];
    const sink: TelemetrySink = {
      name: "ordered",
      async start(e) {
        events.push(`start:${e.runId}`);
      },
      async step(runId, d) {
        events.push(`step:${runId}:${d.stepIndex}`);
      },
      async finish(runId) {
        events.push(`finish:${runId}`);
      },
    };
    const bus = createTelemetryBus({ sinks: [sink], nonBlocking: true });

    await bus.start(RUN_START);
    await bus.step(RUN_START.runId, { ...STEP_DELTA, stepIndex: 0 });
    await bus.step(RUN_START.runId, { ...STEP_DELTA, stepIndex: 1 });
    await bus.finish(RUN_START.runId, FINISH);
    await bus.flush();

    expect(events).toEqual([
      `start:${RUN_START.runId}`,
      `step:${RUN_START.runId}:0`,
      `step:${RUN_START.runId}:1`,
      `finish:${RUN_START.runId}`,
    ]);
  });

  it("counts dispatched accurately under mixed success/failure", async () => {
    const good = makeSink("good");
    const bad = makeSink("bad", "throw");
    const bus = createTelemetryBus({
      sinks: [good, bad],
      nonBlocking: false,
      logger: { warn: () => {}, error: () => {} },
    });

    await bus.start(RUN_START);
    await bus.finish(RUN_START.runId, FINISH);

    expect(bus.counters.dispatched).toBe(2); // good's 2 events
    expect(bus.counters.sinkErrors).toBe(2); // bad's 2 events
  });
});
