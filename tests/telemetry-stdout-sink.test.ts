/**
 * Tests for src/telemetry/sinks/stdout.ts — stdoutTelemetrySink
 *
 * Coverage:
 *   stdoutTelemetrySink — name is 'stdout',
 *     start() writes JSON line with telemetry:'run.start' and event fields,
 *     step() writes JSON line with telemetry:'run.step' and runId,
 *     finish() writes JSON line with telemetry:'run.finish' and runId,
 *     json:false emits key=value format instead of JSON,
 *     each line ends with newline,
 *     injectable stream receives all writes
 *
 * Ref: test coverage for src/telemetry/sinks/stdout.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { stdoutTelemetrySink } from "../src/telemetry/sinks/stdout.js";

function makeStream() {
  const lines: string[] = [];
  return {
    write: vi.fn((s: string) => {
      lines.push(s);
      return true;
    }),
    lines,
  };
}

const START_EVENT = {
  runId: "run-1",
  agentId: "TESTER",
  agentVersion: "1.0.0",
  model: "qwen3-8b",
  provider: "litellm",
  startedAt: "2026-01-01T00:00:00Z",
};

const STEP_DELTA = {
  stepIndex: 0,
  kind: "decide",
  status: "completed" as const,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0,
};

const FINISH_EVENT = {
  status: "success" as const,
  finishedAt: "2026-01-01T00:01:00Z",
};

// ─── name ─────────────────────────────────────────────────────────────────────

describe("stdoutTelemetrySink.name", () => {
  it("is 'stdout'", () => {
    const sink = stdoutTelemetrySink();
    expect(sink.name).toBe("stdout");
  });
});

// ─── start ────────────────────────────────────────────────────────────────────

describe("stdoutTelemetrySink.start", () => {
  it("writes a line with telemetry:'run.start'", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never });
    await sink.start(START_EVENT);
    expect(stream.lines).toHaveLength(1);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.telemetry).toBe("run.start");
  });

  it("includes runId and agentId in emitted line", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never });
    await sink.start(START_EVENT);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.agentId).toBe("TESTER");
  });

  it("line ends with newline", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never });
    await sink.start(START_EVENT);
    expect(stream.lines[0].endsWith("\n")).toBe(true);
  });
});

// ─── step ─────────────────────────────────────────────────────────────────────

describe("stdoutTelemetrySink.step", () => {
  it("writes a line with telemetry:'run.step' and runId", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never });
    await sink.step("run-1", STEP_DELTA);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.telemetry).toBe("run.step");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.kind).toBe("decide");
  });
});

// ─── finish ───────────────────────────────────────────────────────────────────

describe("stdoutTelemetrySink.finish", () => {
  it("writes a line with telemetry:'run.finish' and status", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never });
    await sink.finish("run-1", FINISH_EVENT);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.telemetry).toBe("run.finish");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.status).toBe("success");
  });
});

// ─── key=value format ─────────────────────────────────────────────────────────

describe("stdoutTelemetrySink — json:false (key=value format)", () => {
  it("emits key=value pairs when json:false", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never, json: false });
    await sink.start(START_EVENT);
    expect(stream.lines[0]).toContain('telemetry="run.start"');
    expect(stream.lines[0]).toContain('runId="run-1"');
    // Should not be valid JSON
    expect(() => JSON.parse(stream.lines[0])).toThrow();
  });
});

// ─── multiple events ──────────────────────────────────────────────────────────

describe("stdoutTelemetrySink — multiple events", () => {
  it("emits one line per event", async () => {
    const stream = makeStream();
    const sink = stdoutTelemetrySink({ stream: stream as never });
    await sink.start(START_EVENT);
    await sink.step("run-1", STEP_DELTA);
    await sink.finish("run-1", FINISH_EVENT);
    expect(stream.lines).toHaveLength(3);
  });
});
