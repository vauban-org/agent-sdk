/**
 * Tests for typed port errors (Sprint-459).
 */

import { describe, expect, it } from "vitest";
import {
  BrainAuthError,
  BrainRateLimit,
  BrainUnavailable,
  BrainValidationError,
  DbConnectionLost,
  DbQueryError,
  isPortError,
  isRetryablePortError,
  OutcomeAttributionFailed,
  PortError,
} from "../src/errors.js";

describe("PortError subclasses", () => {
  it("BrainUnavailable is retryable with port 'brain'", () => {
    const e = new BrainUnavailable("conn refused", new Error("ECONNREFUSED"));
    expect(e).toBeInstanceOf(PortError);
    expect(e).toBeInstanceOf(BrainUnavailable);
    expect(e.port).toBe("brain");
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("conn refused");
    expect((e as unknown as { cause: unknown }).cause).toBeInstanceOf(Error);
    expect(e.name).toBe("BrainUnavailable");
  });

  it("BrainRateLimit carries retryAfterMs and is retryable", () => {
    const e = new BrainRateLimit({ retryAfterMs: 3000 });
    expect(e.retryAfterMs).toBe(3000);
    expect(e.retryable).toBe(true);
    expect(e.port).toBe("brain");
  });

  it("BrainValidationError is not retryable", () => {
    const e = new BrainValidationError("bad schema");
    expect(e.retryable).toBe(false);
    expect(e.port).toBe("brain");
  });

  it("BrainAuthError is not retryable", () => {
    const e = new BrainAuthError("invalid token");
    expect(e.retryable).toBe(false);
  });

  it("DbConnectionLost is retryable", () => {
    const e = new DbConnectionLost();
    expect(e.port).toBe("db");
    expect(e.retryable).toBe(true);
  });

  it("DbQueryError truncates sqlPreview to 200 chars", () => {
    const long = "SELECT ".padEnd(500, "x");
    const e = new DbQueryError({
      message: "syntax error",
      sqlPreview: long,
    });
    expect(e.sqlPreview?.length).toBe(200);
    expect(e.retryable).toBe(false);
  });

  it("OutcomeAttributionFailed carries runId", () => {
    const e = new OutcomeAttributionFailed("run-123", "outcome_id already set");
    expect(e.port).toBe("outcome");
    expect(e.runId).toBe("run-123");
    expect(e.retryable).toBe(false);
  });
});

describe("isPortError()", () => {
  it("returns true for any PortError subclass", () => {
    expect(isPortError(new BrainUnavailable())).toBe(true);
    expect(isPortError(new DbConnectionLost())).toBe(true);
  });

  it("narrows by port identifier when provided", () => {
    expect(isPortError(new BrainUnavailable(), "brain")).toBe(true);
    expect(isPortError(new BrainUnavailable(), "db")).toBe(false);
  });

  it("returns false for non-Error and plain Error", () => {
    expect(isPortError("boom")).toBe(false);
    expect(isPortError(new Error("plain"))).toBe(false);
    expect(isPortError(null)).toBe(false);
  });
});

describe("isRetryablePortError()", () => {
  it("true for retryable port errors", () => {
    expect(isRetryablePortError(new BrainUnavailable())).toBe(true);
    expect(isRetryablePortError(new BrainRateLimit())).toBe(true);
    expect(isRetryablePortError(new DbConnectionLost())).toBe(true);
  });

  it("false for non-retryable port errors", () => {
    expect(isRetryablePortError(new BrainValidationError("x"))).toBe(false);
    expect(isRetryablePortError(new BrainAuthError())).toBe(false);
  });

  it("false for non-PortError", () => {
    expect(isRetryablePortError(new Error("plain"))).toBe(false);
    expect(isRetryablePortError({ retryable: true })).toBe(false);
  });
});
