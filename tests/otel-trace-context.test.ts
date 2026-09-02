/**
 * W3C Trace Context propagation tests.
 *
 * Covers:
 *  1. inject / extract roundtrip
 *  2. 3-hop delegation chain: trace_id continuity + parent_run_id attribute
 *  3. W3C traceparent header format conformance
 *  4. Invalid / malformed header rejection
 */

import { ROOT_CONTEXT, type Span, type Tracer, context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractTraceContext,
  injectTraceContext,
  registerW3CPropagator,
  withDelegationAttribute,
} from "../src/otel/trace-context.js";

// ─── W3C traceparent regex (spec: 00-{32hex}-{16hex}-{2hex}) ─────────────────

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build an isolated provider + exporter pair.
 * Always get the tracer from the returned provider — do NOT use the global
 * trace.getTracer() since OTel only registers the first global provider.
 */
function buildIsolatedProvider(): {
  provider: BasicTracerProvider;
  exporter: InMemorySpanExporter;
  getTracer: (name: string) => Tracer;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  registerW3CPropagator();
  return {
    provider,
    exporter,
    getTracer: (name: string) => provider.getTracer(name),
  };
}

function exportedSpans(exporter: InMemorySpanExporter): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("injectTraceContext / extractTraceContext", () => {
  let exporter: InMemorySpanExporter;
  let getTracer: (name: string) => Tracer;

  beforeEach(() => {
    ({ exporter, getTracer } = buildIsolatedProvider());
  });

  it("inject adds traceparent header conforming to W3C spec", () => {
    const tracer = getTracer("inject-test");
    const span = tracer.startSpan("root");
    const ctx = trace.setSpan(context.active(), span);

    const headers: Record<string, string> = {};
    injectTraceContext(headers, ctx);
    span.end();

    expect(headers.traceparent).toMatch(TRACEPARENT_RE);
  });

  it("extract roundtrip: extracted SpanContext matches injected span", () => {
    const tracer = getTracer("roundtrip-test");
    const span = tracer.startSpan("root");
    const ctx = trace.setSpan(context.active(), span);

    const headers: Record<string, string> = {};
    injectTraceContext(headers, ctx);
    span.end();

    const extracted = extractTraceContext(headers);
    const original = span.spanContext();

    expect(extracted).not.toBeNull();
    expect(extracted!.traceId).toBe(original.traceId);
    expect(extracted!.spanId).toBe(original.spanId);
    expect(extracted!.traceFlags).toBe(original.traceFlags);
  });

  it("extract returns null for missing traceparent", () => {
    expect(extractTraceContext({})).toBeNull();
  });

  it("extract returns null for malformed traceparent", () => {
    expect(extractTraceContext({ traceparent: "bad-value" })).toBeNull();
  });

  it("extract returns null for all-zero traceId", () => {
    const headers = {
      traceparent: `00-${"0".repeat(32)}-${"a".repeat(16)}-01`,
    };
    expect(extractTraceContext(headers)).toBeNull();
  });

  it("extract returns null for all-zero spanId", () => {
    const headers = {
      traceparent: `00-${"a".repeat(32)}-${"0".repeat(16)}-01`,
    };
    expect(extractTraceContext(headers)).toBeNull();
  });

  it("injectTraceContext returns the same headers object", () => {
    const tracer = getTracer("return-test");
    const span = tracer.startSpan("root");
    const ctx = trace.setSpan(context.active(), span);
    const headers: Record<string, string> = { existing: "value" };
    const result = injectTraceContext(headers, ctx);
    span.end();
    expect(result).toBe(headers);
    expect(result.existing).toBe("value");
  });

  it("inject produces no traceparent when no active span", () => {
    const headers: Record<string, string> = {};
    injectTraceContext(headers, ROOT_CONTEXT);
    expect(headers.traceparent).toBeUndefined();
  });
});

describe("withDelegationAttribute", () => {
  let getTracer: (name: string) => Tracer;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    ({ getTracer, exporter } = buildIsolatedProvider());
  });

  it("sets gen_ai.delegation.parent_run_id on a live span", () => {
    const tracer = getTracer("delegation-attr-test");
    const span = tracer.startSpan("child-cycle");
    withDelegationAttribute(span, "run-parent-abc123");
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["gen_ai.delegation.parent_run_id"]).toBe("run-parent-abc123");
  });

  it("attribute key is exactly gen_ai.delegation.parent_run_id (no typo)", () => {
    const mockSpan = { setAttribute: vi.fn() };
    withDelegationAttribute(mockSpan as any, "value");
    const [key] = mockSpan.setAttribute.mock.calls[0]!;
    expect(key).toBe("gen_ai.delegation.parent_run_id");
  });

  it("passes the parentRunId value unchanged to setAttribute", () => {
    const mockSpan = { setAttribute: vi.fn() };
    withDelegationAttribute(mockSpan as any, "run-xyz-9999");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.delegation.parent_run_id",
      "run-xyz-9999",
    );
  });

  it("calls setAttribute exactly once per invocation", () => {
    const mockSpan = { setAttribute: vi.fn() };
    withDelegationAttribute(mockSpan as any, "once");
    expect(mockSpan.setAttribute).toHaveBeenCalledTimes(1);
  });

  it("does not throw for an empty string parentRunId", () => {
    const mockSpan = { setAttribute: vi.fn() };
    expect(() => withDelegationAttribute(mockSpan as any, "")).not.toThrow();
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("gen_ai.delegation.parent_run_id", "");
  });
});

