import { describe, expect, it } from "vitest";
import {
  type EvictionPolicy,
  type WorkingMemoryEntry,
  agentControlledPolicy,
  importanceWeightedPolicy,
  lruPolicy,
} from "../src/ports/eviction-policy.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

let _idSeq = 0;

function makeEntry(overrides: Partial<WorkingMemoryEntry> = {}): WorkingMemoryEntry {
  return {
    id: `entry-${++_idSeq}`,
    content: "some content",
    lastAccessedAt: Date.now(),
    importance: 0.5,
    ...overrides,
  };
}

function ids(entries: WorkingMemoryEntry[]): string[] {
  return entries.map((e) => e.id);
}

// ─── lruPolicy ────────────────────────────────────────────────────────────────

describe("lruPolicy", () => {
  it("has a non-empty name", () => {
    expect(lruPolicy.name).toBe("lru");
    expect(lruPolicy.name.length).toBeGreaterThan(0);
  });

  it("returns [] for empty entries", () => {
    expect(lruPolicy.select([], 5)).toEqual([]);
  });

  it("returns [] when count equals targetSize", () => {
    const entries = [makeEntry(), makeEntry(), makeEntry()];
    expect(lruPolicy.select(entries, 3)).toEqual([]);
  });

  it("returns [] when count is below targetSize", () => {
    const entries = [makeEntry(), makeEntry()];
    expect(lruPolicy.select(entries, 10)).toEqual([]);
  });

  it("returns exactly (count - targetSize) ids to evict", () => {
    const entries = Array.from({ length: 5 }, () => makeEntry());
    const result = lruPolicy.select(entries, 2);
    expect(result).toHaveLength(3);
  });

  it("evicts entries with the oldest lastAccessedAt first", () => {
    const old = makeEntry({ id: "old", lastAccessedAt: 100 });
    const mid = makeEntry({ id: "mid", lastAccessedAt: 500 });
    const fresh = makeEntry({ id: "fresh", lastAccessedAt: 1000 });
    // targetSize=2, so 1 must be evicted
    const result = lruPolicy.select([fresh, old, mid], 2);
    expect(result).toEqual(["old"]);
  });

  it("keeps the most recently accessed entries", () => {
    const oldest = makeEntry({ id: "a", lastAccessedAt: 1 });
    const old = makeEntry({ id: "b", lastAccessedAt: 10 });
    const fresh = makeEntry({ id: "c", lastAccessedAt: 100 });
    const result = lruPolicy.select([oldest, old, fresh], 1);
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).not.toContain("c");
  });

  it("never evicts pinned entries", () => {
    const pinned = makeEntry({ id: "pinned", lastAccessedAt: 1, pinned: true });
    const normal = makeEntry({ id: "normal", lastAccessedAt: 1000 });
    // 2 entries, targetSize=1: must evict 1; pinned must be spared
    const result = lruPolicy.select([pinned, normal], 1);
    expect(result).not.toContain("pinned");
    expect(result).toContain("normal");
  });

  it("skips pinned entry even when it is the oldest", () => {
    const pinnedOldest = makeEntry({
      id: "p",
      lastAccessedAt: 0,
      pinned: true,
    });
    const a = makeEntry({ id: "a", lastAccessedAt: 10 });
    const b = makeEntry({ id: "b", lastAccessedAt: 20 });
    const result = lruPolicy.select([pinnedOldest, a, b], 2);
    expect(result).not.toContain("p");
    expect(result).toContain("a");
  });

  it("is deterministic: same input produces same output", () => {
    const entries = [
      makeEntry({ id: "x1", lastAccessedAt: 50 }),
      makeEntry({ id: "x2", lastAccessedAt: 50 }),
      makeEntry({ id: "x3", lastAccessedAt: 50 }),
    ];
    const r1 = lruPolicy.select(entries, 1);
    const r2 = lruPolicy.select(entries, 1);
    expect(r1).toEqual(r2);
  });

  it("breaks ties by id ASC", () => {
    const same = 500;
    const a = makeEntry({ id: "aaa", lastAccessedAt: same });
    const b = makeEntry({ id: "bbb", lastAccessedAt: same });
    const c = makeEntry({ id: "ccc", lastAccessedAt: same });
    // 3 entries, targetSize=2: evict 1 — must be "aaa" (smallest id)
    const result = lruPolicy.select([c, b, a], 2);
    expect(result).toEqual(["aaa"]);
  });

  it("returns all evictable ids when targetSize is 0", () => {
    const entries = [makeEntry({ id: "e1" }), makeEntry({ id: "e2" })];
    const result = lruPolicy.select(entries, 0);
    expect(result).toHaveLength(2);
  });

  it("all-pinned entries with overflow returns [] (nothing to evict)", () => {
    const pinned1 = makeEntry({ id: "p1", pinned: true, lastAccessedAt: 1 });
    const pinned2 = makeEntry({ id: "p2", pinned: true, lastAccessedAt: 2 });
    const pinned3 = makeEntry({ id: "p3", pinned: true, lastAccessedAt: 3 });
    // 3 entries, targetSize=1 → would need to evict 2, but all pinned
    const result = lruPolicy.select([pinned1, pinned2, pinned3], 1);
    expect(result).toEqual([]);
  });
});

