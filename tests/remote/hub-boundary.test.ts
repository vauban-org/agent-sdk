/**
 * Boundary-case tests for `createRemoteControlHub` (RemoteControlPort).
 *
 * The base hub suite in `tests/remote.test.ts` exercises backlog gap-free
 * replay, fan-out/unsubscribe, and a happy-path state derivation. This file
 * targets the operational edges :
 *   - bufferSize ring-buffer eviction (oldest dropped, replay still gap-free)
 *   - state() folding through hitl.resolved (pendingHitl decrement floor)
 *   - state() through run.finished (status → "finished", stepCount + costUsd
 *     overridden from the event payload, not accumulated)
 *   - multi-subscriber fan-out (every subscriber receives every event)
 *   - broken subscriber removal (a throwing fn is dropped, the run continues)
 *   - elapsedMs returns 0 when no run.start has been emitted
 *   - backlog(sinceSeq) edge cases : the cutoff seq is excluded, the last
 *     event is included, a too-high cutoff returns []
 *
 * @since 2.26.0
 */

import { describe, expect, it } from "vitest";
import {
  type SessionEvent,
  __resetEventSeq,
  createRemoteControlHub,
  makeEvent,
} from "../../src/remote/index.js";

describe("RemoteControlHub — bufferSize eviction", () => {
  it("drops the oldest event when buffer fills", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 3 });
    const e0 = makeEvent("assistant.message", { content: "0" });
    const e1 = makeEvent("assistant.message", { content: "1" });
    const e2 = makeEvent("assistant.message", { content: "2" });
    const e3 = makeEvent("assistant.message", { content: "3" });
    hub.emit(e0);
    hub.emit(e1);
    hub.emit(e2);
    expect(hub.backlog()).toHaveLength(3);
    hub.emit(e3);
    const b = hub.backlog();
    // After eviction the buffer holds e1, e2, e3 ; e0 is gone.
    expect(b).toHaveLength(3);
    expect(b.map((e) => e.seq)).toEqual([e1.seq, e2.seq, e3.seq]);
  });

  it("backlog(sinceSeq) still returns gap-free events post-eviction", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 2 });
    hub.emit(makeEvent("assistant.message", { content: "0" }));
    const e1 = makeEvent("assistant.message", { content: "1" });
    hub.emit(e1);
    hub.emit(makeEvent("assistant.message", { content: "2" }));
    // e0 is evicted, only e1 and e2 remain.
    const after = hub.backlog(e1.seq);
    expect(after).toHaveLength(1); // only e2
    expect(after[0].data).toEqual({ content: "2" });
  });

  it("default bufferSize (5000 per ADR-119 A1) keeps events without eviction", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    for (let i = 0; i < 100; i++) {
      hub.emit(makeEvent("assistant.message", { content: String(i) }));
    }
    expect(hub.backlog()).toHaveLength(100);
  });
});

