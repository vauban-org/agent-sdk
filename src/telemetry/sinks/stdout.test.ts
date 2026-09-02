/**
 * stdoutTelemetrySink — JSON emission tests.
 *
 * Ref: command-center:sprint-693:sink-stdout
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { stdoutTelemetrySink } from "./stdout.js";

function collectingStream(): {
  stream: Writable;
  lines: () => string[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0),
  };
}

const RUN_START = {
  runId: "run-1",
  agentId: "a",
  agentVersion: "1.0.0",
  model: "test",
  provider: "test",
  startedAt: "2026-05-16T17:00:00.000Z",
};

describe("stdoutTelemetrySink", () => {
  it("emits one JSON line per event", async () => {
    const { stream, lines } = collectingStream();
    const sink = stdoutTelemetrySink({ stream });

    await sink.start(RUN_START);
    await sink.step("run-1", {
      stepIndex: 0,
      kind: "observe",
      status: "completed",
      inputTokens: 5,
      outputTokens: 10,
      costUsd: 0,
    });
    await sink.finish("run-1", {
      status: "success",
      finishedAt: "2026-05-16T17:00:01.000Z",
    });

    const out = lines();
    expect(out).toHaveLength(3);
    expect(JSON.parse(out[0]!)).toMatchObject({
      telemetry: "run.start",
      runId: "run-1",
      agentId: "a",
    });
    expect(JSON.parse(out[1]!)).toMatchObject({
      telemetry: "run.step",
      runId: "run-1",
      kind: "observe",
    });
    expect(JSON.parse(out[2]!)).toMatchObject({
      telemetry: "run.finish",
      runId: "run-1",
      status: "success",
    });
  });

  it("emits key=value when json=false", async () => {
    const { stream, lines } = collectingStream();
    const sink = stdoutTelemetrySink({ stream, json: false });
    await sink.start(RUN_START);
    expect(lines()[0]).toContain('runId="run-1"');
    expect(lines()[0]).toContain('agentId="a"');
  });

  it("emits a JSON shape compatible with `jq`", async () => {
    const { stream, lines } = collectingStream();
    const sink = stdoutTelemetrySink({ stream });
    await sink.start(RUN_START);
    const parsed = JSON.parse(lines()[0]!);
    // jq-friendly: top-level keys are sortable strings, no nested undefined
    expect(parsed).toHaveProperty("telemetry");
    expect(parsed).toHaveProperty("runId");
    expect(parsed).toHaveProperty("startedAt");
  });

  it("has name 'stdout'", () => {
    const sink = stdoutTelemetrySink();
    expect(sink.name).toBe("stdout");
  });

  it("defaults to stderr when no stream given", () => {
    // Just verify constructor doesn't throw; can't capture global stderr in jsdom.
    const sink = stdoutTelemetrySink();
    expect(typeof sink.start).toBe("function");
  });
});
