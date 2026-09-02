import { describe, expect, it } from "vitest";
import type { WorkingMemoryEntry } from "../src/ports/eviction-policy.js";
import {
  agentControlledPolicy,
  importanceWeightedPolicy,
  lruPolicy,
} from "../src/ports/eviction-policy.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<WorkingMemoryEntry> & { id: string }): WorkingMemoryEntry {
  return {
    content: null,
    lastAccessedAt: 1_000,
    importance: 0.5,
    ...overrides,
  };
}

const BASE_TIME = 1_000_000;

// ─── LRU Policy ──────────────────────────────────────────────────────────────

describe("lruPolicy", () => {
  it("returns [] when entries.length <= targetSize", () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" })];
    expect(lruPolicy.select(entries, 2)).toEqual([]);
    expect(lruPolicy.select(entries, 5)).toEqual([]);
  });

  it("returns [] for empty entries", () => {
    expect(lruPolicy.select([], 0)).toEqual([]);
    expect(lruPolicy.select([], 3)).toEqual([]);
  });

  it("evicts oldest lastAccessedAt first", () => {
    const entries = [
      makeEntry({ id: "new", lastAccessedAt: BASE_TIME + 300 }),
      makeEntry({ id: "old", lastAccessedAt: BASE_TIME + 100 }),
      makeEntry({ id: "mid", lastAccessedAt: BASE_TIME + 200 }),
    ];
    const evicted = lruPolicy.select(entries, 2);
    expect(evicted).toEqual(["old"]);
  });

  it("evicts multiple oldest entries when targetSize requires it", () => {
    const entries = [
      makeEntry({ id: "c", lastAccessedAt: BASE_TIME + 300 }),
      makeEntry({ id: "a", lastAccessedAt: BASE_TIME + 100 }),
      makeEntry({ id: "b", lastAccessedAt: BASE_TIME + 200 }),
    ];
    const evicted = lruPolicy.select(entries, 1);
    expect(evicted).toEqual(["a", "b"]);
  });

  it("never evicts pinned entries", () => {
    const entries = [
      makeEntry({ id: "pinned-old", lastAccessedAt: BASE_TIME + 100, pinned: true }),
      makeEntry({ id: "evictable", lastAccessedAt: BASE_TIME + 200 }),
      makeEntry({ id: "keep", lastAccessedAt: BASE_TIME + 300 }),
    ];
    // 3 entries, targetSize=2 → need to evict 1; pinned must not be chosen
    const evicted = lruPolicy.select(entries, 2);
    expect(evicted).not.toContain("pinned-old");
    expect(evicted).toEqual(["evictable"]);
  });

  it("breaks ties by id ASC", () => {
    const t = BASE_TIME;
    const entries = [
      makeEntry({ id: "z", lastAccessedAt: t }),
      makeEntry({ id: "a", lastAccessedAt: t }),
      makeEntry({ id: "m", lastAccessedAt: t }),
    ];
    const evicted = lruPolicy.select(entries, 1);
    // All same time → alphabetical, evict "a" and "m", keep "z"
    expect(evicted).toEqual(["a", "m"]);
  });

  it("is deterministic: same inputs same output", () => {
    const entries = [
      makeEntry({ id: "x", lastAccessedAt: BASE_TIME + 50 }),
      makeEntry({ id: "y", lastAccessedAt: BASE_TIME + 10 }),
      makeEntry({ id: "z", lastAccessedAt: BASE_TIME + 30 }),
    ];
    expect(lruPolicy.select(entries, 1)).toEqual(lruPolicy.select(entries, 1));
  });
});

// ─── ImportanceWeighted Policy ────────────────────────────────────────────────