describe("RemoteControlHub — state folding edges", () => {
  it("hitl.resolved decrements pendingHitl, floors at 0", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("hitl.request", {
        requestId: "h1",
        action: "x",
        context: "{}",
      }),
    );
    hub.emit(
      makeEvent("hitl.request", {
        requestId: "h2",
        action: "y",
        context: "{}",
      }),
    );
    expect(hub.state().pendingHitl).toBe(2);
    hub.emit(
      makeEvent("hitl.resolved", {
        requestId: "h1",
        approved: true,
        by: "remote",
      }),
    );
    expect(hub.state().pendingHitl).toBe(1);
    hub.emit(
      makeEvent("hitl.resolved", {
        requestId: "h2",
        approved: false,
        by: "remote",
      }),
    );
    expect(hub.state().pendingHitl).toBe(0);
    // Extra resolve must not push pendingHitl below zero.
    hub.emit(
      makeEvent("hitl.resolved", {
        requestId: "h3",
        approved: false,
        by: "remote",
      }),
    );
    expect(hub.state().pendingHitl).toBe(0);
  });

  it("run.finished overrides stepCount + costUsd from the payload", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("run.start", {
        runId: "r-fin",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    hub.emit(
      makeEvent("run.step", {
        stepIndex: 0,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
      }),
    );
    hub.emit(
      makeEvent("run.finished", {
        runId: "r-fin",
        stopReason: "ok",
        // The reported stepCount + costUsd come from the finished payload.
        stepCount: 42,
        costUsd: 1.23,
        finishedAt: new Date().toISOString(),
      }),
    );
    const s = hub.state();
    expect(s.status).toBe("finished");
    expect(s.stepCount).toBe(42);
    expect(s.costUsd).toBeCloseTo(1.23, 6);
  });

  it("elapsedMs is 0 before any run.start, then nonzero after", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    expect(hub.state().elapsedMs).toBe(0);
    hub.emit(
      makeEvent("run.start", {
        runId: "r",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    // Wait a tick so elapsedMs is measurably > 0.
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.state().elapsedMs).toBeGreaterThanOrEqual(1);
  });

  it("run.start resets stepCount + costUsd of any prior run", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("run.start", {
        runId: "r1",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    hub.emit(
      makeEvent("run.step", {
        stepIndex: 0,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.5,
      }),
    );
    expect(hub.state().costUsd).toBeCloseTo(0.5, 6);
    hub.emit(
      makeEvent("run.start", {
        runId: "r2",
        agentId: "b",
        startedAt: new Date().toISOString(),
      }),
    );
    const s = hub.state();
    expect(s.runId).toBe("r2");
    expect(s.agentId).toBe("b");
    expect(s.stepCount).toBe(0);
    expect(s.costUsd).toBe(0);
  });
});

describe("RemoteControlHub — fan-out + error isolation", () => {
  it("multi-subscriber fan-out — every subscriber receives every event in order", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const a: SessionEvent[] = [];
    const b: SessionEvent[] = [];
    const c: SessionEvent[] = [];
    hub.subscribe((e) => a.push(e));
    hub.subscribe((e) => b.push(e));
    hub.subscribe((e) => c.push(e));
    const e1 = makeEvent("assistant.message", { content: "one" });
    const e2 = makeEvent("assistant.message", { content: "two" });
    hub.emit(e1);
    hub.emit(e2);
    expect(a.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
    expect(b.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
    expect(c.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
  });

  it("a throwing subscriber is removed, other subscribers keep receiving", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const survivor: SessionEvent[] = [];
    let brokenCalls = 0;
    hub.subscribe(() => {
      brokenCalls++;
      throw new Error("subscriber blew up");
    });
    hub.subscribe((e) => survivor.push(e));
    hub.emit(makeEvent("assistant.message", { content: "first" }));
    // The broken subscriber is called once then removed.
    expect(brokenCalls).toBe(1);
    hub.emit(makeEvent("assistant.message", { content: "second" }));
    // Survivor still received both events.
    expect(survivor).toHaveLength(2);
    expect(brokenCalls).toBe(1);
  });

  it("unsubscribe is idempotent — calling off() twice is safe", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const seen: SessionEvent[] = [];
    const off = hub.subscribe((e) => seen.push(e));
    off();
    expect(() => off()).not.toThrow();
    hub.emit(makeEvent("assistant.message", { content: "ghost" }));
    expect(seen).toHaveLength(0);
  });
});

describe("RemoteControlHub — backlog edges", () => {
  it("backlog with no events returns empty array", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    expect(hub.backlog()).toEqual([]);
    expect(hub.backlog(0)).toEqual([]);
    expect(hub.backlog(9999)).toEqual([]);
  });

  it("backlog(sinceSeq) is STRICT > comparison (cutoff seq is excluded)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const e0 = makeEvent("assistant.message", { content: "0" });
    const e1 = makeEvent("assistant.message", { content: "1" });
    hub.emit(e0);
    hub.emit(e1);
    expect(hub.backlog(e0.seq).map((e) => e.seq)).toEqual([e1.seq]);
    expect(hub.backlog(e1.seq)).toEqual([]); // post-last
  });

  it("backlog() returns a copy — mutating the result does not affect the buffer", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(makeEvent("assistant.message", { content: "x" }));
    const snap = hub.backlog();
    snap.length = 0;
    snap.push({} as SessionEvent);
    // Internal buffer untouched.
    expect(hub.backlog()).toHaveLength(1);
  });
});
