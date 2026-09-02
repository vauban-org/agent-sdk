import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENCY_HALFLIFE_MS,
  DEFAULT_RRF_WEIGHTS,
  cosineSimilarity,
  recallEpisodicRrf,
  recencyScore,
  scoreEntries,
} from "../src/memory/episodic-rrf.js";
import type { EpisodicMemoryEntry, RrfScorers } from "../src/memory/episodic-rrf.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SimpleEntry {
  id: number;
  label: string;
}

function makeEntry(id: number): SimpleEntry {
  return { id, label: `entry ${id}` };
}

function makeScorers(
  opts: {
    cosine?: number;
    timestamp?: number;
    importance?: number;
  } = {},
): RrfScorers<SimpleEntry> {
  return {
    cosine: () => opts.cosine ?? 0.5,
    timestamp: () => opts.timestamp ?? Date.now(),
    importance: () => opts.importance ?? 0.5,
  };
}

const FIXED_NOW = 1_700_000_000_000;

function fixedNow(): () => number {
  return () => FIXED_NOW;
}

function makeEpisodicEntry(overrides: Partial<EpisodicMemoryEntry> = {}): EpisodicMemoryEntry {
  return {
    agentId: "agent-1",
    runId: "run-1",
    event: "test-event",
    timestamp: FIXED_NOW,
    ...overrides,
  };
}

// ─── DEFAULT_RRF_WEIGHTS ──────────────────────────────────────────────────────

