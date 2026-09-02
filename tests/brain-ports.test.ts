/**
 * tests/brain-ports.test.ts
 *
 * Sprint-562: A6 — Brain ports working/episodic (2 tiers).
 *
 * Key invariant: two concurrent runs for the same agentId MUST have
 * isolated working memory (scope='run'). Episodic memory is shared
 * across runs — it records what happened when.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryEpisodicMemory,
  InMemoryWorkingMemory,
  MemoryValidationError,
} from "../src/ports/brain.js";

describe("InMemoryWorkingMemory", () => {
  let wm: InMemoryWorkingMemory;

  beforeEach(() => {
    wm = new InMemoryWorkingMemory();
  });

  it("stores and retrieves by runId+key", async () => {
    await wm.set("run-1", "phase", "observe");
    expect(await wm.get("run-1", "phase")).toBe("observe");
  });

  it("returns null for unknown key", async () => {
    expect(await wm.get("run-1", "unknown")).toBeNull();
  });

  it("isolates two concurrent runs with same key", async () => {
    await wm.set("run-1", "state", { step: 1 });
    await wm.set("run-2", "state", { step: 5 });

    expect(await wm.get("run-1", "state")).toEqual({ step: 1 });
    expect(await wm.get("run-2", "state")).toEqual({ step: 5 });
  });

  it("auto-expires after ttlMs", async () => {
    await wm.set("run-1", "ephemeral", "data", { ttlMs: 10 });
    expect(await wm.get("run-1", "ephemeral")).toBe("data");

    await new Promise((r) => setTimeout(r, 15));
    expect(await wm.get("run-1", "ephemeral")).toBeNull();
  });

  it("defaults to 5min ttl when not specified", async () => {
    await wm.set("run-1", "default", "value");
    const entry = await wm.get("run-1", "default");
    expect(entry).toBe("value");
  });

  it("deletes a key", async () => {
    await wm.set("run-1", "tmp", "x");
    await wm.delete("run-1", "tmp");
    expect(await wm.get("run-1", "tmp")).toBeNull();
  });

  it("delete of non-existent key is a no-op", async () => {
    await expect(wm.delete("run-1", "nonexistent")).resolves.not.toThrow();
  });

  describe("list() — V12-aligned working_memory_list", () => {
    it("nominal: returns live slots with V12 fields (slotId/importanceScore/pinned/createdAt)", async () => {
      await wm.set("run-list", "goal", { text: "ship it" }, { importanceScore: 0.9, pinned: true });
      await wm.set("run-list", "scratch", "notes");

      const slots = await wm.list("run-list");
      expect(slots).toHaveLength(2);
      const goal = slots.find((s) => s.slotId === "goal");
      expect(goal).toEqual({
        slotId: "goal",
        content: { text: "ship it" },
        importanceScore: 0.9,
        pinned: true,
        createdAt: expect.any(String),
      });
    });

    it("edge: returns [] for a run with no slots", async () => {
      expect(await wm.list("run-never-touched")).toEqual([]);
    });

    it("edge: expired (non-pinned) slots are excluded from list()", async () => {
      await wm.set("run-list-ttl", "ephemeral", "data", { ttlMs: 5 });
      await new Promise((r) => setTimeout(r, 15));
      expect(await wm.list("run-list-ttl")).toEqual([]);
    });

    it("edge: pinned slots bypass TTL and are never expired out of list()", async () => {
      await wm.set("run-list-pin", "goal", "keep-me", { ttlMs: 5, pinned: true });
      await new Promise((r) => setTimeout(r, 15));
      const slots = await wm.list("run-list-pin");
      expect(slots).toHaveLength(1);
      expect(slots[0].pinned).toBe(true);
    });
  });

  describe("set() — non-positive ttlMs rejected (error path)", () => {
    it("error: rejects ttlMs = 0", async () => {
      await expect(wm.set("run-err", "k", "v", { ttlMs: 0 })).rejects.toThrow(
        MemoryValidationError,
      );
    });

    it("error: rejects negative ttlMs", async () => {
      await expect(wm.set("run-err", "k", "v", { ttlMs: -100 })).rejects.toThrow(
        MemoryValidationError,
      );
    });
  });
});

describe("InMemoryEpisodicMemory", () => {
  let em: InMemoryEpisodicMemory;

  beforeEach(() => {
    em = new InMemoryEpisodicMemory();
  });

  it("records and retrieves events for an agent", async () => {
    await em.record("agent-1", "run-1", "cycle_started");
    await em.record("agent-1", "run-1", "cycle_completed");

    const events = await em.since("agent-1", 0);
    expect(events).toHaveLength(2);
    // newest first — check both events are present regardless of order
    const eventNames = events.map((e) => e.event).sort();
    expect(eventNames).toEqual(["cycle_completed", "cycle_started"]);
  });

  it("filters by agentId — does not leak across agents", async () => {
    await em.record("agent-1", "run-1", "a1_event");
    await em.record("agent-2", "run-2", "a2_event");

    const a1 = await em.since("agent-1", 0);
    expect(a1).toHaveLength(1);
    expect(a1[0].event).toBe("a1_event");

    const a2 = await em.since("agent-2", 0);
    expect(a2).toHaveLength(1);
    expect(a2[0].event).toBe("a2_event");
  });

  it("respects since timestamp", async () => {
    await em.record("agent-1", "run-1", "old_event");
    // Small delay to guarantee timestamp separation
    await new Promise((r) => setTimeout(r, 5));
    const midPoint = Date.now();
    await em.record("agent-1", "run-2", "new_event");

    const recent = await em.since("agent-1", midPoint);
    expect(recent).toHaveLength(1);
    expect(recent[0].event).toBe("new_event");
  });

  it("respects limit option", async () => {
    for (let i = 0; i < 10; i++) {
      await em.record("agent-1", `run-${i}`, `event-${i}`);
    }

    const limited = await em.since("agent-1", 0, { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("stores metadata on events", async () => {
    await em.record("agent-1", "run-1", "payment_received", { amount: 100 });

    const events = await em.since("agent-1", 0);
    expect(events[0].metadata).toEqual({ amount: 100 });
  });

  describe("append() / query() — V12-aligned episodic_append / episodic_query", () => {
    it("nominal: append() returns an id, query() returns the V12 event shape", async () => {
      const eventId = await em.append(
        "agent-v12",
        "session-v12",
        "decision",
        { chose: "contract path" },
        { importanceScore: 0.9, artifacts: ["https://example.com/a"] },
      );
      expect(typeof eventId).toBe("string");

      const events = await em.query({ agentId: "agent-v12" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: eventId,
        agentId: "agent-v12",
        sessionId: "session-v12",
        eventType: "decision",
        content: { chose: "contract path" },
        importanceScore: 0.9,
        artifacts: ["https://example.com/a"],
      });
    });

    it("nominal: eventType is a free string (not constrained to the normative enum)", async () => {
      await em.append("agent-free", "session-free", "custom_event_label", "free string content");
      const events = await em.query({ agentId: "agent-free" });
      expect(events[0].eventType).toBe("custom_event_label");
    });

    it("edge: filters by sessionId, eventTypes, and minImportance", async () => {
      await em.append("agent-filter", "session-a", "decision", "d1", { importanceScore: 0.2 });
      await em.append("agent-filter", "session-b", "error", "e1", { importanceScore: 0.8 });

      const bySession = await em.query({ agentId: "agent-filter", sessionId: "session-a" });
      expect(bySession).toHaveLength(1);
      expect(bySession[0].sessionId).toBe("session-a");

      const byType = await em.query({ agentId: "agent-filter", eventTypes: ["error"] });
      expect(byType).toHaveLength(1);
      expect(byType[0].eventType).toBe("error");

      const byImportance = await em.query({ agentId: "agent-filter", minImportance: 0.5 });
      expect(byImportance).toHaveLength(1);
      expect(byImportance[0].content).toBe("e1");
    });

    it("edge: query() returns [] when no event matches agentId", async () => {
      expect(await em.query({ agentId: "agent-never-appended" })).toEqual([]);
    });

    it("edge: filters by timerangeStart/timerangeEnd (createdAt window)", async () => {
      await em.append("agent-range", "session-a", "decision", "before-window");
      await new Promise((r) => setTimeout(r, 5));
      const windowStart = new Date().toISOString();
      await em.append("agent-range", "session-a", "decision", "inside-window");
      await new Promise((r) => setTimeout(r, 5));
      const windowEnd = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      await em.append("agent-range", "session-a", "decision", "after-window");

      const windowed = await em.query({
        agentId: "agent-range",
        timerangeStart: windowStart,
        timerangeEnd: windowEnd,
      });
      expect(windowed).toHaveLength(1);
      expect(windowed[0]?.content).toBe("inside-window");
    });

    it("edge: sort tie-breaks by timestamp DESC when importanceScore is equal", async () => {
      await em.append("agent-tie", "session-a", "decision", "older", { importanceScore: 0.5 });
      await new Promise((r) => setTimeout(r, 5));
      await em.append("agent-tie", "session-a", "decision", "newer", { importanceScore: 0.5 });

      const results = await em.query({ agentId: "agent-tie" });
      expect(results.map((e) => e.content)).toEqual(["newer", "older"]);
    });

    it("error: append() rejects an empty string content", async () => {
      await expect(em.append("agent-err", "session-err", "decision", "   ")).rejects.toThrow(
        MemoryValidationError,
      );
    });

    it("error: query() rejects an empty agentId", async () => {
      await expect(em.query({ agentId: "" })).rejects.toThrow(MemoryValidationError);
    });

    it("compat: record() delegates to append() — legacy metadata round-trips through content", async () => {
      await em.record("agent-compat-append", "run-1", "cycle_started");
      await em.record("agent-compat-append", "run-2", "cycle_completed", { cycles: 3 });

      const events = await em.since("agent-compat-append", 0);
      const started = events.find((e) => e.event === "cycle_started");
      const completed = events.find((e) => e.event === "cycle_completed");
      expect(started?.metadata).toBeUndefined();
      expect(completed?.metadata).toEqual({ cycles: 3 });
    });
  });
});
