/**
 * Tests for `PersistencePort` + `InMemoryPersistencePort` (P7).
 *
 * Covers :
 *   - InMemory impl correctness (events idempotent on seq, revocations
 *     idempotent on jti, maxSeq tracking)
 *   - tryPersistEvent fire-and-forget contract (no throw on missing port)
 *   - close() makes further calls reject
 *   - clearAll() resets state
 *   - Hub wiring (events flow into persistence on emit)
 *   - loadHubFromPersistence warms the backlog
 */

import { describe, expect, it } from "vitest";
import { __resetEventSeq, makeEvent } from "../../src/remote/events.js";
import {
  InMemoryPersistencePort,
  type PersistencePort,
  tryPersistEvent,
} from "../../src/remote/persistence.js";
import { createRemoteControlHub, loadHubFromPersistence } from "../../src/remote/port.js";

describe("InMemoryPersistencePort", () => {
  it("saves and loads events ordered by seq", async () => {
    __resetEventSeq();
    const p = new InMemoryPersistencePort();
    const e1 = makeEvent("run.start", { runId: "r", agentId: "a" });
    const e2 = makeEvent("run.step", { stepIndex: 0, costUsd: 0.01 });
    const e3 = makeEvent("run.step", { stepIndex: 1, costUsd: 0.02 });

    await p.saveEvent(e3);
    await p.saveEvent(e1);
    await p.saveEvent(e2);

    const all = await p.loadEvents();
    expect(all.map((e) => e.seq)).toEqual([e1.seq, e2.seq, e3.seq]);
    expect(await p.getMaxSeq()).toBe(e3.seq);
  });

  it("idempotent saveEvent on identical seq", async () => {
    __resetEventSeq();
    const p = new InMemoryPersistencePort();
    const e = makeEvent("run.start", { runId: "r", agentId: "a" });
    await p.saveEvent(e);
    await p.saveEvent(e);
    await p.saveEvent(e);
    const all = await p.loadEvents();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(e);
  });

  it("loadEvents filters by sinceSeq strictly", async () => {
    __resetEventSeq();
    const p = new InMemoryPersistencePort();
    const a = makeEvent("run.start", { runId: "r", agentId: "a" });
    const b = makeEvent("run.step", { stepIndex: 0, costUsd: 0 });
    const c = makeEvent("run.step", { stepIndex: 1, costUsd: 0 });
    await p.saveEvent(a);
    await p.saveEvent(b);
    await p.saveEvent(c);
    const fromAfterB = await p.loadEvents(b.seq);
    expect(fromAfterB.map((e) => e.seq)).toEqual([c.seq]);
    const fromZero = await p.loadEvents(-1);
    expect(fromZero).toHaveLength(3);
  });

  it("revocations are idempotent and deduplicated", async () => {
    const p = new InMemoryPersistencePort();
    await p.saveRevocation("jti-1");
    await p.saveRevocation("jti-1");
    await p.saveRevocation("jti-2");
    const all = await p.loadRevocations();
    expect(all.sort()).toEqual(["jti-1", "jti-2"]);
  });

  it("clearAll resets events, revocations, and maxSeq", async () => {
    __resetEventSeq();
    const p = new InMemoryPersistencePort();
    const e = makeEvent("run.start", { runId: "r", agentId: "a" });
    await p.saveEvent(e);
    await p.saveRevocation("jti");
    await p.clearAll();
    expect(await p.loadEvents()).toEqual([]);
    expect(await p.loadRevocations()).toEqual([]);
    expect(await p.getMaxSeq()).toBe(0);
  });

  it("close() makes subsequent operations throw", async () => {
    const p = new InMemoryPersistencePort();
    await p.close();
    expect(p.isClosed).toBe(true);
    await expect(p.saveRevocation("x")).rejects.toThrow(/closed/);
    await expect(p.loadRevocations()).rejects.toThrow(/closed/);
    await expect(p.getMaxSeq()).rejects.toThrow(/closed/);
  });
});

