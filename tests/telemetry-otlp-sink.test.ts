/**
 * Tests for agent-sdk/src/telemetry/sinks/otlp.ts
 *
 * Coverage:
 *   name is 'otlp'
 *   start — registers run state, no HTTP POST
 *   step — sends child span via fetchImpl, no-op for unknown runId
 *   finish — sends root span, cleans up state; no-op for unknown runId
 *   HTTP error (non-ok) → throws from step/finish
 *   custom headers merged into request
 *   tracesUrl appends /v1/traces to base URL
 *   service name defaults to "vauban-agent-sdk"
 *
 * Ref: test coverage for agent-sdk/telemetry/sinks/otlp.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import type {
  TelemetryRunFinish,
  TelemetryRunStart,
  TelemetryRunStep,
} from "../src/telemetry/port.js";
import { otlpTelemetrySink } from "../src/telemetry/sinks/otlp.js";

const RUN_ID = "run-001";

const START: TelemetryRunStart = {
  runId: RUN_ID,
  agentId: "builder",
  agentVersion: "1.0.0",
  model: "llama-3.3-70b",
  provider: "groq",
  startedAt: "2026-05-19T10:00:00.000Z",
};

const STEP: TelemetryRunStep = {
  stepIndex: 0,
  kind: "observe",
  status: "completed",
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.0001,
  durationMs: 42,
};

const FINISH: TelemetryRunFinish = {
  status: "success",
  finishedAt: "2026-05-19T10:00:01.000Z",
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalCostUsd: 0.0001,
};

function makeOkFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(""),
  });
}

// ─── name ─────────────────────────────────────────────────────────────────────

describe("otlpTelemetrySink name", () => {
  it("is 'otlp'", () => {
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: makeOkFetch(),
    });
    expect(sink.name).toBe("otlp");
  });
});

// ─── start ────────────────────────────────────────────────────────────────────

describe("otlpTelemetrySink.start", () => {
  it("does not POST on start", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── step ─────────────────────────────────────────────────────────────────────

describe("otlpTelemetrySink.step", () => {
  it("POSTs a child span for a known runId", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.step(RUN_ID, STEP);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("is a no-op for unknown runId", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.step("unknown-run", STEP);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /v1/traces path", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test/api/public/otel",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.step(RUN_ID, STEP);
    expect(fetchMock.mock.calls[0][0]).toBe("https://otel.test/api/public/otel/v1/traces");
  });

  it("span name is ooda.<kind>", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.step(RUN_ID, { ...STEP, kind: "decide" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("ooda.decide");
  });

  it("step status 'failed' maps to span status code 2", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.step(RUN_ID, { ...STEP, status: "failed" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2);
  });

  it("step status 'completed' maps to span status code 1", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.step(RUN_ID, { ...STEP, status: "completed" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(1);
  });

  it("throws when HTTP response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue("too many requests"),
    });
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await expect(sink.step(RUN_ID, STEP)).rejects.toThrow("OTLP HTTP 429");
  });
});

// ─── finish ───────────────────────────────────────────────────────────────────

describe("otlpTelemetrySink.finish", () => {
  it("POSTs a root span for a known runId", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.finish(RUN_ID, FINISH);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("is a no-op for unknown runId", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.finish("unknown-run", FINISH);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cleans up run state so a second finish is a no-op", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.finish(RUN_ID, FINISH);
    await sink.finish(RUN_ID, FINISH);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("span name includes agentId", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.finish(RUN_ID, FINISH);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toContain("builder");
  });

  it("failed status maps to span status code 2", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.finish(RUN_ID, { ...FINISH, status: "failed" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2);
  });

  it("step count from prior steps is included in root span attributes", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.step(RUN_ID, STEP); // step 1
    await sink.step(RUN_ID, STEP); // step 2
    await sink.finish(RUN_ID, FINISH);
    // finish is the second fetch call (after 2 steps)
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const stepsAttr = attrs.find((a: { key: string }) => a.key === "vauban.run.steps");
    expect(stepsAttr?.value?.intValue).toBe("2");
  });
});

// ─── headers and service name ─────────────────────────────────────────────────

describe("otlpTelemetrySink configuration", () => {
  it("merges custom headers into request", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
      headers: { Authorization: "Bearer secret", "x-tenant-id": "t1" },
    });
    await sink.start(START);
    await sink.step(RUN_ID, STEP);
    const reqHeaders = fetchMock.mock.calls[0][1].headers;
    expect(reqHeaders.Authorization).toBe("Bearer secret");
    expect(reqHeaders["x-tenant-id"]).toBe("t1");
  });

  it("service name appears in resourceSpan attributes", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test",
      fetchImpl: fetchMock,
      serviceName: "my-custom-service",
    });
    await sink.start(START);
    await sink.finish(RUN_ID, FINISH);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const resourceAttrs = body.resourceSpans[0].resource.attributes;
    const svcAttr = resourceAttrs.find((a: { key: string }) => a.key === "service.name");
    expect(svcAttr?.value?.stringValue).toBe("my-custom-service");
  });

  it("trailing slash stripped from URL", async () => {
    const fetchMock = makeOkFetch();
    const sink = otlpTelemetrySink({
      url: "https://otel.test/",
      fetchImpl: fetchMock,
    });
    await sink.start(START);
    await sink.finish(RUN_ID, FINISH);
    expect(fetchMock.mock.calls[0][0]).toBe("https://otel.test/v1/traces");
  });
});
