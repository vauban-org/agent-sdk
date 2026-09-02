/**
 * Tests for packages/agent-sdk/src/telemetry/sinks/stdout.ts
 *
 * Coverage:
 *   stdoutTelemetrySink — JSON mode (default): start/step/finish emit JSON lines,
 *     key=value mode: emits key=value pairs,
 *     each line ends with \n,
 *     writes to injected stream (not process.stderr)
 *
 * Ref: test coverage for agent-sdk/telemetry/sinks/stdout.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { stdoutTelemetrySink } from "../src/telemetry/sinks/stdout.js";

function makeStream() {
  const lines: string[] = [];
  const stream = {
    write: vi.fn((s: string) => {
      lines.push(s);
    }),
  } as unknown as NodeJS.WritableStream;
  return { stream, lines };
}

describe("stdoutTelemetrySink", () => {
  it("name is 'stdout'", () => {
    const sink = stdoutTelemetrySink();
    expect(sink.name).toBe("stdout");
  });

  it("start emits JSON line with telemetry=run.start", async () => {
    const { stream, lines } = makeStream();
    const sink = stdoutTelemetrySink({ stream, json: true });
    await sink.start({
      runId: "run-1",
      agentId: "forge",
      startedAt: "2026-01-01",
    } as never);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.telemetry).toBe("run.start");
    expect(parsed.runId).toBe("run-1");
    expect(lines[0].endsWith("\n")).toBe(true);
  });

  it("step emits JSON line with telemetry=run.step and runId", async () => {
    const { stream, lines } = makeStream();
    const sink = stdoutTelemetrySink({ stream, json: true });
    await sink.step("run-1", {
      type: "tool_call",
      toolName: "brain.query",
    } as never);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.telemetry).toBe("run.step");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.toolName).toBe("brain.query");
  });

  it("finish emits JSON line with telemetry=run.finish and runId", async () => {
    const { stream, lines } = makeStream();
    const sink = stdoutTelemetrySink({ stream, json: true });
    await sink.finish("run-1", { status: "completed", steps: 5 } as never);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.telemetry).toBe("run.finish");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.status).toBe("completed");
  });

  it("key=value mode emits k=v pairs instead of JSON", async () => {
    const { stream, lines } = makeStream();
    const sink = stdoutTelemetrySink({ stream, json: false });
    await sink.start({ runId: "run-1", agentId: "forge" } as never);
    expect(lines[0]).toContain("telemetry=");
    expect(lines[0]).toContain("runId=");
    // Should not be parseable as JSON
    expect(() => JSON.parse(lines[0])).toThrow();
  });

  it("does not write to process.stderr when custom stream injected", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stream } = makeStream();
    const sink = stdoutTelemetrySink({ stream });
    await sink.start({ runId: "r", agentId: "a" } as never);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});