describe("tryPersistEvent fire-and-forget contract", () => {
  it("is a no-op when persistence is undefined", async () => {
    __resetEventSeq();
    const e = makeEvent("run.start", { runId: "r", agentId: "a" });
    await expect(tryPersistEvent(undefined, e)).resolves.toBeUndefined();
  });

  it("delegates to persistence.saveEvent", async () => {
    __resetEventSeq();
    const p = new InMemoryPersistencePort();
    const e = makeEvent("run.start", { runId: "r", agentId: "a" });
    await tryPersistEvent(p, e);
    expect(await p.loadEvents()).toHaveLength(1);
  });

  it("swallows persistence errors without throwing", async () => {
    __resetEventSeq();
    const broken: PersistencePort = {
      saveEvent: () => Promise.reject(new Error("disk full")),
      loadEvents: () => Promise.resolve([]),
      getMaxSeq: () => Promise.resolve(0),
      saveRevocation: () => Promise.resolve(),
      loadRevocations: () => Promise.resolve([]),
      clearAll: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const e = makeEvent("run.start", { runId: "r", agentId: "a" });
    // Should not throw — broken disk must not crash the agent loop.
    await expect(tryPersistEvent(broken, e)).resolves.toBeUndefined();
  });
});

describe("hub wiring — emit persists fire-and-forget", () => {
  it("writes every emitted event to the configured persistence", async () => {
    __resetEventSeq();
    const persistence = new InMemoryPersistencePort();
    // SDK 2.28.0 default flipped to canonical ; the persisted type reflects
    // the canonical projection of the emitted legacy makeEvent type.
    const hub = createRemoteControlHub({ persistence });

    hub.emit(makeEvent("run.start", { runId: "r1", agentId: "a" }));
    hub.emit(makeEvent("run.step", { stepIndex: 0, costUsd: 0.5 }));

    // Give the fire-and-forget a tick to settle.
    await new Promise<void>((r) => queueMicrotask(r));

    const persisted = await persistence.loadEvents();
    expect(persisted.map((e) => e.type)).toEqual(["RUN_STARTED", "STEP_STARTED"]);
  });

  it("does NOT call persistence when none is configured", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    // Just ensure emit doesn't throw without a persistence port.
    expect(() => hub.emit(makeEvent("run.start", { runId: "r", agentId: "a" }))).not.toThrow();
  });
});

describe("loadHubFromPersistence", () => {
  it("populates the hub's backlog from persistence", async () => {
    __resetEventSeq();
    const persistence = new InMemoryPersistencePort();
    // Pre-seed the persistence with two events from a "previous session".
    const e1 = makeEvent("run.start", { runId: "r", agentId: "a" });
    const e2 = makeEvent("run.step", { stepIndex: 0, costUsd: 0 });
    await persistence.saveEvent(e1);
    await persistence.saveEvent(e2);

    // New session boot. SDK 2.28.0 default = canonical ; replay through emit
    // normalises the legacy persisted types into canonical at the hub boundary.
    __resetEventSeq();
    const hub = createRemoteControlHub({ persistence });
    const { loaded, maxSeq } = await loadHubFromPersistence(hub, persistence);

    expect(loaded).toBe(2);
    expect(maxSeq).toBe(e2.seq);
    // Backlog reflects loaded events (canonical names after replay).
    const backlog = hub.backlog();
    const types = backlog.map((e) => e.type);
    expect(types).toContain("RUN_STARTED");
    expect(types).toContain("STEP_STARTED");
  });

  it("respects sinceSeq cutoff", async () => {
    __resetEventSeq();
    const persistence = new InMemoryPersistencePort();
    const a = makeEvent("run.start", { runId: "r", agentId: "a" });
    const b = makeEvent("run.step", { stepIndex: 0, costUsd: 0 });
    await persistence.saveEvent(a);
    await persistence.saveEvent(b);

    __resetEventSeq();
    const hub = createRemoteControlHub({ persistence });
    const result = await loadHubFromPersistence(hub, persistence, {
      sinceSeq: a.seq,
    });
    expect(result.loaded).toBe(1);
    // Canonical default since 2.28.0.
    expect(hub.backlog().map((e) => e.type)).toEqual(["STEP_STARTED"]);
  });
});
