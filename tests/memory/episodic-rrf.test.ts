/**
 * Tests for episodic memory RRF-style recall.
 *
 * Coverage:
 *   - cosineSimilarity: nominal, zero-norm, mismatched length, empty
 *   - recencyScore: t=0, t=halflife, t>>halflife, future timestamp
 *   - scoreEntries: weighting, sort order, topK, drop on negative ts
 *   - recallEpisodicRrf: default importance 0.5, metadata override
 *   - weight overrides, halflife override
 *
 * @see ../../src/memory/episodic-rrf.ts
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENCY_HALFLIFE_MS,
  DEFAULT_RRF_WEIGHTS,
  cosineSimilarity,
  recallEpisodicRrf,
  recencyScore,
  scoreEntries,
} from "../../src/memory/episodic-rrf.js";
import type { EpisodicMemoryEntry } from "../../src/ports/brain.js";

// ─── cosineSimilarity ────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it("returns 0 for zero-norm vector (safe)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it("returns 0 for mismatched length (safe)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for empty vectors (safe)", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ─── recencyScore ────────────────────────────────────────────────────────────

describe("recencyScore", () => {
  it("returns 1 at Δt=0", () => {
    expect(recencyScore(1000, 1000, 100)).toBeCloseTo(1, 6);
  });

  it("returns 0.5 at Δt = halflife", () => {
    expect(recencyScore(1100, 1000, 100)).toBeCloseTo(0.5, 6);
  });

  it("returns ~0.25 at Δt = 2 × halflife", () => {
    expect(recencyScore(1200, 1000, 100)).toBeCloseTo(0.25, 6);
  });

  it("clamps future timestamps to 1.0", () => {
    expect(recencyScore(1000, 1100, 100)).toBeCloseTo(1, 6);
  });

  it("returns 0 for non-positive halflife (defensive)", () => {
    expect(recencyScore(1000, 0, 0)).toBe(0);
    expect(recencyScore(1000, 0, -1)).toBe(0);
  });
});

// ─── scoreEntries ────────────────────────────────────────────────────────────

interface T {
  id: string;
  ts: number;
  cos: number;
  imp: number;
}

const baseScorers = {
  cosine: (e: T) => e.cos,
  timestamp: (e: T) => e.ts,
  importance: (e: T) => e.imp,
};

describe("scoreEntries", () => {
  it("ranks entries by descending score (default weights)", () => {
    const now = 10_000_000;
    const entries: T[] = [
      { id: "lowest", ts: now - 1_000_000, cos: 0.1, imp: 0.1 },
      { id: "highest", ts: now, cos: 1.0, imp: 1.0 },
      { id: "mid", ts: now - 500_000, cos: 0.5, imp: 0.5 },
    ];
    const scored = scoreEntries(entries, baseScorers, { now: () => now });
    expect(scored.map((s) => s.entry.id)).toEqual(["highest", "mid", "lowest"]);
  });

  it("respects topK", () => {
    const now = 10_000_000;
    const entries: T[] = [
      { id: "a", ts: now, cos: 0.1, imp: 0.1 },
      { id: "b", ts: now, cos: 0.5, imp: 0.5 },
      { id: "c", ts: now, cos: 0.9, imp: 0.9 },
    ];
    const top = scoreEntries(entries, baseScorers, {
      now: () => now,
      topK: 2,
    });
    expect(top.map((s) => s.entry.id)).toEqual(["c", "b"]);
  });

  it("drops entries with negative timestamp", () => {
    const now = 10_000_000;
    const entries: T[] = [
      { id: "a", ts: -1, cos: 1, imp: 1 },
      { id: "b", ts: now, cos: 0.5, imp: 0.5 },
    ];
    const scored = scoreEntries(entries, baseScorers, { now: () => now });
    expect(scored.map((s) => s.entry.id)).toEqual(["b"]);
  });

  it("clamps importance > 1 to 1", () => {
    const now = 10_000_000;
    const entries: T[] = [{ id: "x", ts: now, cos: 0, imp: 5 }];
    const scored = scoreEntries(entries, baseScorers, { now: () => now });
    expect(scored[0]!.components.importance).toBe(1);
  });

  it("clamps negative cosine to 0", () => {
    const now = 10_000_000;
    const entries: T[] = [{ id: "x", ts: now, cos: -0.7, imp: 0.5 }];
    const scored = scoreEntries(entries, baseScorers, { now: () => now });
    expect(scored[0]!.components.cosine).toBe(0);
  });

  it("ignores non-finite cosine (NaN, Infinity)", () => {
    const now = 10_000_000;
    const entries: T[] = [{ id: "x", ts: now, cos: Number.NaN, imp: 0.5 }];
    const scored = scoreEntries(entries, baseScorers, { now: () => now });
    expect(scored[0]!.components.cosine).toBe(0);
  });

  it("respects custom weights", () => {
    const now = 10_000_000;
    // cosine-dominated: equal recency+importance, different cosine
    const entries: T[] = [
      { id: "high-cos", ts: now, cos: 1, imp: 0.5 },
      { id: "low-cos", ts: now, cos: 0, imp: 0.5 },
    ];
    const scored = scoreEntries(entries, baseScorers, {
      now: () => now,
      weights: { cosine: 1, recency: 0, importance: 0 },
    });
    expect(scored[0]!.entry.id).toBe("high-cos");
    expect(scored[0]!.score).toBe(1);
    expect(scored[1]!.score).toBe(0);
  });

  it("respects custom halflife", () => {
    const now = 10_000_000;
    // Two entries 100ms apart; halflife=50ms → second is much less recent.
    const entries: T[] = [
      { id: "fresh", ts: now, cos: 0, imp: 0 },
      { id: "stale", ts: now - 100, cos: 0, imp: 0 },
    ];
    const scored = scoreEntries(entries, baseScorers, {
      now: () => now,
      recencyHalflifeMs: 50,
      weights: { cosine: 0, recency: 1, importance: 0 },
    });
    expect(scored[0]!.entry.id).toBe("fresh");
    expect(scored[0]!.score).toBeCloseTo(1, 6);
    expect(scored[1]!.score).toBeCloseTo(0.25, 6);
  });
});

// ─── recallEpisodicRrf ───────────────────────────────────────────────────────

describe("recallEpisodicRrf", () => {
  const now = 10_000_000;

  function entry(id: string, overrides: Partial<EpisodicMemoryEntry> = {}): EpisodicMemoryEntry {
    return {
      agentId: "A",
      runId: id,
      event: id,
      timestamp: now - 1000,
      metadata: { importance: 0.5 },
      ...overrides,
    };
  }

  it("ranks by recency when no cosine is provided", () => {
    const entries = [
      entry("old", { timestamp: now - 1_000_000 }),
      entry("new", { timestamp: now - 1000 }),
    ];
    const scored = recallEpisodicRrf(entries, { now: () => now });
    expect(scored[0]!.entry.runId).toBe("new");
  });

  it("uses metadata.importance when present", () => {
    const entries = [
      entry("salient", { metadata: { importance: 0.9 } }),
      entry("dull", { metadata: { importance: 0.1 } }),
    ];
    const scored = recallEpisodicRrf(entries, {
      now: () => now,
      weights: { cosine: 0, recency: 0, importance: 1 },
    });
    expect(scored[0]!.entry.runId).toBe("salient");
  });

  it("defaults importance to 0.5 when metadata is missing", () => {
    const entries = [entry("plain", { metadata: undefined })];
    const scored = recallEpisodicRrf(entries, { now: () => now });
    expect(scored[0]!.components.importance).toBe(0.5);
  });

  it("uses a custom cosine resolver when supplied", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const cosines: Record<string, number> = {
      a: 0.1,
      b: 0.9,
      c: 0.5,
    };
    const scored = recallEpisodicRrf(entries, {
      now: () => now,
      cosine: (e) => cosines[e.runId] ?? 0,
      weights: { cosine: 1, recency: 0, importance: 0 },
    });
    expect(scored.map((s) => s.entry.runId)).toEqual(["b", "c", "a"]);
  });

  it("DEFAULT_RRF_WEIGHTS sum to 1", () => {
    const sum =
      DEFAULT_RRF_WEIGHTS.cosine + DEFAULT_RRF_WEIGHTS.recency + DEFAULT_RRF_WEIGHTS.importance;
    expect(sum).toBeCloseTo(1, 6);
  });

  it("DEFAULT_RECENCY_HALFLIFE_MS = 14 days", () => {
    expect(DEFAULT_RECENCY_HALFLIFE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});