describe("DEFAULT_RRF_WEIGHTS", () => {
  it("cosine weight is 0.5", () => {
    expect(DEFAULT_RRF_WEIGHTS.cosine).toBe(0.5);
  });

  it("recency weight is 0.3", () => {
    expect(DEFAULT_RRF_WEIGHTS.recency).toBe(0.3);
  });

  it("importance weight is 0.2", () => {
    expect(DEFAULT_RRF_WEIGHTS.importance).toBe(0.2);
  });

  it("weights sum to exactly 1.0", () => {
    const sum =
      DEFAULT_RRF_WEIGHTS.cosine + DEFAULT_RRF_WEIGHTS.recency + DEFAULT_RRF_WEIGHTS.importance;
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

// ─── DEFAULT_RECENCY_HALFLIFE_MS ──────────────────────────────────────────────

describe("DEFAULT_RECENCY_HALFLIFE_MS", () => {
  it("equals 14 days in milliseconds", () => {
    expect(DEFAULT_RECENCY_HALFLIFE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns 0 for empty arrays", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it("returns 0 for zero-norm vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns correct value for general vectors", () => {
    const sim = cosineSimilarity([3, 4], [3, 4]);
    expect(sim).toBeCloseTo(1.0);
  });
});

// ─── recencyScore ─────────────────────────────────────────────────────────────

describe("recencyScore", () => {
  it("returns 1.0 when timestamp equals now", () => {
    expect(recencyScore(FIXED_NOW, FIXED_NOW, DEFAULT_RECENCY_HALFLIFE_MS)).toBeCloseTo(1.0);
  });

  it("returns 0.5 at exactly one half-life", () => {
    const ts = FIXED_NOW - DEFAULT_RECENCY_HALFLIFE_MS;
    expect(recencyScore(FIXED_NOW, ts, DEFAULT_RECENCY_HALFLIFE_MS)).toBeCloseTo(0.5);
  });

  it("returns 1.0 for future timestamp (clamps to 0 delta)", () => {
    expect(recencyScore(FIXED_NOW, FIXED_NOW + 1_000, DEFAULT_RECENCY_HALFLIFE_MS)).toBeCloseTo(
      1.0,
    );
  });

  it("returns 0 for halflife <= 0", () => {
    expect(recencyScore(FIXED_NOW, FIXED_NOW, 0)).toBe(0);
    expect(recencyScore(FIXED_NOW, FIXED_NOW, -1)).toBe(0);
  });

  it("decays monotonically with increasing age", () => {
    const h = DEFAULT_RECENCY_HALFLIFE_MS;
    const s0 = recencyScore(FIXED_NOW, FIXED_NOW, h);
    const s1 = recencyScore(FIXED_NOW, FIXED_NOW - h, h);
    const s2 = recencyScore(FIXED_NOW, FIXED_NOW - 2 * h, h);
    expect(s0).toBeGreaterThan(s1);
    expect(s1).toBeGreaterThan(s2);
  });
});

// ─── scoreEntries ─────────────────────────────────────────────────────────────

describe("scoreEntries", () => {
  it("returns empty array for empty input", () => {
    const result = scoreEntries<SimpleEntry>([], makeScorers(), {
      now: fixedNow(),
    });
    expect(result).toEqual([]);
  });

  it("returns one ScoredEntry for a single entry", () => {
    const result = scoreEntries([makeEntry(1)], makeScorers(), {
      now: fixedNow(),
    });
    expect(result).toHaveLength(1);
  });

  it("ScoredEntry has entry, score, and components fields", () => {
    const entry = makeEntry(1);
    const [scored] = scoreEntries([entry], makeScorers(), { now: fixedNow() });
    expect(scored).toHaveProperty("entry");
    expect(scored).toHaveProperty("score");
    expect(scored).toHaveProperty("components");
  });

  it("components has cosine, recency, and importance fields", () => {
    const [scored] = scoreEntries([makeEntry(1)], makeScorers(), {
      now: fixedNow(),
    });
    expect(scored!.components).toHaveProperty("cosine");
    expect(scored!.components).toHaveProperty("recency");
    expect(scored!.components).toHaveProperty("importance");
  });

  it("higher cosine input yields higher total score (other signals equal)", () => {
    const scorersHigh = makeScorers({
      cosine: 0.9,
      timestamp: FIXED_NOW,
      importance: 0.5,
    });
    const scorersLow = makeScorers({
      cosine: 0.1,
      timestamp: FIXED_NOW,
      importance: 0.5,
    });
    const [high] = scoreEntries([makeEntry(1)], scorersHigh, {
      now: fixedNow(),
    });
    const [low] = scoreEntries([makeEntry(1)], scorersLow, { now: fixedNow() });
    expect(high!.score).toBeGreaterThan(low!.score);
  });

  it("recent timestamp yields higher recency component than old timestamp", () => {
    const recentScorers = makeScorers({ timestamp: FIXED_NOW });
    const oldScorers = makeScorers({
      timestamp: FIXED_NOW - 30 * 24 * 60 * 60 * 1000,
    });
    const [recent] = scoreEntries([makeEntry(1)], recentScorers, {
      now: fixedNow(),
    });
    const [old] = scoreEntries([makeEntry(1)], oldScorers, { now: fixedNow() });
    expect(recent!.components.recency).toBeGreaterThan(old!.components.recency);
  });

  it("higher importance input yields higher total score (other signals equal)", () => {
    const highImp = makeScorers({
      cosine: 0.5,
      timestamp: FIXED_NOW,
      importance: 0.9,
    });
    const lowImp = makeScorers({
      cosine: 0.5,
      timestamp: FIXED_NOW,
      importance: 0.1,
    });
    const [high] = scoreEntries([makeEntry(1)], highImp, { now: fixedNow() });
    const [low] = scoreEntries([makeEntry(1)], lowImp, { now: fixedNow() });
    expect(high!.score).toBeGreaterThan(low!.score);
  });

  it("topK=1 returns only the single highest-scored entry from 3", () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const call = 0;
    const scorers: RrfScorers<SimpleEntry> = {
      cosine: (e) => (e.id === 2 ? 0.9 : 0.1),
      timestamp: () => FIXED_NOW,
      importance: () => 0.5,
    };
    const result = scoreEntries(entries, scorers, { topK: 1, now: fixedNow() });
    expect(result).toHaveLength(1);
    expect(result[0]!.entry.id).toBe(2);
  });

  it("topK=2 returns exactly 2 entries from 3", () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const result = scoreEntries(entries, makeScorers(), {
      topK: 2,
      now: fixedNow(),
    });
    expect(result).toHaveLength(2);
  });

  it("results are sorted by score descending", () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const scorers: RrfScorers<SimpleEntry> = {
      cosine: (e) => e.id * 0.1,
      timestamp: () => FIXED_NOW,
      importance: () => 0.5,
    };
    const result = scoreEntries(entries, scorers, { now: fixedNow() });
    expect(result[0]!.score).toBeGreaterThanOrEqual(result[1]!.score);
    expect(result[1]!.score).toBeGreaterThanOrEqual(result[2]!.score);
  });

  it("score is always >= 0 (no negative total scores)", () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const scorers = makeScorers({
      cosine: 0,
      importance: 0,
      timestamp: FIXED_NOW,
    });
    const result = scoreEntries(entries, scorers, { now: fixedNow() });
    for (const s of result) {
      expect(s.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("entry with negative timestamp is dropped", () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const scorers: RrfScorers<SimpleEntry> = {
      cosine: () => 0.5,
      timestamp: (e) => (e.id === 1 ? -1 : FIXED_NOW),
      importance: () => 0.5,
    };
    const result = scoreEntries(entries, scorers, { now: fixedNow() });
    expect(result).toHaveLength(1);
    expect(result[0]!.entry.id).toBe(2);
  });

  it("now() injection produces deterministic recency regardless of wall clock", () => {
    const scorers = makeScorers({
      cosine: 0,
      importance: 0,
      timestamp: FIXED_NOW,
    });
    const r1 = scoreEntries([makeEntry(1)], scorers, {
      now: () => FIXED_NOW + 1000,
    });
    const r2 = scoreEntries([makeEntry(1)], scorers, {
      now: () => FIXED_NOW + 1000,
    });
    expect(r1[0]!.components.recency).toBe(r2[0]!.components.recency);
  });

  it("custom weights: cosine=1, recency=0, importance=0 → score equals cosine component", () => {
    const cosineVal = 0.77;
    const scorers = makeScorers({
      cosine: cosineVal,
      timestamp: FIXED_NOW,
      importance: 0.5,
    });
    const [scored] = scoreEntries([makeEntry(1)], scorers, {
      weights: { cosine: 1, recency: 0, importance: 0 },
      now: fixedNow(),
    });
    expect(scored!.score).toBeCloseTo(cosineVal);
  });

  it("non-finite cosine value is clamped to 0 in components", () => {
    const scorers: RrfScorers<SimpleEntry> = {
      cosine: () => Number.NaN,
      timestamp: () => FIXED_NOW,
      importance: () => 0.5,
    };
    const [scored] = scoreEntries([makeEntry(1)], scorers, { now: fixedNow() });
    expect(scored!.components.cosine).toBe(0);
  });

  it("negative cosine value is clamped to 0 (no negative cosine contribution)", () => {
    const scorers = makeScorers({
      cosine: -0.9,
      timestamp: FIXED_NOW,
      importance: 0.5,
    });
    const [scored] = scoreEntries([makeEntry(1)], scorers, { now: fixedNow() });
    expect(scored!.components.cosine).toBe(0);
  });

  it("importance > 1 is clamped to 1 in components", () => {
    const scorers = makeScorers({
      importance: 5.0,
      cosine: 0,
      timestamp: FIXED_NOW,
    });
    const [scored] = scoreEntries([makeEntry(1)], scorers, { now: fixedNow() });
    expect(scored!.components.importance).toBe(1);
  });

  it("importance < 0 is clamped to 0 in components", () => {
    const scorers = makeScorers({
      importance: -2.0,
      cosine: 0,
      timestamp: FIXED_NOW,
    });
    const [scored] = scoreEntries([makeEntry(1)], scorers, { now: fixedNow() });
    expect(scored!.components.importance).toBe(0);
  });

  it("multiple entries are correctly ordered by weighted score", () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const scorers: RrfScorers<SimpleEntry> = {
      cosine: (e) => (e.id === 3 ? 0.95 : 0.1),
      timestamp: () => FIXED_NOW,
      importance: () => 0.5,
    };
    const result = scoreEntries(entries, scorers, { now: fixedNow() });
    expect(result[0]!.entry.id).toBe(3);
  });

  it("entries field on ScoredEntry references the original entry object", () => {
    const original = makeEntry(42);
    const [scored] = scoreEntries([original], makeScorers(), {
      now: fixedNow(),
    });
    expect(scored!.entry).toBe(original);
  });

  it("topK=0 returns empty array", () => {
    const result = scoreEntries([makeEntry(1), makeEntry(2)], makeScorers(), {
      topK: 0,
      now: fixedNow(),
    });
    expect(result).toHaveLength(0);
  });
});

// ─── recallEpisodicRrf ────────────────────────────────────────────────────────

describe("recallEpisodicRrf", () => {
  it("returns empty array for empty input", () => {
    const result = recallEpisodicRrf([]);
    expect(result).toEqual([]);
  });

  it("uses entry.timestamp for recency scoring", () => {
    const recent = makeEpisodicEntry({ timestamp: FIXED_NOW, runId: "recent" });
    const old = makeEpisodicEntry({
      timestamp: FIXED_NOW - 60 * 24 * 60 * 60 * 1000,
      runId: "old",
    });
    const result = recallEpisodicRrf([old, recent], { now: fixedNow() });
    expect(result[0]!.entry.runId).toBe("recent");
  });

  it("uses metadata.importance when numeric", () => {
    const hi = makeEpisodicEntry({
      metadata: { importance: 0.9 },
      runId: "hi",
    });
    const lo = makeEpisodicEntry({
      metadata: { importance: 0.1 },
      runId: "lo",
    });
    const result = recallEpisodicRrf([lo, hi], {
      now: fixedNow(),
      weights: { cosine: 0, recency: 0, importance: 1 },
    });
    expect(result[0]!.entry.runId).toBe("hi");
  });

  it("falls back to 0.5 importance when metadata.importance is not numeric", () => {
    const entry = makeEpisodicEntry({ metadata: { importance: "high" } });
    const [scored] = recallEpisodicRrf([entry], { now: fixedNow() });
    expect(scored!.components.importance).toBe(0.5);
  });

  it("falls back to 0.5 importance when metadata is absent", () => {
    const entry = makeEpisodicEntry({ metadata: undefined });
    const [scored] = recallEpisodicRrf([entry], { now: fixedNow() });
    expect(scored!.components.importance).toBe(0.5);
  });

  it("accepts custom cosine scorer via opts.cosine", () => {
    const entry = makeEpisodicEntry({});
    const [scored] = recallEpisodicRrf([entry], {
      cosine: () => 0.8,
      now: fixedNow(),
      weights: { cosine: 1, recency: 0, importance: 0 },
    });
    expect(scored!.components.cosine).toBeCloseTo(0.8);
  });

  it("defaults cosine to 0 when no cosine scorer is provided", () => {
    const entry = makeEpisodicEntry({});
    const [scored] = recallEpisodicRrf([entry], { now: fixedNow() });
    expect(scored!.components.cosine).toBe(0);
  });

  it("respects topK option", () => {
    const entries = [
      makeEpisodicEntry({ runId: "a" }),
      makeEpisodicEntry({ runId: "b" }),
      makeEpisodicEntry({ runId: "c" }),
    ];
    const result = recallEpisodicRrf(entries, { topK: 2, now: fixedNow() });
    expect(result).toHaveLength(2);
  });
});