// ─── importanceWeightedPolicy ─────────────────────────────────────────────────

describe("importanceWeightedPolicy (default weights)", () => {
  it("has name 'importance-weighted'", () => {
    expect(importanceWeightedPolicy().name).toBe("importance-weighted");
  });

  it("returns [] for empty entries", () => {
    expect(importanceWeightedPolicy().select([], 5)).toEqual([]);
  });

  it("returns [] when count <= targetSize", () => {
    const entries = [makeEntry(), makeEntry()];
    expect(importanceWeightedPolicy().select(entries, 5)).toEqual([]);
  });

  it("evicts lowest importance entry first (equal recency)", () => {
    const t = Date.now();
    const low = makeEntry({ id: "low", importance: 0.1, lastAccessedAt: t });
    const mid = makeEntry({ id: "mid", importance: 0.5, lastAccessedAt: t });
    const high = makeEntry({ id: "high", importance: 0.9, lastAccessedAt: t });
    const result = importanceWeightedPolicy().select([high, low, mid], 2);
    expect(result).toContain("low");
    expect(result).not.toContain("high");
  });

  it("never evicts highest importance entry when others available", () => {
    const t = Date.now();
    const entries = [
      makeEntry({ id: "v1", importance: 0.1, lastAccessedAt: t }),
      makeEntry({ id: "v2", importance: 0.3, lastAccessedAt: t }),
      makeEntry({ id: "v3", importance: 1.0, lastAccessedAt: t }),
    ];
    const result = importanceWeightedPolicy().select(entries, 1);
    expect(result).not.toContain("v3");
    expect(result).toContain("v1");
  });

  it("never evicts pinned entries", () => {
    const t = Date.now();
    const pinned = makeEntry({
      id: "pinned",
      importance: 0.0,
      pinned: true,
      lastAccessedAt: t,
    });
    const normal = makeEntry({
      id: "norm",
      importance: 0.9,
      lastAccessedAt: t,
    });
    const result = importanceWeightedPolicy().select([pinned, normal], 1);
    expect(result).not.toContain("pinned");
    expect(result).toContain("norm");
  });

  it("returns exactly (count - targetSize) entries", () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry({ id: `w${i}`, importance: i / 10, lastAccessedAt: Date.now() }),
    );
    const result = importanceWeightedPolicy().select(entries, 2);
    expect(result).toHaveLength(4);
  });

  it("is deterministic", () => {
    const t = 1000;
    const entries = [
      makeEntry({ id: "d1", importance: 0.4, lastAccessedAt: t }),
      makeEntry({ id: "d2", importance: 0.4, lastAccessedAt: t }),
      makeEntry({ id: "d3", importance: 0.9, lastAccessedAt: t }),
    ];
    const r1 = importanceWeightedPolicy().select(entries, 1);
    const r2 = importanceWeightedPolicy().select(entries, 1);
    expect(r1).toEqual(r2);
  });

  it("breaks ties by id ASC", () => {
    const t = Date.now();
    const a = makeEntry({ id: "aaa", importance: 0.2, lastAccessedAt: t });
    const b = makeEntry({ id: "bbb", importance: 0.2, lastAccessedAt: t });
    const c = makeEntry({ id: "ccc", importance: 0.8, lastAccessedAt: t });
    const result = importanceWeightedPolicy().select([b, a, c], 2);
    expect(result).toEqual(["aaa"]);
  });

  it("recency contributes when importanceWeight=0", () => {
    const low = makeEntry({ id: "old", importance: 0.9, lastAccessedAt: 10 });
    const high = makeEntry({
      id: "new",
      importance: 0.1,
      lastAccessedAt: 9999,
    });
    // recencyWeight=1, importanceWeight=0: evict least recent
    const policy = importanceWeightedPolicy({
      recencyWeight: 1,
      importanceWeight: 0,
    });
    const result = policy.select([low, high], 1);
    expect(result).toContain("old");
    expect(result).not.toContain("new");
  });

  it("importance dominates when recencyWeight=0", () => {
    const now = Date.now();
    const stale = makeEntry({
      id: "stale",
      importance: 0.95,
      lastAccessedAt: 1,
    });
    const fresh = makeEntry({
      id: "fresh",
      importance: 0.05,
      lastAccessedAt: now,
    });
    // recencyWeight=0: only importance matters, evict lowest importance
    const policy = importanceWeightedPolicy({
      recencyWeight: 0,
      importanceWeight: 1,
    });
    const result = policy.select([stale, fresh], 1);
    expect(result).toContain("fresh");
    expect(result).not.toContain("stale");
  });

  it("single entry with equal time range falls back to importance score", () => {
    const t = 500;
    const entries = [
      makeEntry({ id: "s1", importance: 0.2, lastAccessedAt: t }),
      makeEntry({ id: "s2", importance: 0.2, lastAccessedAt: t }),
      makeEntry({ id: "s3", importance: 0.2, lastAccessedAt: t }),
    ];
    // normalizedRecency = 0.5 for all (timeRange = 0), score = 0.5*0.5 + 0.5*0.2 = 0.35
    const result = importanceWeightedPolicy().select(entries, 1);
    expect(result).toHaveLength(2);
    // tie broken by id ASC
    expect(result[0]).toBe("s1");
    expect(result[1]).toBe("s2");
  });
});

