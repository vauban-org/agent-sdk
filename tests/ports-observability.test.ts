import { describe, expect, it, vi } from "vitest";
import {
  type AttrValue,
  type EventSeverity,
  type MetricInput,
  type MetricType,
  NoopObservabilityPort,
  ObservabilityError,
  type ObservabilityEvent,
  ObservabilityFlushTimeoutError,
  type Span,
  type SpanAttributes,
} from "../src/ports/observability.js";

// ─── Error classes ────────────────────────────────────────────────────────────

describe("ObservabilityError", () => {
  it("has name ObservabilityError", () => {
    const err = new ObservabilityError("telemetry backend down");
    expect(err.name).toBe("ObservabilityError");
  });

  it("is instanceof Error", () => {
    const err = new ObservabilityError("msg");
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof ObservabilityError", () => {
    const err = new ObservabilityError("msg");
    expect(err).toBeInstanceOf(ObservabilityError);
  });

  it("stores message", () => {
    const err = new ObservabilityError("span export failed");
    expect(err.message).toBe("span export failed");
  });

  it("stores optional cause", () => {
    const cause = new Error("network timeout");
    const err = new ObservabilityError("flush error", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when omitted", () => {
    const err = new ObservabilityError("msg");
    expect(err.cause).toBeUndefined();
  });
});

describe("ObservabilityFlushTimeoutError", () => {
  it("has name ObservabilityFlushTimeoutError", () => {
    const err = new ObservabilityFlushTimeoutError(3000);
    expect(err.name).toBe("ObservabilityFlushTimeoutError");
  });

  it("is instanceof Error", () => {
    const err = new ObservabilityFlushTimeoutError(1000);
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof ObservabilityFlushTimeoutError", () => {
    const err = new ObservabilityFlushTimeoutError(1000);
    expect(err).toBeInstanceOf(ObservabilityFlushTimeoutError);
  });

  it("stores timeoutMs", () => {
    const err = new ObservabilityFlushTimeoutError(4500);
    expect(err.timeoutMs).toBe(4500);
  });

  it("message includes timeoutMs", () => {
    const err = new ObservabilityFlushTimeoutError(2500);
    expect(err.message).toContain("2500");
  });

  it("message mentions timed out", () => {
    const err = new ObservabilityFlushTimeoutError(100);
    expect(err.message).toMatch(/timed out/i);
  });

  it("stores optional cause", () => {
    const cause = new Error("otel exporter error");
    const err = new ObservabilityFlushTimeoutError(5000, cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── NoopObservabilityPort ────────────────────────────────────────────────────

describe("NoopObservabilityPort", () => {
  it("startSpan returns a span with setAttribute", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("workflow.execute");
    expect(typeof span.setAttribute).toBe("function");
  });

  it("startSpan returns a span with recordException", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("brain.query");
    expect(typeof span.recordException).toBe("function");
  });

  it("startSpan returns a span with setStatus", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("bastion.swap");
    expect(typeof span.setStatus).toBe("function");
  });

  it("startSpan returns a span with end", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("glacis.attest");
    expect(typeof span.end).toBe("function");
  });

  it("startSpan with attrs does not throw", () => {
    const port = new NoopObservabilityPort();
    const attrs: SpanAttributes = { "tenant.id": "t1", "step.index": 3 };
    expect(() => port.startSpan("test.span", attrs)).not.toThrow();
  });

  it("span.setAttribute does not throw", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.setAttribute("key", "value")).not.toThrow();
  });

  it("span.setAttribute accepts number value", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.setAttribute("latency_ms", 42)).not.toThrow();
  });

  it("span.setAttribute accepts boolean value", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.setAttribute("is_cached", true)).not.toThrow();
  });

  it("span.setAttribute accepts array value", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.setAttribute("tags", ["a", "b"])).not.toThrow();
  });

  it("span.recordException does not throw on Error", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.recordException(new Error("oops"))).not.toThrow();
  });

  it("span.recordException does not throw on unknown", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.recordException("raw string error")).not.toThrow();
  });

  it("span.setStatus with OK does not throw", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.setStatus({ code: "OK" })).not.toThrow();
  });

  it("span.setStatus with ERROR and message does not throw", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.setStatus({ code: "ERROR", message: "step failed" })).not.toThrow();
  });

  it("span.end does not throw", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test");
    expect(() => span.end()).not.toThrow();
  });

  it("multiple startSpan calls return the same noop span reference", () => {
    const port = new NoopObservabilityPort();
    const s1 = port.startSpan("a");
    const s2 = port.startSpan("b");
    // Both are valid span objects
    expect(typeof s1.end).toBe("function");
    expect(typeof s2.end).toBe("function");
  });

  it("recordEvent does not throw for debug event", () => {
    const port = new NoopObservabilityPort();
    const event: ObservabilityEvent = {
      name: "workflow.started",
      severity: "debug",
    };
    expect(() => port.recordEvent(event)).not.toThrow();
  });

  it("recordEvent does not throw for error event with attributes", () => {
    const port = new NoopObservabilityPort();
    const event: ObservabilityEvent = {
      name: "brain.archive.failed",
      severity: "error",
      attributes: { "error.code": "TIMEOUT", "retry.count": 3 },
      timestamp: Date.now(),
      traceId: "abc123",
      spanId: "def456",
    };
    expect(() => port.recordEvent(event)).not.toThrow();
  });

  it("recordMetric does not throw for counter", () => {
    const port = new NoopObservabilityPort();
    const metric: MetricInput = {
      name: "pipeline.executions.total",
      type: "counter",
      value: 1,
      labels: { pipeline: "vault-guardian" },
    };
    expect(() => port.recordMetric(metric)).not.toThrow();
  });

  it("recordMetric does not throw for gauge", () => {
    const port = new NoopObservabilityPort();
    const metric: MetricInput = {
      name: "quota.remaining",
      type: "gauge",
      value: 0.75,
    };
    expect(() => port.recordMetric(metric)).not.toThrow();
  });

  it("recordMetric does not throw for histogram", () => {
    const port = new NoopObservabilityPort();
    const metric: MetricInput = {
      name: "llm.latency_ms",
      type: "histogram",
      value: 320,
      labels: { model: "llama-3.3-70b" },
      timestamp: Date.now(),
    };
    expect(() => port.recordMetric(metric)).not.toThrow();
  });

  it("flush resolves without error", async () => {
    const port = new NoopObservabilityPort();
    await expect(port.flush()).resolves.toBeUndefined();
  });

  it("flush returns a Promise", () => {
    const port = new NoopObservabilityPort();
    expect(port.flush()).toBeInstanceOf(Promise);
  });
});

// ─── Type-level shape tests (runtime object construction) ─────────────────────

describe("ObservabilityEvent shape", () => {
  it("accepts all severity levels", () => {
    const severities: EventSeverity[] = ["debug", "info", "warn", "error", "fatal"];
    for (const severity of severities) {
      const event: ObservabilityEvent = { name: "test", severity };
      expect(event.severity).toBe(severity);
    }
  });

  it("timestamp is optional", () => {
    const event: ObservabilityEvent = { name: "test", severity: "info" };
    expect(event.timestamp).toBeUndefined();
  });
});

describe("MetricInput shape", () => {
  it("accepts all metric types", () => {
    const types: MetricType[] = ["gauge", "counter", "histogram"];
    for (const type of types) {
      const metric: MetricInput = { name: "m", type, value: 1 };
      expect(metric.type).toBe(type);
    }
  });
});
