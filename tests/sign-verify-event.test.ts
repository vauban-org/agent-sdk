/**
 * Tests for packages/agent-sdk/src/auth/sign-event.ts + verify-event.ts
 *
 * Coverage:
 *   canonicalEventString — concatenation format
 *   signEvent — produces 64-char hex, deterministic, differs on secret/payload change
 *   verifyEvent — valid event returns true, UnknownSourceError, InvalidSignatureError,
 *                 ClockSkewError, ReplayDetectedError via InMemoryNonceStore
 *
 * Ref: test coverage for agent-sdk/auth/sign-event + verify-event (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../src/auth/nonce-store.js";
import { canonicalEventString, signEvent } from "../src/auth/sign-event.js";
import { verifyEvent } from "../src/auth/verify-event.js";

const SECRET = "test-secret-key-32-bytes-minimum!!";

function makeEvent(overrides: Partial<ReturnType<typeof baseEvent>> = {}) {
  return { ...baseEvent(), ...overrides };
}

function baseEvent() {
  return {
    type: "forge.pipeline.completed" as const,
    source: "forge" as const,
    timestamp: new Date().toISOString(),
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    schemaVersion: "1.0.0",
    payload: { runId: "run-abc", status: "done" },
  };
}

// ─── canonicalEventString ──────────────────────────────────────────────────────

describe("canonicalEventString", () => {
  it("concatenates fields with pipe separator", () => {
    const ev = baseEvent();
    const result = canonicalEventString(ev, "sha256hash");
    const parts = result.split("|");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe(ev.type);
    expect(parts[1]).toBe(ev.source);
    expect(parts[2]).toBe(ev.timestamp);
    expect(parts[3]).toBe(ev.idempotencyKey);
    expect(parts[4]).toBe("sha256hash");
  });
});

// ─── signEvent ────────────────────────────────────────────────────────────────

describe("signEvent", () => {
  it("produces a 64-char lowercase hex string", () => {
    const sig = signEvent(baseEvent(), SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same event+secret", () => {
    const ev = baseEvent();
    expect(signEvent(ev, SECRET)).toBe(signEvent(ev, SECRET));
  });

  it("produces different signatures for different secrets", () => {
    const ev = baseEvent();
    expect(signEvent(ev, "secret-A")).not.toBe(signEvent(ev, "secret-B"));
  });

  it("produces different signatures when payload changes", () => {
    const ev1 = { ...baseEvent(), payload: { runId: "run-1" } };
    const ev2 = { ...baseEvent(), payload: { runId: "run-2" } };
    expect(signEvent(ev1, SECRET)).not.toBe(signEvent(ev2, SECRET));
  });
});

// ─── verifyEvent ──────────────────────────────────────────────────────────────

describe("verifyEvent", () => {
  function signedEvent(overrides = {}) {
    const ev = makeEvent(overrides);
    const signature = signEvent(ev, SECRET);
    return { ...ev, signature };
  }

  it("returns true for a valid event", async () => {
    const event = signedEvent();
    await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
  });

  it("throws UnknownSourceError for invalid source", async () => {
    const ev = signedEvent({ source: "unknown-service" as never });
    await expect(verifyEvent(ev, SECRET)).rejects.toMatchObject({
      name: "UnknownSourceError",
    });
  });

  it("throws InvalidSignatureError when signature is tampered", async () => {
    const event = signedEvent();
    const tampered = { ...event, signature: "0".repeat(64) };
    await expect(verifyEvent(tampered, SECRET)).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });

  it("throws InvalidSignatureError when wrong secret used", async () => {
    const event = signedEvent();
    await expect(verifyEvent(event, "wrong-secret")).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });

  it("throws ClockSkewError when timestamp is too old", async () => {
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const ev = makeEvent({ timestamp: oldTs });
    const signature = signEvent(ev, SECRET);
    const event = { ...ev, signature };
    await expect(verifyEvent(event, SECRET, { maxClockSkewMs: 60_000 })).rejects.toMatchObject({
      name: "ClockSkewError",
    });
  });

  it("throws ReplayDetectedError when nonce is reused", async () => {
    const nonceStore = new InMemoryNonceStore();
    const event = signedEvent();
    await verifyEvent(event, SECRET, { nonceStore });
    await expect(verifyEvent(event, SECRET, { nonceStore })).rejects.toMatchObject({
      name: "ReplayDetectedError",
    });
  });

  it("accepts valid sources: forge, cc, brain, citadel, glacis, tenant", async () => {
    for (const source of ["forge", "cc", "brain", "citadel", "glacis", "tenant"] as const) {
      const ev = makeEvent({ source });
      const signature = signEvent(ev, SECRET);
      await expect(verifyEvent({ ...ev, signature }, SECRET)).resolves.toBe(true);
    }
  });
});
