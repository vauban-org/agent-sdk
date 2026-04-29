/**
 * subscribeToRun — SSE client tests.
 *
 * Mocks global fetch to return an SSE-formatted ReadableStream.
 * Sprint: command-center:sprint-523:quick-6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { subscribeToRun } from "../src/runs/subscribe.js";
import type { RunStep } from "../src/runs/types.js";

// ─── SSE stream builder ───────────────────────────────────────────────────────

function makeSseEvent(
  name: string,
  data: unknown,
  id?: string,
): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `event: ${name}\n${idLine}data: ${JSON.stringify(data)}\n\n`;
}

function buildSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: `step-${Math.random().toString(36).slice(2)}`,
    run_id: "run-abc123",
    step_index: 0,
    type: "execution",
    status: "done",
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("subscribeToRun", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onStep 3 times for step_existing events, then onComplete for run_complete", async () => {
    const steps = [makeRunStep({ id: "s1" }), makeRunStep({ id: "s2" }), makeRunStep({ id: "s3" })];
    const chunks = [
      makeSseEvent("step_existing", steps[0], "s1"),
      makeSseEvent("step_existing", steps[1], "s2"),
      makeSseEvent("step_existing", steps[2], "s3"),
      makeSseEvent("run_complete", { status: "succeeded", duration_ms: 1200 }),
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: buildSseStream(chunks),
    });
    vi.stubGlobal("fetch", mockFetch);

    const receivedSteps: RunStep[] = [];
    let completedData: { status: string; duration_ms?: number } | null = null;

    const handle = await subscribeToRun("run-abc123", {
      baseUrl: "http://localhost:8080",
      onStep: (step) => receivedSteps.push(step),
      onComplete: (data) => { completedData = data; },
    });

    // Wait for the async stream loop to process.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    handle.close();

    expect(receivedSteps).toHaveLength(3);
    expect(receivedSteps[0]?.id).toBe("s1");
    expect(receivedSteps[1]?.id).toBe("s2");
    expect(receivedSteps[2]?.id).toBe("s3");
    expect(completedData).toEqual({ status: "succeeded", duration_ms: 1200 });
  });

  it("forwards Last-Event-ID header on initial call when lastEventId is set", async () => {
    const step = makeRunStep({ id: "step-xyz" });
    const chunks = [
      makeSseEvent("run_complete", { status: "succeeded" }),
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: buildSseStream(chunks),
    });
    vi.stubGlobal("fetch", mockFetch);

    const handle = await subscribeToRun("run-def456", {
      baseUrl: "http://localhost:8080",
      lastEventId: step.id,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    handle.close();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, callOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callOpts.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe(step.id);
  });

  it("aborts stream immediately when signal is aborted before open", async () => {
    const mockFetch = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(resolve, 5_000)),
    );
    vi.stubGlobal("fetch", mockFetch);

    const ac = new AbortController();
    ac.abort();

    const handle = await subscribeToRun("run-ghi789", {
      baseUrl: "http://localhost:8080",
      signal: ac.signal,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    handle.close();

    // When signal is already aborted, the loop exits before calling fetch.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls close() to stop stream mid-flight", async () => {
    // An infinite stream (never closes) — close() should abort it.
    let enqueueFn: ((chunk: Uint8Array) => void) | null = null;
    const encoder = new TextEncoder();
    const infiniteStream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueueFn = (c) => controller.enqueue(c);
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: infiniteStream,
    });
    vi.stubGlobal("fetch", mockFetch);

    const receivedSteps: RunStep[] = [];
    const handle = await subscribeToRun("run-infinite", {
      baseUrl: "http://localhost:8080",
      onStep: (step) => receivedSteps.push(step),
    });

    // Emit one step.
    const step = makeRunStep({ id: "live-step" });
    enqueueFn?.(encoder.encode(makeSseEvent("step_existing", step, "live-step")));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    handle.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(receivedSteps).toHaveLength(1);
    expect(receivedSteps[0]?.id).toBe("live-step");
  });
});
