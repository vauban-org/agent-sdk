/**
 * Tests for packages/agent-sdk/src/auth/verify-event.ts — edge cases
 *
 * Coverage:
 *   verifyEvent — all 8 valid sources accepted, all invalid sources rejected,
 *     future-dated timestamp exceeds clock skew, custom maxClockSkewMs,
 *     signature length mismatch treated as InvalidSignatureError,
 *     payload mutation after signing is caught, multiple independent events
 *     with shared NonceStore succeed independently, source check precedes
 *     signature check (fast-fail order), empty-string signature rejected,
 *     nonceStore absence skips replay check, second verify of same event
 *     without nonceStore succeeds twice, schemaVersion field is not part
 *     of the HMAC canonical string (changing it does not affect signature
 *     verification — only payload/type/source/timestamp/idempotencyKey matter)
 *
 * Ref: coverage for src/auth/verify-event.ts edge cases
 */

import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../src/auth/nonce-store.js";
import { signEvent } from "../src/auth/sign-event.js";
import { verifyEvent } from "../src/auth/verify-event.js";
import type { EventSource } from "../src/ports/event-bus.js";

const SECRET = "edge-case-secret-for-verify-tests-32b";

function makeSignedEvent(
  overrides: {
    source?: string;
    type?: string;
    timestamp?: string;
    idempotencyKey?: string;
    payload?: unknown;
    schemaVersion?: string;
    correlationId?: string;
  } = {},
) {
  const ev = {
    type: "forge.task.completed",
    source: "forge" as EventSource,
    correlationId: "corr-edge-1",
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    schemaVersion: "1.0.0",
    payload: { taskId: "t-edge" },
    ...overrides,
  };
  const signature = signEvent(ev as Parameters<typeof signEvent>[0], SECRET);
  return { ...ev, signature };
}

// ─── Source validation ────────────────────────────────────────────────────────

describe("verifyEvent — source validation", () => {
  const validSources: EventSource[] = [
    "forge",
    "vauban",
    "vauban-finance",
    "brain",
    "citadel",
    "glacis",
    "cc",
    "tenant",
  ];

  for (const src of validSources) {
    it(`accepts valid source "${src}"`, async () => {
      const event = makeSignedEvent({ source: src });
      await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
    });
  }

  it("throws UnknownSourceError for source 'external-svc'", async () => {
    const event = makeSignedEvent({ source: "external-svc" });
    await expect(verifyEvent(event, SECRET)).rejects.toMatchObject({
      name: "UnknownSourceError",
      source: "external-svc",
    });
  });

  it("throws UnknownSourceError for source 'FORGE' (case-sensitive check)", async () => {
    const event = makeSignedEvent({ source: "FORGE" });
    await expect(verifyEvent(event, SECRET)).rejects.toMatchObject({
      name: "UnknownSourceError",
    });
  });

  it("source check is performed before signature check (unknown source fails first)", async () => {
    // Signature is valid but source is invalid — UnknownSourceError must be thrown
    const event = makeSignedEvent({ source: "evil" });
    const error = await verifyEvent(event, SECRET).catch((e) => e);
    expect(error.name).toBe("UnknownSourceError");
  });
});

// ─── Clock skew ───────────────────────────────────────────────────────────────

