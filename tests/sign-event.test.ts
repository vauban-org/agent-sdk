/**
 * Tests for src/auth/sign-event.ts
 *
 * Coverage:
 *   canonicalEventString — produces pipe-delimited string of 5 fields
 *   signEvent — returns 64-char hex HMAC, deterministic, secret-sensitive,
 *     payload-sensitive, different event types produce different signatures
 *
 * Ref: test coverage for src/auth/sign-event.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { canonicalEventString, signEvent } from "../src/auth/sign-event.js";

function makeEvent(
  overrides: Partial<{
    type: string;
    source: string;
    timestamp: string;
    idempotencyKey: string;
    payload: unknown;
  }> = {},
) {
  return {
    type: "forge.task.completed",
    source: "forge" as const,
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { taskId: "t-1" },
    ...overrides,
  };
}

// ─── canonicalEventString ─────────────────────────────────────────────────────

describe("canonicalEventString", () => {
  it("returns a pipe-delimited string with 5 segments", () => {
    const event = makeEvent();
    const payloadHash = "a".repeat(64);
    const result = canonicalEventString(event, payloadHash);
    expect(result.split("|")).toHaveLength(5);
  });

  it("contains event type as first segment", () => {
    const event = makeEvent({ type: "citadel.sprint.sealed" });
    const result = canonicalEventString(event, "hash");
    expect(result.split("|")[0]).toBe("citadel.sprint.sealed");
  });

  it("contains source as second segment", () => {
    const event = makeEvent({ source: "citadel" as never });
    const result = canonicalEventString(event, "hash");
    expect(result.split("|")[1]).toBe("citadel");
  });

  it("contains timestamp as third segment", () => {
    const ts = "2026-06-01T12:00:00.000Z";
    const event = makeEvent({ timestamp: ts });
    const result = canonicalEventString(event, "hash");
    expect(result.split("|")[2]).toBe(ts);
  });

  it("contains idempotencyKey as fourth segment", () => {
    const event = makeEvent({ idempotencyKey: "my-idem-key" });
    const result = canonicalEventString(event, "hash");
    expect(result.split("|")[3]).toBe("my-idem-key");
  });

  it("contains payloadHash as fifth segment", () => {
    const payloadHash = "deadbeef";
    const event = makeEvent();
    const result = canonicalEventString(event, payloadHash);
    expect(result.split("|")[4]).toBe(payloadHash);
  });
});

// ─── signEvent ────────────────────────────────────────────────────────────────

describe("signEvent", () => {
  it("returns a 64-character lowercase hex string", () => {
    const sig = signEvent(makeEvent(), "my-secret");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same event and secret", () => {
    const event = makeEvent();
    const sig1 = signEvent(event, "secret");
    const sig2 = signEvent(event, "secret");
    expect(sig1).toBe(sig2);
  });

  it("differs when the secret changes", () => {
    const event = makeEvent();
    expect(signEvent(event, "secret-a")).not.toBe(signEvent(event, "secret-b"));
  });

  it("differs when the payload changes", () => {
    const e1 = makeEvent({ payload: { taskId: "t-1" } });
    const e2 = makeEvent({ payload: { taskId: "t-2" } });
    expect(signEvent(e1, "secret")).not.toBe(signEvent(e2, "secret"));
  });

  it("differs when the event type changes", () => {
    const e1 = makeEvent({ type: "forge.task.created" });
    const e2 = makeEvent({ type: "forge.task.completed" });
    expect(signEvent(e1, "secret")).not.toBe(signEvent(e2, "secret"));
  });

  it("differs when idempotencyKey changes", () => {
    const e1 = makeEvent({ idempotencyKey: "key-a" });
    const e2 = makeEvent({ idempotencyKey: "key-b" });
    expect(signEvent(e1, "secret")).not.toBe(signEvent(e2, "secret"));
  });

  it("differs when timestamp changes", () => {
    const e1 = makeEvent({ timestamp: "2026-01-01T00:00:00.000Z" });
    const e2 = makeEvent({ timestamp: "2026-06-01T00:00:00.000Z" });
    expect(signEvent(e1, "secret")).not.toBe(signEvent(e2, "secret"));
  });
});
