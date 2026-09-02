/**
 * Telemetry metadata sanitization tests (SDK 1.5.0 — sprint-B).
 *
 * Covers :
 *   - propagation when payload non-empty
 *   - PII redaction by default (keys matching /secret|token|password|api[_-]?key/i)
 *   - PII bypass when TELEMETRY_INCLUDE_PAYLOADS=true
 *   - 4 KB truncation marker
 *   - backward compat : metadata omitted when payload empty/absent
 *   - circular structures fallback
 *
 * Ref: command-center:sprint-B:telemetry-metadata
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTelemetryMetadata } from "../orchestration/ooda/agent.js";

describe("buildTelemetryMetadata", () => {
  const ORIGINAL_ENV = process.env.TELEMETRY_INCLUDE_PAYLOADS;

  beforeEach(() => {
    delete process.env.TELEMETRY_INCLUDE_PAYLOADS;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.TELEMETRY_INCLUDE_PAYLOADS;
    } else {
      process.env.TELEMETRY_INCLUDE_PAYLOADS = ORIGINAL_ENV;
    }
  });

  describe("backward compat (1.4.0 → 1.5.0)", () => {
    it("returns undefined for absent payload", () => {
      expect(buildTelemetryMetadata(undefined)).toBeUndefined();
    });

    it("returns undefined for empty payload object", () => {
      expect(buildTelemetryMetadata({})).toBeUndefined();
    });
  });

  describe("propagation", () => {
    it("propagates a plain payload", () => {
      const payload = {
        prompt: "Explain quantum entanglement",
        response: "Two particles ...",
        latencyMs: 240,
      };
      const out = buildTelemetryMetadata(payload);
      expect(out).toEqual(payload);
    });

    it("propagates nested structures", () => {
      const payload = {
        decision: {
          action: "publish",
          reasoning: ["claim", "support", "warrant"],
        },
        meta: { ok: true },
      };
      const out = buildTelemetryMetadata(payload);
      expect(out).toEqual(payload);
    });

    it("does not mutate caller payload", () => {
      const payload = {
        secret: "ttt",
        nested: { apiKey: "kkk" },
      };
      const snapshot = JSON.parse(JSON.stringify(payload));
      buildTelemetryMetadata(payload);
      expect(payload).toEqual(snapshot);
    });
  });

  describe("PII redaction (default behavior)", () => {
    it("redacts top-level `secret` key", () => {
      const out = buildTelemetryMetadata({
        secret: "supersecret",
        keep: "ok",
      });
      expect(out).toEqual({ secret: "[REDACTED]", keep: "ok" });
    });

    it("redacts `token`, `password`, `apiKey`, `api_key`, `api-key` keys", () => {
      const out = buildTelemetryMetadata({
        token: "tok-1",
        password: "p@ss",
        apiKey: "k1",
        api_key: "k2",
        "api-key": "k3",
        normal: "visible",
      });
      expect(out).toEqual({
        token: "[REDACTED]",
        password: "[REDACTED]",
        apiKey: "[REDACTED]",
        api_key: "[REDACTED]",
        "api-key": "[REDACTED]",
        normal: "visible",
      });
    });

    it("redacts nested sensitive keys", () => {
      const out = buildTelemetryMetadata({
        outer: {
          inner: {
            secret: "nested-secret",
            ok: "yes",
          },
        },
      });
      expect(out).toEqual({
        outer: { inner: { secret: "[REDACTED]", ok: "yes" } },
      });
    });

    it("redacts sensitive keys inside arrays", () => {
      const out = buildTelemetryMetadata({
        items: [{ token: "t1" }, { token: "t2", value: 1 }],
      });
      expect(out).toEqual({
        items: [{ token: "[REDACTED]" }, { token: "[REDACTED]", value: 1 }],
      });
    });

    it("case-insensitive key matching", () => {
      const out = buildTelemetryMetadata({
        SECRET: "x",
        Token: "y",
        Password: "z",
      });
      expect(out).toEqual({
        SECRET: "[REDACTED]",
        Token: "[REDACTED]",
        Password: "[REDACTED]",
      });
    });
  });

  describe("PII bypass when TELEMETRY_INCLUDE_PAYLOADS=true", () => {
    it("propagates secrets unchanged when env flag set", () => {
      process.env.TELEMETRY_INCLUDE_PAYLOADS = "true";
      const out = buildTelemetryMetadata({
        secret: "visible-now",
        nested: { apiKey: "also-visible" },
      });
      expect(out).toEqual({
        secret: "visible-now",
        nested: { apiKey: "also-visible" },
      });
    });

    it("does NOT bypass for other truthy strings", () => {
      process.env.TELEMETRY_INCLUDE_PAYLOADS = "1";
      const out = buildTelemetryMetadata({ token: "still-hidden" });
      expect(out).toEqual({ token: "[REDACTED]" });
    });
  });

  describe("size cap (4 KB)", () => {
    it("propagates payload under 4 KB unchanged", () => {
      const payload = { prompt: "a".repeat(1024) };
      const out = buildTelemetryMetadata(payload);
      expect(out).toEqual(payload);
    });

    it("replaces oversized payload with truncation marker", () => {
      const payload = { prompt: "x".repeat(8192) };
      const out = buildTelemetryMetadata(payload) as {
        truncated?: boolean;
        originalBytes?: number;
      };
      expect(out?.truncated).toBe(true);
      expect(out?.originalBytes).toBeGreaterThan(4096);
    });

    it("4 KB cap applies on JSON-serialised size, not key count", () => {
      // 5 keys of small size = under cap, returned verbatim
      const small = { a: 1, b: 2, c: 3, d: 4, e: 5 };
      expect(buildTelemetryMetadata(small)).toEqual(small);
    });
  });

  describe("fallback behaviors", () => {
    it("returns serialization_failed marker on circular structures", () => {
      const payload: Record<string, unknown> = { name: "loop" };
      payload.self = payload;
      const out = buildTelemetryMetadata(payload);
      expect(out).toEqual({ error: "metadata_serialization_failed" });
    });
  });
});
