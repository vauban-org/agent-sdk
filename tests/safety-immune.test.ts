/**
 * tests/safety-immune.test.ts
 *
 * Sprint-564: C3 — MAAG immune system tests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  GOLDEN_ATTACK_EMBEDDINGS,
  StressLedger,
  cosineSimilarity,
  validateGoldenFixtures,
} from "../src/safety/immune.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 for different length vectors", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("StressLedger", () => {
  let ledger: StressLedger;

  beforeEach(() => {
    ledger = new StressLedger();
  });

  it("records entries", () => {
    const entry = ledger.record([0.1, 0.2, 0.3], "test_pattern");
    expect(entry.label).toBe("test_pattern");
    expect(entry.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(ledger.size).toBe(1);
  });

  it("finds similar entries above threshold", () => {
    ledger.record([0.5, 0.5, 0.5], "known");
    ledger.record([0.9, 0.1, 0.1], "different");

    const matches = ledger.search([0.5, 0.5, 0.5], 0.9);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.entry.label).toBe("known");
    expect(matches[0]!.similarity).toBeCloseTo(1, 5);
  });

  it("returns empty when no match above threshold", () => {
    ledger.record([1, 0, 0], "orthogonal");
    const matches = ledger.search([0, 1, 0], 0.9);
    expect(matches).toHaveLength(0);
  });

  it("sorts matches by similarity descending", () => {
    ledger.record([0.9, 0.1], "high");
    ledger.record([0.7, 0.3], "medium");

    const matches = ledger.search([0.9, 0.1], 0.5);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.entry.label).toBe("high");
    expect(matches[1]!.entry.label).toBe("medium");
  });

  it("export/clear works", () => {
    ledger.record([1, 2], "a");
    ledger.record([3, 4], "b");

    const exported = ledger.export();
    expect(exported).toHaveLength(2);

    ledger.clear();
    expect(ledger.size).toBe(0);
  });
});

describe("validateGoldenFixtures", () => {
  it("all golden fixtures validate against themselves", () => {
    const ledger = new StressLedger();
    const result = validateGoldenFixtures(ledger);

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(GOLDEN_ATTACK_EMBEDDINGS.length);
    for (const r of result.results) {
      expect(r.matched).toBe(true);
      expect(r.similarity).toBeCloseTo(1, 5);
    }
  });

  it("detects a mismatch on an unknown pattern", () => {
    const ledger = new StressLedger();
    // Record only the first fixture, then search for all
    ledger.record(GOLDEN_ATTACK_EMBEDDINGS[0]!.embedding, GOLDEN_ATTACK_EMBEDDINGS[0]!.label);

    // Search for a different pattern shouldn't match
    const matches = ledger.search(GOLDEN_ATTACK_EMBEDDINGS[1]!.embedding, 0.92);
    expect(matches).toHaveLength(0);
  });
});
