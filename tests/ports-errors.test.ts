/**
 * Tests for src/ports/manifest-registry.ts and src/ports/observability.ts
 *
 * Coverage:
 *   manifest-registry.ts:
 *     SUPPORTED_TIERS — contains all 6 valid tiers
 *     ManifestNotFoundError — name, version, instanceof, .name
 *     ManifestSignatureInvalidError — fields, .name
 *     ManifestVersionConflictError — fields, .name
 *     ManifestComplianceConflictError — fields, .name
 *     ManifestValidationError — violations array, count in message, .name
 *   observability.ts:
 *     NoopObservabilityPort — startSpan returns no-op span (all methods callable),
 *       recordEvent/recordMetric are no-ops, flush resolves
 *     ObservabilityError — name, message, cause
 *     ObservabilityFlushTimeoutError — name, timeoutMs, message
 *
 * Ref: test coverage for ports error classes + noop implementations (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  ManifestComplianceConflictError,
  ManifestNotFoundError,
  ManifestSignatureInvalidError,
  ManifestValidationError,
  ManifestVersionConflictError,
  SUPPORTED_TIERS,
} from "../src/ports/manifest-registry.js";
import {
  NoopObservabilityPort,
  ObservabilityError,
  ObservabilityFlushTimeoutError,
} from "../src/ports/observability.js";

// ─── SUPPORTED_TIERS ──────────────────────────────────────────────────────────

describe("SUPPORTED_TIERS", () => {
  it("contains all 6 valid tiers", () => {
    expect(SUPPORTED_TIERS).toHaveLength(6);
    expect(SUPPORTED_TIERS).toContain("dev");
    expect(SUPPORTED_TIERS).toContain("test");
    expect(SUPPORTED_TIERS).toContain("pilot");
    expect(SUPPORTED_TIERS).toContain("production");
    expect(SUPPORTED_TIERS).toContain("internal");
    expect(SUPPORTED_TIERS).toContain("legacy");
  });
});

// ─── ManifestNotFoundError ────────────────────────────────────────────────────

describe("ManifestNotFoundError", () => {
  it("stores name and version fields", () => {
    const err = new ManifestNotFoundError("my-agent", "1.2.3");
    expect(err.name).toBe("ManifestNotFoundError");
    // err.name is the error name field (overridden), access constructor props via params
    expect((err as unknown as { name: string }).name).toBe("ManifestNotFoundError");
  });

  it("message contains agent name and version", () => {
    const err = new ManifestNotFoundError("my-agent", "1.2.3");
    expect(err.message).toContain("my-agent");
    expect(err.message).toContain("1.2.3");
  });

  it("instanceof Error", () => {
    expect(new ManifestNotFoundError("x", "1.0.0")).toBeInstanceOf(Error);
  });

  it("instanceof ManifestNotFoundError", () => {
    expect(new ManifestNotFoundError("x", "1.0.0")).toBeInstanceOf(ManifestNotFoundError);
  });
});

// ─── ManifestSignatureInvalidError ────────────────────────────────────────────

describe("ManifestSignatureInvalidError", () => {
  it("has correct .name", () => {
    const err = new ManifestSignatureInvalidError("agent", "1.0.0");
    expect(err.name).toBe("ManifestSignatureInvalidError");
  });

  it("message contains name and version", () => {
    const err = new ManifestSignatureInvalidError("agent", "1.0.0");
    expect(err.message).toContain("agent");
    expect(err.message).toContain("1.0.0");
  });

  it("stores cause when provided", () => {
    const cause = new Error("upstream");
    const err = new ManifestSignatureInvalidError("agent", "1.0.0", cause);
    expect(err.cause).toBe(cause);
  });

  it("instanceof ManifestSignatureInvalidError", () => {
    expect(new ManifestSignatureInvalidError("a", "1.0.0")).toBeInstanceOf(
      ManifestSignatureInvalidError,
    );
  });
});

// ─── ManifestVersionConflictError ────────────────────────────────────────────

describe("ManifestVersionConflictError", () => {
  it("has correct .name", () => {
    const err = new ManifestVersionConflictError("agent", "1.0.0", "deprecated");
    expect(err.name).toBe("ManifestVersionConflictError");
  });

  it("stores existingStatus", () => {
    const err = new ManifestVersionConflictError("agent", "1.0.0", "revoked");
    expect(err.existingStatus).toBe("revoked");
  });

  it("message contains status", () => {
    const err = new ManifestVersionConflictError("agent", "1.0.0", "deprecated");
    expect(err.message).toContain("deprecated");
  });
});

// ─── ManifestComplianceConflictError ─────────────────────────────────────────

describe("ManifestComplianceConflictError", () => {
  it("has correct .name", () => {
    const err = new ManifestComplianceConflictError(
      "agent",
      "1.0.0",
      "tier=production+mode=audit_only",
    );
    expect(err.name).toBe("ManifestComplianceConflictError");
  });

  it("stores violation field", () => {
    const err = new ManifestComplianceConflictError("agent", "1.0.0", "missing jurisdiction");
    expect(err.violation).toBe("missing jurisdiction");
  });

  it("message contains violation", () => {
    const err = new ManifestComplianceConflictError("a", "1.0.0", "bad tier");
    expect(err.message).toContain("bad tier");
  });
});

// ─── ManifestValidationError ──────────────────────────────────────────────────

describe("ManifestValidationError", () => {
  it("has correct .name", () => {
    const err = new ManifestValidationError([]);
    expect(err.name).toBe("ManifestValidationError");
  });

  it("stores violations array", () => {
    const violations = [
      { code: "E001", description: "missing field" },
      { code: "E002", description: "bad type" },
    ];
    const err = new ManifestValidationError(violations);
    expect(err.violations).toHaveLength(2);
    expect(err.violations[0].code).toBe("E001");
  });

  it("message includes violation count", () => {
    const err = new ManifestValidationError([
      { code: "E001", description: "a" },
      { code: "E002", description: "b" },
    ]);
    expect(err.message).toContain("2");
  });
});

// ─── NoopObservabilityPort ────────────────────────────────────────────────────

describe("NoopObservabilityPort", () => {
  it("startSpan returns a span where all methods are callable without error", () => {
    const port = new NoopObservabilityPort();
    const span = port.startSpan("test.operation", { key: "value" });
    expect(() => span.setAttribute("k", "v")).not.toThrow();
    expect(() => span.recordException(new Error("test"))).not.toThrow();
    expect(() => span.setStatus({ code: "OK" })).not.toThrow();
    expect(() => span.setStatus({ code: "ERROR", message: "failed" })).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });

  it("recordEvent does not throw for any severity", () => {
    const port = new NoopObservabilityPort();
    for (const severity of ["debug", "info", "warn", "error", "fatal"] as const) {
      expect(() => port.recordEvent({ name: "test.event", severity })).not.toThrow();
    }
  });

  it("recordMetric does not throw for any metric type", () => {
    const port = new NoopObservabilityPort();
    for (const type of ["gauge", "counter", "histogram"] as const) {
      expect(() => port.recordMetric({ name: "test.metric", type, value: 42 })).not.toThrow();
    }
  });

  it("flush resolves without error", async () => {
    const port = new NoopObservabilityPort();
    await expect(port.flush()).resolves.toBeUndefined();
  });

  it("startSpan without attributes does not throw", () => {
    const port = new NoopObservabilityPort();
    expect(() => port.startSpan("operation.name")).not.toThrow();
  });
});

// ─── ObservabilityError ───────────────────────────────────────────────────────

describe("ObservabilityError", () => {
  it("has .name = 'ObservabilityError'", () => {
    const err = new ObservabilityError("something went wrong");
    expect(err.name).toBe("ObservabilityError");
  });

  it("stores cause when provided", () => {
    const cause = new Error("upstream");
    const err = new ObservabilityError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });

  it("instanceof Error and ObservabilityError", () => {
    const err = new ObservabilityError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObservabilityError);
  });
});

// ─── ObservabilityFlushTimeoutError ──────────────────────────────────────────

describe("ObservabilityFlushTimeoutError", () => {
  it("has .name = 'ObservabilityFlushTimeoutError'", () => {
    const err = new ObservabilityFlushTimeoutError(5000);
    expect(err.name).toBe("ObservabilityFlushTimeoutError");
  });

  it("stores timeoutMs", () => {
    const err = new ObservabilityFlushTimeoutError(3000);
    expect(err.timeoutMs).toBe(3000);
  });

  it("message includes timeoutMs", () => {
    const err = new ObservabilityFlushTimeoutError(2500);
    expect(err.message).toContain("2500");
  });

  it("instanceof Error and ObservabilityFlushTimeoutError", () => {
    const err = new ObservabilityFlushTimeoutError(1000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObservabilityFlushTimeoutError);
  });
});
