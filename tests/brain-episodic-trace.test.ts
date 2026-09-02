/**
 * tests/brain-episodic-trace.test.ts
 *
 * Sprint-580 — brain-episodic-trace
 * TDD suite for EpisodicMemoryPort.queryByTrace.
 *
 * Invariants verified:
 *   - recall@5 = 1.0 : inserting 5 entries with traceId="t1" among 50 distractors
 *     returns all 5 via queryByTrace("t1").
 *   - Empty result for unknown traceId.
 *   - limit option is respected.
 *   - Order is stable (ascending insertion / timestamp order).
 *   - No cross-trace leakage (multiple traceIds coexist correctly).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { EpisodicMemoryPort } from "../src/ports/brain.js";
import { InMemoryEpisodicMemory } from "../src/ports/brain.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function randomTraceId(i: number): string {
  // Produce deterministic but distinct fake trace IDs for distractors.
  return `distractor-trace-${i.toString().padStart(4, "0")}`;
}

async function insertDistractors(
  em: EpisodicMemoryPort,
  count: number,
  startIndex = 0,
): Promise<void> {
  for (let i = startIndex; i < startIndex + count; i++) {
    await em.record(
      `agent-distractor-${i % 10}`,
      `run-distractor-${i}`,
      `distractor_event_${i}`,
      { index: i },
      { traceId: randomTraceId(i) },
    );
  }
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InMemoryEpisodicMemory.queryByTrace", () => {
  let em: InMemoryEpisodicMemory;

  beforeEach(() => {
    em = new InMemoryEpisodicMemory();
  });

  // ── recall@5 = 1.0 ──────────────────────────────────────────────────────

  it("recall@5=1.0 — returns all 5 target entries among 50 distractors", async () => {
    // Insert 25 distractors before targets.
    await insertDistractors(em, 25, 0);

    // Insert 5 target entries with traceId="t1".
    const targetEvents = ["alpha", "beta", "gamma", "delta", "epsilon"];
    for (const evt of targetEvents) {
      await em.record("agent-main", "run-t1", evt, { trace: "t1" }, { traceId: "t1" });
    }

    // Insert 25 more distractors after targets.
    await insertDistractors(em, 25, 25);

    const results = await em.queryByTrace("t1");

    expect(results).toHaveLength(5);
    const returnedEvents = results.map((e) => e.event);
    expect(returnedEvents).toEqual(expect.arrayContaining(targetEvents));
    // Every returned entry must carry the correct traceId.
    for (const entry of results) {
      expect(entry.traceId).toBe("t1");
    }
  });

  // ── empty result for unknown traceId ────────────────────────────────────

  it("returns [] for an unknown traceId", async () => {
    await em.record("agent-a", "run-1", "some_event", undefined, { traceId: "known" });

    const results = await em.queryByTrace("unknown-trace-xyz");
    expect(results).toHaveLength(0);
  });

  it("returns [] when store is empty", async () => {
    const results = await em.queryByTrace("t1");
    expect(results).toHaveLength(0);
  });

  // ── limit option ─────────────────────────────────────────────────────────

  it("respects limit option — returns at most limit entries", async () => {
    for (let i = 0; i < 10; i++) {
      await em.record("agent-a", `run-${i}`, `event-${i}`, undefined, { traceId: "trace-limit" });
    }

    const results = await em.queryByTrace("trace-limit", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("returns all entries when limit exceeds count", async () => {
    for (let i = 0; i < 4; i++) {
      await em.record("agent-a", `run-${i}`, `event-${i}`, undefined, { traceId: "trace-small" });
    }

    const results = await em.queryByTrace("trace-small", { limit: 100 });
    expect(results).toHaveLength(4);
  });

  // ── stable insertion order ────────────────────────────────────────────────

  it("returns entries in stable insertion (ascending timestamp) order", async () => {
    const events = ["first", "second", "third", "fourth", "fifth"];
    for (const evt of events) {
      await em.record("agent-order", "run-order", evt, undefined, { traceId: "trace-order" });
    }

    const results = await em.queryByTrace("trace-order");
    expect(results.map((e) => e.event)).toEqual(events);
  });

  it("limit preserves insertion order — returns first N entries", async () => {
    const events = ["e0", "e1", "e2", "e3", "e4"];
    for (const evt of events) {
      await em.record("agent-order", "run-limit", evt, undefined, { traceId: "trace-order-limit" });
    }

    const results = await em.queryByTrace("trace-order-limit", { limit: 3 });
    expect(results.map((e) => e.event)).toEqual(["e0", "e1", "e2"]);
  });

  // ── no cross-trace leakage ────────────────────────────────────────────────

  it("does not leak entries across multiple traceIds", async () => {
    await em.record("agent-x", "run-x", "event-x", undefined, { traceId: "trace-A" });
    await em.record("agent-y", "run-y", "event-y", undefined, { traceId: "trace-B" });
    await em.record("agent-z", "run-z", "event-z", undefined, { traceId: "trace-A" });

    const aResults = await em.queryByTrace("trace-A");
    expect(aResults).toHaveLength(2);
    expect(aResults.every((e) => e.traceId === "trace-A")).toBe(true);

    const bResults = await em.queryByTrace("trace-B");
    expect(bResults).toHaveLength(1);
    expect(bResults[0]?.traceId).toBe("trace-B");
  });

  // ── entries without traceId are not returned ─────────────────────────────

  it("entries recorded without traceId are not returned by queryByTrace", async () => {
    // Old-style record call (no opts — pre-existing behavior).
    await em.record("agent-old", "run-old", "old_event");
    // New entry with traceId.
    await em.record("agent-new", "run-new", "new_event", undefined, { traceId: "trace-new" });

    const results = await em.queryByTrace("trace-new");
    expect(results).toHaveLength(1);
    expect(results[0]?.event).toBe("new_event");

    // Querying for undefined traceId does not match old entries.
    const noneResults = await em.queryByTrace("undefined");
    expect(noneResults).toHaveLength(0);
  });

  // ── backward compatibility: since() still works ──────────────────────────

  it("since() is unaffected by the new traceId field", async () => {
    await em.record("agent-compat", "run-1", "event-with-trace", undefined, {
      traceId: "t-compat",
    });
    await em.record("agent-compat", "run-2", "event-no-trace");

    const all = await em.since("agent-compat", 0);
    expect(all).toHaveLength(2);
  });
});
