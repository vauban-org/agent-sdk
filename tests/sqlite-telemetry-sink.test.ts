/**
 * Tests for src/telemetry/sinks/sqlite.ts — sink lifecycle behavior
 *
 * Coverage:
 *   localSqliteTelemetrySink — returns a TelemetrySink (real or degraded),
 *     sink name contains path or 'degraded',
 *     start/step/finish resolve without throwing (correct 2-arg interface)
 *
 * Ref: test coverage for src/telemetry/sinks/sqlite.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { localSqliteTelemetrySink } from "../src/telemetry/sinks/sqlite.js";

// The sink may be real (if better-sqlite3 is hoisted by workspace) or degraded
// (optional peer dep absent). Both must satisfy the TelemetrySink contract.

describe("localSqliteTelemetrySink — degraded mode (no better-sqlite3)", () => {
  it("returns a TelemetrySink with a name", () => {
    const sink = localSqliteTelemetrySink({ path: "/tmp/test-sink.db" });
    expect(typeof sink.name).toBe("string");
    expect(sink.name.length).toBeGreaterThan(0);
  });

  it("name contains path or 'degraded'", () => {
    const sink = localSqliteTelemetrySink({ path: "/tmp/test-agent.db" });
    // Either it's a real sqlite sink name or the degraded one — both contain the path or 'degraded'
    expect(sink.name).toMatch(/sqlite|degraded|test-agent/i);
  });

  it("start() resolves without throwing", async () => {
    const sink = localSqliteTelemetrySink({ path: ":memory:" });
    await expect(
      sink.start({
        runId: "r-1",
        agentId: "test",
        agentVersion: "1.0.0",
        model: "gpt-4",
        provider: "openai",
        tenantId: null,
        traceId: null,
        startedAt: new Date().toISOString(),
      }),
    ).resolves.not.toThrow();
  });

  it("step() resolves without throwing", async () => {
    const sink = localSqliteTelemetrySink({ path: ":memory:" });
    // start must be called first so the run row exists for FK check
    await sink.start({
      runId: "r-1",
      agentId: "test",
      agentVersion: "1.0.0",
      model: "gpt-4",
      provider: "openai",
      tenantId: null,
      traceId: null,
      startedAt: new Date().toISOString(),
    });
    // TelemetrySink.step(runId: string, delta: TelemetryRunStep)
    await expect(
      sink.step("r-1", {
        stepIndex: 0,
        kind: "orient",
        status: "success",
        inputTokens: 100,
        outputTokens: 50,
        toolCalls: 0,
        costUsd: 0.001,
        durationMs: 200,
        metadata: null,
      }),
    ).resolves.not.toThrow();
  });

  it("finish() resolves without throwing", async () => {
    const sink = localSqliteTelemetrySink({ path: ":memory:" });
    await sink.start({
      runId: "r-1",
      agentId: "test",
      agentVersion: "1.0.0",
      model: "gpt-4",
      provider: "openai",
      tenantId: null,
      traceId: null,
      startedAt: new Date().toISOString(),
    });
    // TelemetrySink.finish(runId: string, event: TelemetryRunFinish)
    await expect(
      sink.finish("r-1", {
        status: "success",
        stopReason: null,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCostUsd: 0.001,
        finishedAt: new Date().toISOString(),
      }),
    ).resolves.not.toThrow();
  });
});