// ─── agentControlledPolicy ────────────────────────────────────────────────────

describe("agentControlledPolicy", () => {
  it("has name 'agent-controlled'", () => {
    const policy = agentControlledPolicy(new Map());
    expect(policy.name).toBe("agent-controlled");
  });

  it("returns [] for empty entries", () => {
    const policy = agentControlledPolicy(new Map([["a", 5]]));
    expect(policy.select([], 3)).toEqual([]);
  });

  it("returns [] when count <= targetSize", () => {
    const policy = agentControlledPolicy(new Map());
    const entries = [makeEntry(), makeEntry()];
    expect(policy.select(entries, 5)).toEqual([]);
  });

  it("evicts lowest priority agent's entries first", () => {
    const priorities = new Map([
      ["high-agent", 10],
      ["low-agent", 1],
    ]);
    const policy = agentControlledPolicy(priorities);
    const high = makeEntry({ id: "h1", agentTag: "high-agent" });
    const low = makeEntry({ id: "l1", agentTag: "low-agent" });
    const result = policy.select([high, low], 1);
    expect(result).toContain("l1");
    expect(result).not.toContain("h1");
  });

  it("entries with no agentTag receive default priority 0", () => {
    const priorities = new Map([["important-agent", 100]]);
    const policy = agentControlledPolicy(priorities);
    const untagged = makeEntry({ id: "u1" });
    const tagged = makeEntry({ id: "t1", agentTag: "important-agent" });
    const result = policy.select([untagged, tagged], 1);
    expect(result).toContain("u1");
    expect(result).not.toContain("t1");
  });

  it("entries with unknown agentTag receive default priority 0", () => {
    const priorities = new Map([["known-agent", 50]]);
    const policy = agentControlledPolicy(priorities);
    const unknown = makeEntry({ id: "unk", agentTag: "unknown-agent" });
    const known = makeEntry({ id: "k1", agentTag: "known-agent" });
    const result = policy.select([unknown, known], 1);
    expect(result).toContain("unk");
    expect(result).not.toContain("k1");
  });

  it("never evicts pinned entries", () => {
    const priorities = new Map<string, number>();
    const policy = agentControlledPolicy(priorities);
    const pinned = makeEntry({ id: "pinn", pinned: true });
    const normal = makeEntry({ id: "norm" });
    const result = policy.select([pinned, normal], 1);
    expect(result).not.toContain("pinn");
    expect(result).toContain("norm");
  });

  it("breaks ties by id ASC", () => {
    const policy = agentControlledPolicy(new Map());
    const a = makeEntry({ id: "aaa" });
    const b = makeEntry({ id: "bbb" });
    const c = makeEntry({ id: "ccc" });
    // 3 entries, targetSize=2: evict 1 — must be "aaa" (smallest id, lowest priority tie)
    const result = policy.select([c, a, b], 2);
    expect(result).toEqual(["aaa"]);
  });

  it("is deterministic", () => {
    const priorities = new Map([
      ["agent-a", 1],
      ["agent-b", 2],
    ]);
    const policy = agentControlledPolicy(priorities);
    const entries = [
      makeEntry({ id: "i1", agentTag: "agent-a" }),
      makeEntry({ id: "i2", agentTag: "agent-b" }),
      makeEntry({ id: "i3", agentTag: "agent-a" }),
    ];
    const r1 = policy.select(entries, 1);
    const r2 = policy.select(entries, 1);
    expect(r1).toEqual(r2);
  });

  it("evicts multiple entries across agents in priority order", () => {
    const priorities = new Map([
      ["high", 10],
      ["mid", 5],
      ["low", 1],
    ]);
    const policy = agentControlledPolicy(priorities);
    const h1 = makeEntry({ id: "h1", agentTag: "high" });
    const m1 = makeEntry({ id: "m1", agentTag: "mid" });
    const l1 = makeEntry({ id: "l1", agentTag: "low" });
    const l2 = makeEntry({ id: "l2", agentTag: "low" });
    // 4 entries, targetSize=2: evict 2, both should be low-priority
    const result = policy.select([h1, m1, l1, l2], 2);
    expect(result).toContain("l1");
    expect(result).toContain("l2");
    expect(result).not.toContain("h1");
    expect(result).not.toContain("m1");
  });

  it("returns exactly (count - targetSize) ids", () => {
    const policy = agentControlledPolicy(new Map([["a", 1]]));
    const entries = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ id: `ent-${i}`, agentTag: "a" }),
    );
    const result = policy.select(entries, 3);
    expect(result).toHaveLength(4);
  });
});

