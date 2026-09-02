/**
 * Tests for packages/agent-sdk/src/retry/presets.ts
 *
 * Coverage:
 *   RETRY_TRANSIENT, RETRY_AGGRESSIVE, RETRY_PATIENT, NO_RETRY — shape validation,
 *   retryIf behavior: honors `retryable` flag, defaults when flag absent
 *
 * Ref: test coverage for agent-sdk/retry/presets.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  NO_RETRY,
  RETRY_AGGRESSIVE,
  RETRY_PATIENT,
  RETRY_TRANSIENT,
} from "../src/retry/presets.js";

describe("retry presets shape", () => {
  it("RETRY_TRANSIENT has correct defaults", () => {
    expect(RETRY_TRANSIENT.maxAttempts).toBe(3);
    expect(RETRY_TRANSIENT.jitter).toBe(true);
    expect(RETRY_TRANSIENT.baseDelayMs).toBe(1000);
    expect(RETRY_TRANSIENT.maxDelayMs).toBe(10_000);
  });

  it("RETRY_AGGRESSIVE has correct defaults", () => {
    expect(RETRY_AGGRESSIVE.maxAttempts).toBe(5);
    expect(RETRY_AGGRESSIVE.baseDelayMs).toBe(500);
    expect(RETRY_AGGRESSIVE.maxDelayMs).toBe(30_000);
  });

  it("RETRY_PATIENT has correct defaults", () => {
    expect(RETRY_PATIENT.maxAttempts).toBe(10);
    expect(RETRY_PATIENT.baseDelayMs).toBe(2000);
    expect(RETRY_PATIENT.maxDelayMs).toBe(120_000);
  });

  it("NO_RETRY has maxAttempts=1, no jitter", () => {
    expect(NO_RETRY.maxAttempts).toBe(1);
    expect(NO_RETRY.jitter).toBe(false);
    expect(NO_RETRY.baseDelayMs).toBe(0);
  });
});

describe("RETRY_TRANSIENT.retryIf", () => {
  const fn = RETRY_TRANSIENT.retryIf!;

  it("returns true (retry) when retryable flag is true", () => {
    expect(fn({ retryable: true })).toBe(true);
  });

  it("returns false (no retry) when retryable flag is false", () => {
    expect(fn({ retryable: false })).toBe(false);
  });

  it("returns true by default when retryable flag is absent (transient = retry)", () => {
    expect(fn(new Error("network error"))).toBe(true);
    expect(fn("plain string error")).toBe(true);
  });

  it("returns false when retryable is non-boolean truthy (strict check)", () => {
    expect(fn({ retryable: 1 })).toBe(false);
    expect(fn({ retryable: "yes" })).toBe(false);
  });
});
