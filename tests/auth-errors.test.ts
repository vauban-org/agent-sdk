/**
 * Tests for src/auth/errors.ts
 *
 * Coverage:
 *   InvalidSignatureError — .name, default message, instanceof chain
 *   ClockSkewError — .name, .skewMs, message contains skewMs
 *   ReplayDetectedError — .name, .idempotencyKey, message contains key
 *   UnknownSourceError — .name, .source, message contains source and allowed list
 *
 * Ref: test coverage for src/auth/errors.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  ClockSkewError,
  InvalidSignatureError,
  ReplayDetectedError,
  UnknownSourceError,
} from "../src/auth/errors.js";

// ─── InvalidSignatureError ────────────────────────────────────────────────────

describe("InvalidSignatureError", () => {
  it(".name is 'InvalidSignatureError'", () => {
    expect(new InvalidSignatureError().name).toBe("InvalidSignatureError");
  });

  it("uses default message when none provided", () => {
    expect(new InvalidSignatureError().message).toContain("invalid");
  });

  it("accepts custom message", () => {
    expect(new InvalidSignatureError("bad sig").message).toBe("bad sig");
  });

  it("instanceof Error and InvalidSignatureError", () => {
    const err = new InvalidSignatureError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidSignatureError);
  });
});

// ─── ClockSkewError ───────────────────────────────────────────────────────────

describe("ClockSkewError", () => {
  it(".name is 'ClockSkewError'", () => {
    expect(new ClockSkewError(60_000).name).toBe("ClockSkewError");
  });

  it("stores skewMs field", () => {
    expect(new ClockSkewError(305_000).skewMs).toBe(305_000);
  });

  it("message contains the skew value", () => {
    const err = new ClockSkewError(400_000);
    expect(err.message).toContain("400000");
  });

  it("instanceof Error and ClockSkewError", () => {
    const err = new ClockSkewError(1000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ClockSkewError);
  });
});

// ─── ReplayDetectedError ─────────────────────────────────────────────────────

describe("ReplayDetectedError", () => {
  it(".name is 'ReplayDetectedError'", () => {
    expect(new ReplayDetectedError("key-123").name).toBe("ReplayDetectedError");
  });

  it("stores idempotencyKey field", () => {
    expect(new ReplayDetectedError("idem-abc").idempotencyKey).toBe("idem-abc");
  });

  it("message contains the idempotencyKey", () => {
    const err = new ReplayDetectedError("uuid-replay-test");
    expect(err.message).toContain("uuid-replay-test");
  });

  it("instanceof Error and ReplayDetectedError", () => {
    const err = new ReplayDetectedError("k");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ReplayDetectedError);
  });
});

// ─── UnknownSourceError ───────────────────────────────────────────────────────

describe("UnknownSourceError", () => {
  it(".name is 'UnknownSourceError'", () => {
    expect(new UnknownSourceError("evil").name).toBe("UnknownSourceError");
  });

  it("stores source field", () => {
    expect(new UnknownSourceError("unknown-svc").source).toBe("unknown-svc");
  });

  it("message contains the unknown source name", () => {
    const err = new UnknownSourceError("rogue-service");
    expect(err.message).toContain("rogue-service");
  });

  it("message lists allowed sources", () => {
    const err = new UnknownSourceError("x");
    expect(err.message).toContain("forge");
    expect(err.message).toContain("brain");
    expect(err.message).toContain("citadel");
  });

  it("instanceof Error and UnknownSourceError", () => {
    const err = new UnknownSourceError("src");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnknownSourceError);
  });
});