// ─── Cross-policy structural contract ─────────────────────────────────────────

describe("EvictionPolicy contract (all policies)", () => {
  const policies: EvictionPolicy[] = [
    lruPolicy,
    importanceWeightedPolicy(),
    importanceWeightedPolicy({ recencyWeight: 0.8, importanceWeight: 0.2 }),
    agentControlledPolicy(new Map([["x", 3]])),
  ];

  for (const policy of policies) {
    it(`${policy.name}: name is a non-empty string`, () => {
      expect(typeof policy.name).toBe("string");
      expect(policy.name.length).toBeGreaterThan(0);
    });

    it(`${policy.name}: empty input returns []`, () => {
      expect(policy.select([], 5)).toEqual([]);
    });

    it(`${policy.name}: count <= targetSize returns []`, () => {
      const entries = [makeEntry(), makeEntry()];
      expect(policy.select(entries, 2)).toEqual([]);
      expect(policy.select(entries, 10)).toEqual([]);
    });

    it(`${policy.name}: evicts correct count`, () => {
      const entries = Array.from({ length: 5 }, () => makeEntry());
      const result = policy.select(entries, 2);
      expect(result).toHaveLength(3);
    });

    it(`${policy.name}: returned ids are subset of input ids`, () => {
      const entries = Array.from({ length: 5 }, () => makeEntry());
      const inputIds = new Set(ids(entries));
      const result = policy.select(entries, 2);
      for (const id of result) {
        expect(inputIds.has(id)).toBe(true);
      }
    });

    it(`${policy.name}: no duplicates in result`, () => {
      const entries = Array.from({ length: 5 }, () => makeEntry());
      const result = policy.select(entries, 2);
      expect(result.length).toBe(new Set(result).size);
    });
  }
});
