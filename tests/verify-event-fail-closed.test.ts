/**
 * Tests for the G-01 fail-closed remediation in
 * packages/agent-sdk/src/auth/verify-event.ts
 *
 * Coverage:
 *   verifyEvent — with requireNonceStore:true and NO nonceStore, a valid
 *     cross-product event is REJECTED (does NOT return true) with
 *     ReplayDetectedError (fail-closed, G-01).
 *   verifyEvent — with requireNonceStore:true AND a nonceStore, a first-delivery
 *     event still passes (legitimate traffic is not broken).
 *   verifyEvent — with requireNonceStore:true, a replayed event (same
 *     idempotencyKey within the window) is rejected with ReplayDetectedError.
 *   verifyEvent — requireNonceStore defaults to false (backward-compatible
 *     standalone primitive contract unchanged).
 *
 * Ref: security/audit-2026-05-30 G-01 (verify-event fail-open → fail-closed)
 */

import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../src/auth/nonce-store.js";
import { signEvent } from "../src/auth/sign-event.js";
import { verifyEvent } from "../src/auth/verify-event.js";
import type { EventSource } from "../src/ports/event-bus.js";

const SECRET = "g01-fail-closed-secret-32-bytes-min!!";

function signedEvent(overrides: { source?: EventSource; idempotencyKey?: string } = {}) {
  const ev = {
    type: "forge.task.completed",
    source: "forge" as EventSource,
    correlationId: "corr-g01",
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    schemaVersion: "1.0.0",
    payload: { taskId: "t-g01" },
    ...overrides,
  };
  const signature = signEvent(ev as Parameters<typeof signEvent>[0], SECRET);
  return { ...ev, signature };
}

describe("verifyEvent — G-01 fail-closed (requireNonceStore)", () => {
  it("REJECTS a valid event when requireNonceStore:true and no nonceStore is configured (does NOT return true)", async () => {
    const event = signedEvent();
    // The cross-product path passes requireNonceStore:true. Without a store,
    // replay protection cannot run, so verification MUST fail-closed.
    const result = await verifyEvent(event, SECRET, {
      requireNonceStore: true,
    }).then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.e).toMatchObject({ name: "ReplayDetectedError" });
    }
  });

  it("still accepts a legitimate first-delivery event when requireNonceStore:true AND a nonceStore is wired", async () => {
    const nonceStore = new InMemoryNonceStore();
    const event = signedEvent();
    await expect(verifyEvent(event, SECRET, { nonceStore, requireNonceStore: true })).resolves.toBe(
      true,
    );
  });

  it("rejects a replayed event (same idempotencyKey within window) when a nonceStore is wired", async () => {
    const nonceStore = new InMemoryNonceStore();
    const event = signedEvent();
    // First delivery passes.
    await expect(verifyEvent(event, SECRET, { nonceStore, requireNonceStore: true })).resolves.toBe(
      true,
    );
    // Replay of the exact same event (same idempotencyKey) is rejected.
    await expect(
      verifyEvent(event, SECRET, { nonceStore, requireNonceStore: true }),
    ).rejects.toMatchObject({
      name: "ReplayDetectedError",
      idempotencyKey: event.idempotencyKey,
    });
  });

  it("defaults requireNonceStore to false (standalone primitive contract unchanged)", async () => {
    const event = signedEvent();
    // No requireNonceStore flag → legacy behavior preserved (replay check skipped).
    await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
  });
});
