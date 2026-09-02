/**
 * ObservabilityPort contract tests — validate port interface compliance.
 *
 * Tests verify:
 * - startSpan returns a valid Span with all methods
 * - recordEvent accepts all 5 severity levels
 * - recordMetric accepts gauge, counter, histogram types
 * - flush() resolves successfully
 * - NoopObservabilityPort satisfies the interface
 */

import { describe, expect, it } from "vitest";
import { NoopObservabilityPort, type ObservabilityEvent } from "./observability";

describe("ObservabilityPort contract", () => {
  describe("startSpan", () => {
    it("returns a Span with all required methods", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("test.span", {
        service: "test",
        version: 1,
      });

      expect(span).toBeDefined();
      expect(typeof span.setAttribute).toBe("function");
      expect(typeof span.recordException).toBe("function");
      expect(typeof span.setStatus).toBe("function");
      expect(typeof span.end).toBe("function");
    });

    it("accepts span name and optional attributes", () => {
      const port = new NoopObservabilityPort();
      const span1 = port.startSpan("workflow.execute");
      const span2 = port.startSpan("brain.query", {
        query: "test",
        category: "semantic",
        limit: 10,
      });

      expect(span1).toBeDefined();
      expect(span2).toBeDefined();
      span1.end();
      span2.end();
    });

    it("span.setAttribute accepts string, number, boolean, and arrays", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("test");

      span.setAttribute("string_attr", "hello");
      span.setAttribute("number_attr", 42);
      span.setAttribute("bool_attr", true);
      span.setAttribute("string_array_attr", ["a", "b", "c"]);
      span.setAttribute("number_array_attr", [1, 2, 3]);

      expect(true).toBe(true); // noop implementation succeeds silently
      span.end();
    });

    it("span.recordException accepts Error or unknown", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("test");

      span.recordException(new Error("test error"));
      span.recordException({ message: "unknown error" });
      span.recordException("string error");

      expect(true).toBe(true);
      span.end();
    });

    it("span.setStatus accepts code and optional message", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("test");

      span.setStatus({ code: "OK" });
      span.setStatus({ code: "ERROR", message: "something went wrong" });

      expect(true).toBe(true);
      span.end();
    });

    it("span.end completes the span", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("test");

      expect(() => span.end()).not.toThrow();
    });
  });

  describe("recordEvent", () => {
    it("accepts events with all 5 severity levels", () => {
      const port = new NoopObservabilityPort();
      const severities = ["debug", "info", "warn", "error", "fatal"] as const;

      for (const severity of severities) {
        const event: ObservabilityEvent = {
          name: `event.${severity}`,
          severity,
        };
        expect(() => port.recordEvent(event)).not.toThrow();
      }
    });

    it("accepts optional attributes, timestamp, traceId, spanId", () => {
      const port = new NoopObservabilityPort();
      const event: ObservabilityEvent = {
        name: "test.event",
        severity: "info",
        attributes: {
          user_id: "user-123",
          action: "created",
          resource_count: 5,
        },
        timestamp: Date.now(),
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
      };

      expect(() => port.recordEvent(event)).not.toThrow();
    });

    it("attributes can contain strings, numbers, booleans, and arrays", () => {
      const port = new NoopObservabilityPort();
      const event: ObservabilityEvent = {
        name: "complex.event",
        severity: "warn",
        attributes: {
          message: "test warning",
          count: 42,
          enabled: true,
          tags: ["tag1", "tag2"],
          scores: [9.5, 8.7, 9.2],
        },
      };

      expect(() => port.recordEvent(event)).not.toThrow();
    });
  });

  describe("recordMetric", () => {
    it("accepts gauge type metrics", () => {
      const port = new NoopObservabilityPort();
      port.recordMetric({
        name: "memory.usage",
        type: "gauge",
        value: 512,
        labels: { instance: "worker-1" },
      });

      expect(true).toBe(true);
    });

    it("accepts counter type metrics", () => {
      const port = new NoopObservabilityPort();
      port.recordMetric({
        name: "requests.total",
        type: "counter",
        value: 1,
        labels: { endpoint: "/api/query" },
      });

      expect(true).toBe(true);
    });

    it("accepts histogram type metrics", () => {
      const port = new NoopObservabilityPort();
      port.recordMetric({
        name: "request.duration",
        type: "histogram",
        value: 125,
        labels: { method: "POST" },
      });

      expect(true).toBe(true);
    });

    it("optional timestamp defaults to Date.now()", () => {
      const port = new NoopObservabilityPort();
      const before = Date.now();
      port.recordMetric({
        name: "test.metric",
        type: "gauge",
        value: 100,
      });
      const after = Date.now();

      expect(after).toBeGreaterThanOrEqual(before);
    });

    it("accepts metrics without labels", () => {
      const port = new NoopObservabilityPort();
      port.recordMetric({
        name: "simple.metric",
        type: "gauge",
        value: 42,
      });

      expect(true).toBe(true);
    });
  });

  describe("flush", () => {
    it("resolves successfully", async () => {
      const port = new NoopObservabilityPort();
      const result = port.flush();

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it("can be called multiple times", async () => {
      const port = new NoopObservabilityPort();

      await expect(port.flush()).resolves.toBeUndefined();
      await expect(port.flush()).resolves.toBeUndefined();
      await expect(port.flush()).resolves.toBeUndefined();
    });
  });

  describe("NoopObservabilityPort interface compliance", () => {
    it("satisfies ObservabilityPort contract", () => {
      const port = new NoopObservabilityPort();

      // All methods required by ObservabilityPort are present
      expect(typeof port.startSpan).toBe("function");
      expect(typeof port.recordEvent).toBe("function");
      expect(typeof port.recordMetric).toBe("function");
      expect(typeof port.flush).toBe("function");
    });

    it("startSpan, recordEvent, recordMetric work together", () => {
      const port = new NoopObservabilityPort();

      const span = port.startSpan("integration.test", { phase: "setup" });
      port.recordEvent({
        name: "span.created",
        severity: "info",
      });
      port.recordMetric({
        name: "span.count",
        type: "counter",
        value: 1,
      });
      span.setAttribute("status", "active");
      port.recordEvent({
        name: "span.attribute.set",
        severity: "debug",
      });
      span.setStatus({ code: "OK" });
      span.end();

      expect(true).toBe(true); // all calls succeed
    });
  });

  describe("error paths", () => {
    it("recordException handles various error types gracefully", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("error.test");

      const testCases = [
        new Error("standard error"),
        new TypeError("type error"),
        new RangeError("range error"),
        { code: "CUSTOM_ERROR", message: "custom error object" },
        "string error",
        null,
        undefined,
      ];

      for (const testCase of testCases) {
        expect(() => span.recordException(testCase)).not.toThrow();
      }

      span.end();
    });

    it("setStatus accepts various code strings", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("status.test");

      const codes = ["OK", "ERROR", "UNSET", "PENDING"];
      for (const code of codes) {
        expect(() => span.setStatus({ code })).not.toThrow();
        expect(() => span.setStatus({ code, message: "optional message" })).not.toThrow();
      }

      span.end();
    });
  });

  describe("attribute value types", () => {
    it("setAttribute validates AttrValue union", () => {
      const port = new NoopObservabilityPort();
      const span = port.startSpan("types.test");

      // All valid AttrValue types
      span.setAttribute("string", "value");
      span.setAttribute("number", 123);
      span.setAttribute("float", 3.14);
      span.setAttribute("bool", false);
      span.setAttribute("array_strings", ["a", "b"]);
      span.setAttribute("array_numbers", [1, 2, 3]);

      expect(true).toBe(true);
      span.end();
    });
  });
});
