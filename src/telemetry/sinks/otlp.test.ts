/**
 * otlpTelemetrySink — payload shape + fetch mocking tests.
 *
 * Ref: command-center:sprint-693:sink-otlp
 */

import { describe, expect, it, vi } from "vitest";

import { otlpTelemetrySink } from "./otlp.js";

const RUN_START = {
  runId: "11111111-1111-1111-1111-111111111111",
  agentId: "agent-x",
  agentVersion: "1.0.0",
  model: "groq-llama-3.3-70b",
  provider: "groq",
  startedAt: "2026-05-16T17:00:00.000Z",
};

describe("otlpTelemetrySink", () => {
  it("posts to {url}/v1/traces on finish", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const sink = otlpTelemetrySink({
      url: "https://collector.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await sink.start(RUN_START);
    await sink.finish(RUN_START.runId, {
      status: "success",
      finishedAt: "2026-05-16T17:00:05.000Z",
    });

    // start should NOT post — only finish does (start collected, finish emits).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://collector.example.com/v1/traces");
    expect((init as { method: string }).method).toBe("POST");

    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.resourceSpans).toHaveLength(1);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toContain("ooda.cycle");
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("posts a child span per step", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const sink = otlpTelemetrySink({
      url: "https://collector.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await sink.start(RUN_START);
    await sink.step(RUN_START.runId, {
      stepIndex: 0,
      kind: "observe",
      status: "completed",
      inputTokens: 5,
      outputTokens: 10,
      costUsd: 0,
    });
    await sink.finish(RUN_START.runId, {
      status: "success",
      finishedAt: "2026-05-16T17:00:05.000Z",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2); // step + finish
    const stepBody = JSON.parse(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string,
    );
    const stepSpan = stepBody.resourceSpans[0].scopeSpans[0].spans[0];
    expect(stepSpan.name).toBe("ooda.observe");
    expect(stepSpan.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("includes static headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const sink = otlpTelemetrySink({
      url: "https://collector.example.com",
      headers: { Authorization: "Bearer secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sink.start(RUN_START);
    await sink.finish(RUN_START.runId, {
      status: "success",
      finishedAt: "2026-05-16T17:00:05.000Z",
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("rejects when receiver returns non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 500 }));
    const sink = otlpTelemetrySink({
      url: "https://collector.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sink.start(RUN_START);
    await expect(
      sink.finish(RUN_START.runId, {
        status: "success",
        finishedAt: "2026-05-16T17:00:05.000Z",
      }),
    ).rejects.toThrow(/OTLP HTTP 500/);
  });

  it("preserves the caller-provided trace id", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const traceId = "abcdef1234567890abcdef1234567890";
    const sink = otlpTelemetrySink({
      url: "https://collector.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sink.start({ ...RUN_START, traceId });
    await sink.finish(RUN_START.runId, {
      status: "success",
      finishedAt: "2026-05-16T17:00:05.000Z",
    });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string,
    );
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(traceId);
  });

  it("status code maps failed → ERROR(2)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const sink = otlpTelemetrySink({
      url: "https://c.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sink.start(RUN_START);
    await sink.finish(RUN_START.runId, {
      status: "failed",
      errorMessage: "boom",
      finishedAt: "2026-05-16T17:00:05.000Z",
    });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string,
    );
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
  });
});