describe("3-hop delegation chain", () => {
  let exporter: InMemorySpanExporter;
  let getTracer: (name: string) => Tracer;

  beforeEach(() => {
    ({ exporter, getTracer } = buildIsolatedProvider());
  });

  it("all 3 spans share the same trace_id and parent_run_id propagates", () => {
    const tracer = getTracer("chain-test");

    // ── Hop 1: Parent (OODA) ────────────────────────────────────────────────
    const parentRunId = "run-ooda-001";
    const hop1Headers: Record<string, string> = {};

    const parentSpan: Span = tracer.startSpan("ooda.cycle");
    withDelegationAttribute(parentSpan, parentRunId);
    const parentTraceId = parentSpan.spanContext().traceId;
    const parentSpanId = parentSpan.spanContext().spanId;

    const parentCtx = trace.setSpan(ROOT_CONTEXT, parentSpan);
    injectTraceContext(hop1Headers, parentCtx);
    parentSpan.end();

    expect(hop1Headers.traceparent).toMatch(TRACEPARENT_RE);

    // ── Hop 2: Child (LLMRouter) ────────────────────────────────────────────
    const hop2Headers: Record<string, string> = {};

    const extractedCtx1 = extractTraceContext(hop1Headers);
    expect(extractedCtx1).not.toBeNull();
    expect(extractedCtx1!.traceId).toBe(parentTraceId);

    const remoteCtx1 = trace.setSpanContext(ROOT_CONTEXT, extractedCtx1!);
    const childSpan: Span = tracer.startSpan("llmrouter.cycle", {}, remoteCtx1);
    withDelegationAttribute(childSpan, parentRunId);

    const childCtx = trace.setSpan(remoteCtx1, childSpan);
    injectTraceContext(hop2Headers, childCtx);
    childSpan.end();

    expect(hop2Headers.traceparent).toMatch(TRACEPARENT_RE);

    // ── Hop 3: Grandchild (MCP) ─────────────────────────────────────────────
    const extractedCtx2 = extractTraceContext(hop2Headers);
    expect(extractedCtx2).not.toBeNull();
    expect(extractedCtx2!.traceId).toBe(parentTraceId);

    const remoteCtx2 = trace.setSpanContext(ROOT_CONTEXT, extractedCtx2!);
    const grandchildSpan: Span = tracer.startSpan("mcp.cycle", {}, remoteCtx2);
    withDelegationAttribute(grandchildSpan, parentRunId);
    grandchildSpan.end();

    // ── Assertions ───────────────────────────────────────────────────────────
    const finished = exportedSpans(exporter);
    expect(finished).toHaveLength(3);

    // All spans share the root trace_id
    for (const s of finished) {
      expect(s.spanContext().traceId).toBe(parentTraceId);
    }

    // Span hierarchy: child.parentSpanContext.spanId = parentSpanId (from remote ctx1)
    const childReadable = finished.find((s) => s.name === "llmrouter.cycle")!;
    expect(childReadable).toBeDefined();
    expect(childReadable.parentSpanContext?.spanId).toBe(parentSpanId);

    // Grandchild's parent = childSpan spanId
    const childSpanId = childSpan.spanContext().spanId;
    const grandchildReadable = finished.find((s) => s.name === "mcp.cycle")!;
    expect(grandchildReadable).toBeDefined();
    expect(grandchildReadable.parentSpanContext?.spanId).toBe(childSpanId);

    // All child/grandchild spans carry gen_ai.delegation.parent_run_id
    const allNonRoot = finished.filter((s) => s.name !== "ooda.cycle");
    for (const s of allNonRoot) {
      const attr = s.attributes["gen_ai.delegation.parent_run_id"];
      expect(attr).toBe(parentRunId);
    }
  });

  it("traceparent header format conformance: all 3 hops produce valid W3C headers", () => {
    const tracer = getTracer("format-test");

    const s1 = tracer.startSpan("hop-1");
    const ctx1 = trace.setSpan(ROOT_CONTEXT, s1);
    const h1: Record<string, string> = {};
    injectTraceContext(h1, ctx1);
    s1.end();

    const sc1 = extractTraceContext(h1)!;
    const remoteCtx1 = trace.setSpanContext(ROOT_CONTEXT, sc1);
    const s2 = tracer.startSpan("hop-2", {}, remoteCtx1);
    const h2: Record<string, string> = {};
    injectTraceContext(h2, trace.setSpan(remoteCtx1, s2));
    s2.end();

    const sc2 = extractTraceContext(h2)!;
    const remoteCtx2 = trace.setSpanContext(ROOT_CONTEXT, sc2);
    const s3 = tracer.startSpan("hop-3", {}, remoteCtx2);
    const h3: Record<string, string> = {};
    injectTraceContext(h3, trace.setSpan(remoteCtx2, s3));
    s3.end();

    for (const h of [h1, h2, h3]) {
      expect(h.traceparent).toMatch(TRACEPARENT_RE);
    }

    // All 3 must share the same trace_id (encoded in traceparent field index 1)
    const traceIds = [h1, h2, h3].map((h) => h.traceparent!.split("-")[1]);
    expect(traceIds[0]).toBe(traceIds[1]);
    expect(traceIds[1]).toBe(traceIds[2]);
  });
});
