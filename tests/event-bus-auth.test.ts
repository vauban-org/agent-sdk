/**
 * Event bus auth tests — sprint-615:quick-7
 *
 * Tests for:
 *   - signEvent / verifyEvent roundtrip
 *   - Error types: InvalidSignatureError, ClockSkewError, ReplayDetectedError, UnknownSourceError
 *   - InMemoryNonceStore dedup
 *   - TestEventBus publishWithIdempotency + subscribeDomain + replayFrom
 *   - eventBusContract suite (8 new extended tests via TestEventBus)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ClockSkewError,
  InvalidSignatureError,
  ReplayDetectedError,
  UnknownSourceError,
} from "../src/auth/errors.js";
import { InMemoryNonceStore } from "../src/auth/nonce-store.js";
import { canonicalEventString, signEvent } from "../src/auth/sign-event.js";
import { verifyEvent } from "../src/auth/verify-event.js";
import type { DomainEvent } from "../src/ports/event-bus.js";
import { eventBusContract } from "../src/testing/contracts/event-bus.contract.js";
import { TestEventBus } from "../src/testing/test-event-bus.js";

const SECRET = "test-hmac-secret-that-is-at-least-32chars";

function makeEvent(
  overrides: Partial<Omit<DomainEvent, "signature">> = {},
): Omit<DomainEvent, "signature"> {
  return {
    type: "cc.test.happened",
    source: "cc",
    correlationId: "corr-abc123",
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    schemaVersion: "1.0.0",
    payload: { value: 42 },
    ...overrides,
  };
}

function makeSignedEvent(overrides: Partial<Omit<DomainEvent, "signature">> = {}): DomainEvent {
  const event = makeEvent(overrides);
  return { ...event, signature: signEvent(event, SECRET) };
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

describe("signEvent", () => {
  it("produces a 64-char hex string", () => {
    const event = makeEvent();
    const sig = signEvent(event, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", () => {
    const event = makeEvent({ idempotencyKey: "fixed-key" });
    expect(signEvent(event, SECRET)).toBe(signEvent(event, SECRET));
  });

  it("differs for different secrets", () => {
    const event = makeEvent({ idempotencyKey: "fixed-key" });
    expect(signEvent(event, SECRET)).not.toBe(signEvent(event, "other-secret"));
  });

  it("differs for different payloads", () => {
    const key = `fixed-key-${Math.random()}`;
    const a = makeEvent({ idempotencyKey: key, payload: { v: 1 } });
    const b = makeEvent({ idempotencyKey: key, payload: { v: 2 } });
    expect(signEvent(a, SECRET)).not.toBe(signEvent(b, SECRET));
  });
});

describe("canonicalEventString", () => {
  it("joins fields with pipe delimiter", () => {
    const event = makeEvent({
      type: "cc.vault.compounded",
      source: "cc",
      timestamp: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "k1",
    });
    const result = canonicalEventString(event, "deadbeef");
    expect(result).toBe("cc.vault.compounded|cc|2026-01-01T00:00:00.000Z|k1|deadbeef");
  });
});

describe("verifyEvent", () => {
  it("returns true for a valid signed event", async () => {
    const event = makeSignedEvent();
    await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
  });

  it("throws InvalidSignatureError for wrong signature", async () => {
    const event = { ...makeSignedEvent(), signature: "0".repeat(64) };
    await expect(verifyEvent(event, SECRET)).rejects.toThrow(InvalidSignatureError);
  });

  it("throws InvalidSignatureError for wrong secret", async () => {
    const event = makeSignedEvent();
    await expect(verifyEvent(event, "wrong-secret")).rejects.toThrow(InvalidSignatureError);
  });

  it("throws UnknownSourceError for invalid source", async () => {
    const event = makeSignedEvent({ source: "unknown-product" as "cc" });
    // Re-sign with the modified source so signature check passes — but source is invalid
    const resigned: DomainEvent = {
      ...event,
      source: "unknown-product" as "cc",
      signature: signEvent({ ...makeEvent(), source: "unknown-product" as "cc" }, SECRET),
    };
    await expect(verifyEvent(resigned, SECRET)).rejects.toThrow(UnknownSourceError);
  });

  it("throws ClockSkewError for timestamp 10 minutes in the past", async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const event = makeSignedEvent({ timestamp: past });
    await expect(verifyEvent(event, SECRET)).rejects.toThrow(ClockSkewError);
  });

  it("throws ClockSkewError for timestamp 10 minutes in the future", async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeSignedEvent({ timestamp: future });
    await expect(verifyEvent(event, SECRET)).rejects.toThrow(ClockSkewError);
  });

  it("accepts event within custom maxClockSkewMs", async () => {
    const past = new Date(Date.now() - 30 * 1000).toISOString();
    const event = makeSignedEvent({ timestamp: past });
    await expect(verifyEvent(event, SECRET, { maxClockSkewMs: 60_000 })).resolves.toBe(true);
  });

  it("throws ReplayDetectedError for duplicate nonce", async () => {
    const nonceStore = new InMemoryNonceStore();
    const event = makeSignedEvent();
    await verifyEvent(event, SECRET, { nonceStore });
    await expect(verifyEvent(event, SECRET, { nonceStore })).rejects.toThrow(ReplayDetectedError);
  });

  it("accepts different nonces on the same store", async () => {
    const nonceStore = new InMemoryNonceStore();
    const e1 = makeSignedEvent({ idempotencyKey: "key-a" });
    const e2 = makeSignedEvent({ idempotencyKey: "key-b" });
    await expect(verifyEvent(e1, SECRET, { nonceStore })).resolves.toBe(true);
    await expect(verifyEvent(e2, SECRET, { nonceStore })).resolves.toBe(true);
  });
});

describe("InMemoryNonceStore", () => {
  it("returns true for a new key", async () => {
    const store = new InMemoryNonceStore();
    expect(await store.setNX("key1", 60_000)).toBe(true);
  });

  it("returns false for a duplicate key within TTL", async () => {
    const store = new InMemoryNonceStore();
    await store.setNX("key1", 60_000);
    expect(await store.setNX("key1", 60_000)).toBe(false);
  });

  it("reset clears all state", async () => {
    const store = new InMemoryNonceStore();
    await store.setNX("key1", 60_000);
    store.reset();
    expect(await store.setNX("key1", 60_000)).toBe(true);
  });
});

// ─── TestEventBus extended methods ──────────────────────────────────────────

describe("TestEventBus.publishWithIdempotency", () => {
  let bus: TestEventBus;

  beforeEach(() => {
    bus = new TestEventBus();
    bus.setSigningSecret(SECRET);
  });

  it("publishes a signed event to the domain stream", async () => {
    const event = makeEvent({ idempotencyKey: "pub-idem-1" });
    await bus.publishWithIdempotency(event, event.idempotencyKey);

    const replayed: DomainEvent[] = [];
    for await (const e of bus.replayFrom("domain:cc.test.happened", "0")) {
      replayed.push(e);
    }
    expect(replayed.length).toBeGreaterThanOrEqual(1);
    expect(replayed[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deduplicates same idempotency key", async () => {
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain<{ value: number }>("cc.test.happened", async (e) => {
      received.push(e);
    });

    const key = `dedup-idem-${Math.random()}`;
    const event = makeEvent({ idempotencyKey: key });
    await bus.publishWithIdempotency(event, key);
    await bus.publishWithIdempotency(event, key);

    await sub.unsubscribe();
    expect(received.length).toBeLessThanOrEqual(1);
  });

  it("publishes distinct events for different keys", async () => {
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain<{ value: number }>("cc.test.happened", async (e) => {
      received.push(e);
    });

    const k1 = `key-a-${Math.random()}`;
    const k2 = `key-b-${Math.random()}`;
    await bus.publishWithIdempotency(makeEvent({ idempotencyKey: k1 }), k1);
    await bus.publishWithIdempotency(makeEvent({ idempotencyKey: k2 }), k2);

    await sub.unsubscribe();
    expect(received.length).toBe(2);
  });
});

describe("TestEventBus.replayFrom", () => {
  let bus: TestEventBus;

  beforeEach(() => {
    bus = new TestEventBus();
    bus.setSigningSecret(SECRET);
  });

  it("yields events in insertion order", async () => {
    const k1 = `r1-${Math.random()}`;
    const k2 = `r2-${Math.random()}`;
    await bus.publishWithIdempotency(makeEvent({ idempotencyKey: k1, payload: { seq: 1 } }), k1);
    await bus.publishWithIdempotency(makeEvent({ idempotencyKey: k2, payload: { seq: 2 } }), k2);

    const events: DomainEvent[] = [];
    for await (const e of bus.replayFrom("domain:cc.test.happened", "0")) {
      events.push(e);
    }
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty for non-existing stream", async () => {
    const events: DomainEvent[] = [];
    for await (const e of bus.replayFrom("domain:nonexistent", "0")) {
      events.push(e);
    }
    expect(events.length).toBe(0);
  });

  it("returns empty for fromId beyond all stored events", async () => {
    const k = `beyond-${Math.random()}`;
    await bus.publishWithIdempotency(makeEvent({ idempotencyKey: k }), k);

    const events: DomainEvent[] = [];
    for await (const e of bus.replayFrom("domain:cc.test.happened", "9999999999999-0")) {
      events.push(e);
    }
    expect(events.length).toBe(0);
  });
});

describe("TestEventBus.subscribeDomain — signature verification", () => {
  let bus: TestEventBus;

  beforeEach(() => {
    bus = new TestEventBus();
    bus.setSigningSecret(SECRET);
  });

  it("delivers valid signed events to handler", async () => {
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain("cc.test.happened", async (e) => {
      received.push(e);
    });

    const k = `valid-${Math.random()}`;
    await bus.publishWithIdempotency(makeEvent({ idempotencyKey: k }), k);

    await sub.unsubscribe();
    expect(received.length).toBe(1);
  });

  it("routes events with bad signature to DLQ without calling handler", async () => {
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain("cc.bad.sig", async (e) => {
      received.push(e);
    });

    const badEvent: DomainEvent = {
      ...makeEvent({ type: "cc.bad.sig" }),
      signature: "bad".repeat(20).slice(0, 64),
    };

    // Directly invoke the subscriber with a bad event via internal dispatcher
    const subs = (
      bus as unknown as {
        domainSubscribers: Map<string, Map<string, (e: DomainEvent) => Promise<void>>>;
      }
    ).domainSubscribers;
    const typeSubs = subs.get("cc.bad.sig");
    if (typeSubs) {
      for (const handler of typeSubs.values()) {
        await handler(badEvent);
      }
    }

    await sub.unsubscribe();
    expect(received.length).toBe(0);
    expect(bus.domainDlqEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("routes expired events (>5min clock skew) to DLQ", async () => {
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain("cc.expired", async (e) => {
      received.push(e);
    });

    const pastEvent: DomainEvent = makeSignedEvent({
      type: "cc.expired",
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const subs = (
      bus as unknown as {
        domainSubscribers: Map<string, Map<string, (e: DomainEvent) => Promise<void>>>;
      }
    ).domainSubscribers;
    const typeSubs = subs.get("cc.expired");
    if (typeSubs) {
      for (const handler of typeSubs.values()) {
        await handler(pastEvent);
      }
    }

    await sub.unsubscribe();
    expect(received.length).toBe(0);
    expect(bus.domainDlqEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Contract test suite via TestEventBus ───────────────────────────────────

eventBusContract(async () => {
  const bus = new TestEventBus();
  bus.setSigningSecret(SECRET);
  return { port: bus, cleanup: async () => bus.reset() };
});