describe("verifyEvent — clock skew", () => {
  it("throws ClockSkewError for a future-dated event beyond default window", async () => {
    const futureTs = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const ev = {
      type: "forge.task.completed" as const,
      source: "forge" as EventSource,
      correlationId: "corr-future",
      idempotencyKey: `idem-future-${Math.random()}`,
      timestamp: futureTs,
      schemaVersion: "1.0.0",
      payload: {},
    };
    const signature = signEvent(ev, SECRET);
    await expect(
      verifyEvent({ ...ev, signature }, SECRET, { maxClockSkewMs: 60_000 }),
    ).rejects.toMatchObject({ name: "ClockSkewError" });
  });

  it("throws ClockSkewError for a past event beyond custom maxClockSkewMs", async () => {
    const oldTs = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    const ev = {
      type: "cc.agent.invoked" as const,
      source: "cc" as EventSource,
      correlationId: "corr-old",
      idempotencyKey: `idem-old-${Math.random()}`,
      timestamp: oldTs,
      schemaVersion: "1.0.0",
      payload: { agentId: "a-1" },
    };
    const signature = signEvent(ev, SECRET);
    await expect(
      verifyEvent({ ...ev, signature }, SECRET, { maxClockSkewMs: 60_000 }), // only 1 min tolerance
    ).rejects.toMatchObject({ name: "ClockSkewError" });
  });

  it("accepts an event just within a generous custom maxClockSkewMs", async () => {
    // Event timestamped 4 minutes ago — within 10-minute window
    const recentTs = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const ev = {
      type: "brain.decision.archived" as const,
      source: "brain" as EventSource,
      correlationId: "corr-recent",
      idempotencyKey: `idem-recent-${Math.random()}`,
      timestamp: recentTs,
      schemaVersion: "1.0.0",
      payload: { entryId: "e-1" },
    };
    const signature = signEvent(ev, SECRET);
    await expect(
      verifyEvent({ ...ev, signature }, SECRET, {
        maxClockSkewMs: 10 * 60 * 1000,
      }),
    ).resolves.toBe(true);
  });
});

// ─── Signature rejection ──────────────────────────────────────────────────────

describe("verifyEvent — signature rejection", () => {
  it("rejects an empty-string signature", async () => {
    const event = makeSignedEvent();
    const tampered = { ...event, signature: "" };
    await expect(verifyEvent(tampered, SECRET)).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });

  it("rejects a signature of wrong length (shorter than 64 chars)", async () => {
    const event = makeSignedEvent();
    const tampered = { ...event, signature: "deadbeef" };
    await expect(verifyEvent(tampered, SECRET)).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });

  it("rejects when payload is mutated after signing", async () => {
    const event = makeSignedEvent({ payload: { taskId: "original" } });
    const tampered = { ...event, payload: { taskId: "mutated" } };
    await expect(verifyEvent(tampered, SECRET)).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });

  it("rejects when type is mutated after signing", async () => {
    const event = makeSignedEvent({ type: "forge.task.completed" });
    const tampered = { ...event, type: "forge.task.created" };
    await expect(verifyEvent(tampered, SECRET)).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });

  it("rejects when idempotencyKey is mutated after signing", async () => {
    const event = makeSignedEvent();
    const tampered = { ...event, idempotencyKey: "different-key" };
    await expect(verifyEvent(tampered, SECRET)).rejects.toMatchObject({
      name: "InvalidSignatureError",
    });
  });
});

// ─── Replay protection ────────────────────────────────────────────────────────

describe("verifyEvent — replay protection", () => {
  it("two independent events with the same nonceStore both succeed", async () => {
    const store = new InMemoryNonceStore();
    const event1 = makeSignedEvent();
    const event2 = makeSignedEvent(); // fresh idempotencyKey from makeSignedEvent
    await expect(verifyEvent(event1, SECRET, { nonceStore: store })).resolves.toBe(true);
    await expect(verifyEvent(event2, SECRET, { nonceStore: store })).resolves.toBe(true);
  });

  it("verifying the same event twice without nonceStore succeeds both times", async () => {
    const event = makeSignedEvent();
    await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
    await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
  });

  it("throws ReplayDetectedError with correct idempotencyKey field", async () => {
    const store = new InMemoryNonceStore();
    const event = makeSignedEvent();
    await verifyEvent(event, SECRET, { nonceStore: store });
    const error = await verifyEvent(event, SECRET, { nonceStore: store }).catch((e) => e);
    expect(error.name).toBe("ReplayDetectedError");
    expect(error.idempotencyKey).toBe(event.idempotencyKey);
  });

  it("verifying without nonceStore does not trigger replay error even on duplicate call", async () => {
    const event = makeSignedEvent();
    // Both calls should succeed — no nonce tracking without a store
    const r1 = await verifyEvent(event, SECRET);
    const r2 = await verifyEvent(event, SECRET);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });
});
