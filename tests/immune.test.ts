/**
 * Tests for:
 *   agent-sdk/src/safety/immune.ts
 *
 * Coverage:
 *   cosineSimilarity — all edge cases (identical, orthogonal, zero, mismatched lengths, etc.)
 *   StressLedger — record, search, export, clear, size
 *   GOLDEN_ATTACK_EMBEDDINGS — structure and field validation
 *   validateGoldenFixtures — passes with fresh ledger, result shape
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  GOLDEN_ATTACK_EMBEDDINGS,
  StressLedger,
  cosineSimilarity,
  validateGoldenFixtures,
} from "../src/safety/immune.js";

// ─── cosineSimilarity ────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("identical vectors → 1.0", () => {
    const v = [0.2, 0.5, 0.8, 0.1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("orthogonal vectors → 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 10);
  });

  it("zero vector → 0", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("both zero vectors → 0", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("different length vectors → 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("[1,0] and [0,1] → 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 10);
  });

  it("[1,1] and [1,1] → 1.0", () => {
    expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1.0, 10);
  });

  it("[1,0] and [1,1] → approximately 0.707 (1/sqrt(2))", () => {
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(1 / Math.sqrt(2), 5);
  });

  it("vectors with negative values — result still [0,1] range possible", () => {
    const sim = cosineSimilarity([-1, 0], [1, 0]);
    // anti-parallel → -1, cosine can be negative (not clamped by the impl)
    expect(sim).toBeCloseTo(-1.0, 10);
  });

  it("vectors with negative values — same direction → 1.0", () => {
    const sim = cosineSimilarity([-1, -1], [-1, -1]);
    expect(sim).toBeCloseTo(1.0, 10);
  });

  it("single-element vectors [3] and [3] → 1.0", () => {
    expect(cosineSimilarity([3], [3])).toBeCloseTo(1.0, 10);
  });

  it("partial overlap vectors → 0 < result < 1", () => {
    const sim = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    expect(sim).toBeCloseTo(1 / Math.sqrt(2), 5);
  });
});

// ─── StressLedger ────────────────────────────────────────────────────────────

describe("StressLedger", () => {
  let ledger: StressLedger;

  beforeEach(() => {
    ledger = new StressLedger();
  });

  it("new ledger has size 0", () => {
    expect(ledger.size).toBe(0);
  });

  it("record() returns the entry", () => {
    const emb = [0.1, 0.2, 0.3];
    const entry = ledger.record(emb, "test_label");
    expect(entry).toBeDefined();
    expect(entry.label).toBe("test_label");
    expect(entry.embedding).toEqual(emb);
  });

  it("after record(), size is 1", () => {
    ledger.record([0.1, 0.2], "lbl");
    expect(ledger.size).toBe(1);
  });

  it("record() stores label correctly", () => {
    const entry = ledger.record([1, 0, 0], "my_attack");
    expect(entry.label).toBe("my_attack");
  });

  it("record() stores a recent timestamp", () => {
    const before = Date.now();
    const entry = ledger.record([1, 0], "ts_check");
    const after = Date.now();
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
  });

  it("search() on empty ledger returns []", () => {
    expect(ledger.search([0.5, 0.5, 0.5])).toEqual([]);
  });

  it("search() finds exact match (self-similarity = 1.0 > threshold 0.92)", () => {
    const emb = [0.8, 0.6, 0.1, 0.2];
    ledger.record(emb, "exact");
    const matches = ledger.search(emb);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.entry.label).toBe("exact");
    expect(matches[0]!.similarity).toBeCloseTo(1.0, 5);
  });

  it("search() filters below threshold", () => {
    ledger.record([1, 0, 0, 0], "axis_x");
    // orthogonal — similarity = 0
    const matches = ledger.search([0, 1, 0, 0]);
    expect(matches).toHaveLength(0);
  });

  it("search() sorts by similarity descending", () => {
    // Record two similar vectors
    const base = [1, 0, 0, 0];
    const close = [0.999, 0.045, 0, 0]; // very close to base
    const closer = [1.0, 0.0, 0.0, 0.0]; // identical to base

    ledger.record(base, "base");
    ledger.record(close, "close");

    const matches = ledger.search(base);
    // Both should be above 0.92; base has similarity 1.0 so it comes first
    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1]!.similarity).toBeGreaterThanOrEqual(matches[i]!.similarity);
    }
  });

  it("export() returns copy of entries", () => {
    ledger.record([0.1, 0.2], "a");
    ledger.record([0.3, 0.4], "b");
    const exported = ledger.export();
    expect(exported).toHaveLength(2);
    expect(exported[0]!.label).toBe("a");
    expect(exported[1]!.label).toBe("b");
  });

  it("export() returns a copy — mutations do not affect ledger", () => {
    ledger.record([0.5, 0.5], "original");
    const exported = ledger.export();
    exported.pop();
    expect(ledger.size).toBe(1);
  });

  it("clear() resets size to 0", () => {
    ledger.record([1, 2, 3], "entry1");
    ledger.record([4, 5, 6], "entry2");
    ledger.clear();
    expect(ledger.size).toBe(0);
  });

  it("clear() makes search return empty", () => {
    const emb = [0.9, 0.1, 0.2];
    ledger.record(emb, "x");
    ledger.clear();
    expect(ledger.search(emb)).toHaveLength(0);
  });

  it("multiple records → search returns multiple matches above threshold", () => {
    const emb = [1, 0, 0, 0];
    ledger.record([1, 0, 0, 0], "a");
    ledger.record([0.999, 0.001, 0, 0], "b"); // cosine ~1
    ledger.record([0, 1, 0, 0], "orthogonal"); // cosine = 0 — should not match
    const matches = ledger.search(emb, 0.92);
    const labels = matches.map((m) => m.entry.label);
    expect(labels).toContain("a");
    expect(labels).not.toContain("orthogonal");
  });

  it("entry timestamp is within 5 seconds of now", () => {
    const entry = ledger.record([1, 2], "ts_test");
    expect(Date.now() - entry.timestamp).toBeLessThan(5000);
  });
});

// ─── GOLDEN_ATTACK_EMBEDDINGS ────────────────────────────────────────────────

describe("GOLDEN_ATTACK_EMBEDDINGS", () => {
  it("has at least 3 entries", () => {
    expect(GOLDEN_ATTACK_EMBEDDINGS.length).toBeGreaterThanOrEqual(3);
  });

  it("each entry has a label field", () => {
    for (const fixture of GOLDEN_ATTACK_EMBEDDINGS) {
      expect(typeof fixture.label).toBe("string");
      expect(fixture.label.length).toBeGreaterThan(0);
    }
  });

  it("each entry has an embedding field", () => {
    for (const fixture of GOLDEN_ATTACK_EMBEDDINGS) {
      expect(Array.isArray(fixture.embedding)).toBe(true);
    }
  });

  it("each embedding has length >= 4", () => {
    for (const fixture of GOLDEN_ATTACK_EMBEDDINGS) {
      expect(fixture.embedding.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("all labels are unique", () => {
    const labels = GOLDEN_ATTACK_EMBEDDINGS.map((f) => f.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });
});

// ─── validateGoldenFixtures ───────────────────────────────────────────────────

describe("validateGoldenFixtures", () => {
  it("fresh ledger → passes (passed: true)", () => {
    const ledger = new StressLedger();
    const result = validateGoldenFixtures(ledger);
    expect(result.passed).toBe(true);
  });

  it("results array has same length as GOLDEN_ATTACK_EMBEDDINGS", () => {
    const ledger = new StressLedger();
    const result = validateGoldenFixtures(ledger);
    expect(result.results.length).toBe(GOLDEN_ATTACK_EMBEDDINGS.length);
  });

  it("each result has matched: true with fresh ledger", () => {
    const ledger = new StressLedger();
    const result = validateGoldenFixtures(ledger);
    for (const r of result.results) {
      expect(r.matched).toBe(true);
    }
  });

  it("each result has the expected label", () => {
    const ledger = new StressLedger();
    const result = validateGoldenFixtures(ledger);
    const goldenLabels = GOLDEN_ATTACK_EMBEDDINGS.map((f) => f.label);
    for (const r of result.results) {
      expect(goldenLabels).toContain(r.label);
    }
  });

  it("each result similarity is >= 0.92 for self-match", () => {
    const ledger = new StressLedger();
    const result = validateGoldenFixtures(ledger);
    for (const r of result.results) {
      expect(r.similarity).toBeGreaterThanOrEqual(0.92);
    }
  });

  it("ledger grows by GOLDEN_ATTACK_EMBEDDINGS.length after call", () => {
    const ledger = new StressLedger();
    validateGoldenFixtures(ledger);
    expect(ledger.size).toBe(GOLDEN_ATTACK_EMBEDDINGS.length);
  });
});