describe("importanceWeightedPolicy", () => {
  it("returns [] when entries.length <= targetSize", () => {
    const entries = [makeEntry({ id: "a" })];
    const policy = importanceWeightedPolicy();
    expect(policy.select(entries, 1)).toEqual([]);
    expect(policy.select(entries, 5)).toEqual([]);
  });

  it("returns [] for empty entries", () => {
    expect(importanceWeightedPolicy().select([], 0)).toEqual([]);
  });

  it("evicts entry with lowest combined score (importance dominant)", () => {
    const t = BASE_TIME;
    // All same recency → score = 0.5*0.5 + 0.5*importance
    const entries = [
      makeEntry({ id: "high", lastAccessedAt: t, importance: 0.9 }),
      makeEntry({ id: "low", lastAccessedAt: t, importance: 0.1 }),
      makeEntry({ id: "mid", lastAccessedAt: t, importance: 0.5 }),
    ];
    const evicted = importanceWeightedPolicy().select(entries, 2);
    expect(evicted).toEqual(["low"]);
  });

  it("evicts entry with lowest score (recency dominant)", () => {
    // importance = same (0.5); older → lower recency → lower score
    const entries = [
      makeEntry({ id: "newest", lastAccessedAt: BASE_TIME + 300, importance: 0.5 }),
      makeEntry({ id: "oldest", lastAccessedAt: BASE_TIME + 100, importance: 0.5 }),
      makeEntry({ id: "middle", lastAccessedAt: BASE_TIME + 200, importance: 0.5 }),
    ];
    const evicted = importanceWeightedPolicy({ recencyWeight: 1, importanceWeight: 0 }).select(
      entries,
      2,
    );
    expect(evicted).toEqual(["oldest"]);
  });

  it("never evicts pinned entries", () => {
    const entries = [
      makeEntry({ id: "pinned-low", lastAccessedAt: BASE_TIME, importance: 0.0, pinned: true }),
      makeEntry({ id: "keep-high", lastAccessedAt: BASE_TIME + 500, importance: 0.9 }),
      makeEntry({ id: "evict-mid", lastAccessedAt: BASE_TIME + 250, importance: 0.3 }),
    ];
    const evicted = importanceWeightedPolicy().select(entries, 2);
    expect(evicted).not.toContain("pinned-low");
  });

  it("breaks ties by id ASC", () => {
    const t = BASE_TIME;
    // Identical entries → same score
    const entries = [
      makeEntry({ id: "z-entry", lastAccessedAt: t, importance: 0.5 }),
      makeEntry({ id: "a-entry", lastAccessedAt: t, importance: 0.5 }),
      makeEntry({ id: "m-entry", lastAccessedAt: t, importance: 0.5 }),
    ];
    const evicted = importanceWeightedPolicy().select(entries, 1);
    expect(evicted).toEqual(["a-entry", "m-entry"]);
  });

  it("respects custom weights", () => {
    // recencyWeight=0, importanceWeight=1 → pure importance sort
    const entries = [
      makeEntry({ id: "b", lastAccessedAt: BASE_TIME + 999, importance: 0.1 }),
      makeEntry({ id: "a", lastAccessedAt: BASE_TIME + 1, importance: 0.9 }),
    ];
    const policy = importanceWeightedPolicy({ recencyWeight: 0, importanceWeight: 1 });
    expect(policy.select(entries, 1)).toEqual(["b"]);
  });

  it("is deterministic: same inputs same output", () => {
    const entries = [
      makeEntry({ id: "x", lastAccessedAt: BASE_TIME + 10, importance: 0.3 }),
      makeEntry({ id: "y", lastAccessedAt: BASE_TIME + 20, importance: 0.7 }),
    ];
    const policy = importanceWeightedPolicy();
    expect(policy.select(entries, 0)).toEqual(policy.select(entries, 0));
  });
});

// ─── AgentControlled Policy ──────────────────────────────────────────────────

describe("agentControlledPolicy", () => {
  it("returns [] when entries.length <= targetSize", () => {
    const priorities = new Map([["agent-a", 10]]);
    const entries = [makeEntry({ id: "x", agentTag: "agent-a" })];
    expect(agentControlledPolicy(priorities).select(entries, 1)).toEqual([]);
    expect(agentControlledPolicy(priorities).select(entries, 5)).toEqual([]);
  });

  it("returns [] for empty entries", () => {
    expect(agentControlledPolicy(new Map()).select([], 0)).toEqual([]);
  });

  it("evicts entries with lowest priority first", () => {
    const priorities = new Map([
      ["high", 100],
      ["low", 1],
    ]);
    const entries = [
      makeEntry({ id: "h", agentTag: "high" }),
      makeEntry({ id: "l", agentTag: "low" }),
      makeEntry({ id: "m", agentTag: "mid" }), // not in map → priority 0
    ];
    const evicted = agentControlledPolicy(priorities).select(entries, 1);
    // lowest: "m" (0) and "l" (1) — evict 2, keep "h"
    expect(evicted).toEqual(["m", "l"]);
  });

  it("entries with no agentTag receive priority 0", () => {
    const priorities = new Map([["agent-a", 5]]);
    const entries = [
      makeEntry({ id: "tagged", agentTag: "agent-a" }),
      makeEntry({ id: "untagged" }), // no agentTag → priority 0
      makeEntry({ id: "keep", agentTag: "agent-a" }),
    ];
    const evicted = agentControlledPolicy(priorities).select(entries, 2);
    expect(evicted).toEqual(["untagged"]);
  });

  it("never evicts pinned entries", () => {
    const priorities = new Map([["low", 0]]);
    const entries = [
      makeEntry({ id: "pinned", agentTag: "low", pinned: true }),
      makeEntry({ id: "a", agentTag: "low" }),
      makeEntry({ id: "b", agentTag: "low" }),
    ];
    const evicted = agentControlledPolicy(priorities).select(entries, 2);
    expect(evicted).not.toContain("pinned");
    expect(evicted).toHaveLength(1);
  });

  it("breaks ties by id ASC", () => {
    // All same priority 0 (no agentTag)
    const entries = [makeEntry({ id: "z" }), makeEntry({ id: "a" }), makeEntry({ id: "m" })];
    const evicted = agentControlledPolicy(new Map()).select(entries, 1);
    expect(evicted).toEqual(["a", "m"]);
  });

  it("is deterministic: same inputs same output", () => {
    const p = new Map([
      ["x", 3],
      ["y", 7],
    ]);
    const entries = [
      makeEntry({ id: "1", agentTag: "x" }),
      makeEntry({ id: "2", agentTag: "y" }),
      makeEntry({ id: "3" }),
    ];
    const policy = agentControlledPolicy(p);
    expect(policy.select(entries, 1)).toEqual(policy.select(entries, 1));
  });

  it("evicts entries whose tag is not in priorities map (priority 0)", () => {
    const priorities = new Map([["known", 10]]);
    const entries = [
      makeEntry({ id: "k", agentTag: "known" }),
      makeEntry({ id: "u", agentTag: "unknown" }), // not in map → 0
      makeEntry({ id: "n" }), // no tag → 0
    ];
    const evicted = agentControlledPolicy(priorities).select(entries, 1);
    // "k" has priority 10, "u" and "n" have 0 → evict "n" and "u" (alphabetical tie)
    expect(evicted).toEqual(["n", "u"]);
  });
});
