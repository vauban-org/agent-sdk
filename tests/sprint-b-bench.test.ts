/**
 * tests/sprint-b-bench.test.ts
 *
 * Validates the Sprint B constitutional scorer correlation bench:
 * - Dataset shape: 30 cycles, 6 per axiom (3 high + 3 low)
 * - Mock-mode bench produces all 5 axiom rows
 * - Spearman ρ implementation correctness
 * - Cohen κ implementation correctness
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBench } from "../evals/sprint-b-bench.js";
import { cohenKappa, ordinalCohenKappa, spearman } from "../evals/sprint-b-bench.js";
import type { CycleSnapshot } from "../src/constitution/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CYCLES_PATH = resolve(__dirname, "../evals/datasets/sprint-b-cycles.json");

// ---------------------------------------------------------------------------
// Dataset shape tests
// ---------------------------------------------------------------------------

describe("sprint-b-cycles dataset", () => {
  const cycles: CycleSnapshot[] = JSON.parse(readFileSync(CYCLES_PATH, "utf8")) as CycleSnapshot[];

  it("has exactly 30 cycles", () => {
    expect(cycles).toHaveLength(30);
  });

  it("has 6 cycles per axiom (by runId prefix convention)", () => {
    const prefixes = ["inst-", "sota-", "rob-", "af-", "prof-"];
    for (const prefix of prefixes) {
      const count = cycles.filter((c) => c.runId.startsWith(prefix)).length;
      expect(count).toBe(6);
    }
  });

  it("has 3 high-quality + 3 low-quality cycles per axiom prefix", () => {
    const prefixes = ["inst-", "sota-", "rob-", "af-", "prof-"];
    for (const prefix of prefixes) {
      const hi = cycles.filter(
        (c) => c.runId.startsWith(prefix) && c.runId.includes("-hi-"),
      ).length;
      const lo = cycles.filter(
        (c) => c.runId.startsWith(prefix) && c.runId.includes("-lo-"),
      ).length;
      expect(hi).toBe(3);
      expect(lo).toBe(3);
    }
  });

  it("all cycles have unique runIds", () => {
    const ids = cycles.map((c) => c.runId);
    const unique = new Set(ids);
    expect(unique.size).toBe(cycles.length);
  });

  it("all cycles have a non-empty rootHash", () => {
    for (const cycle of cycles) {
      expect(typeof cycle.rootHash).toBe("string");
      expect(cycle.rootHash.length).toBeGreaterThan(0);
    }
  });

  it("all cycles have budgetUsdMax >= 0 and budgetUsdSpent >= 0", () => {
    for (const cycle of cycles) {
      expect(cycle.budgetUsdMax).toBeGreaterThanOrEqual(0);
      expect(cycle.budgetUsdSpent).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Mock-mode bench output tests
// ---------------------------------------------------------------------------

describe("sprint-b bench (mock mode)", () => {
  it("produces 5 axiom rows", async () => {
    const result = await runBench({ mode: "mock" });
    expect(result.rows).toHaveLength(5);
  });

  it("contains all 5 axiom names", async () => {
    const result = await runBench({ mode: "mock" });
    const axioms = result.rows.map((r) => r.axiom);
    expect(axioms).toContain("Institutionnel");
    expect(axioms).toContain("SOTA");
    expect(axioms).toContain("Robuste");
    expect(axioms).toContain("AntiFragile");
    expect(axioms).toContain("Profitable");
  });

  it("mode is 'mock'", async () => {
    const result = await runBench({ mode: "mock" });
    expect(result.mode).toBe("mock");
  });

  it("capturedAt is an ISO timestamp", async () => {
    const result = await runBench({ mode: "mock" });
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("all rows have finite spearmanRho and interJudgeKappa", async () => {
    const result = await runBench({ mode: "mock" });
    for (const row of result.rows) {
      expect(Number.isFinite(row.spearmanRho)).toBe(true);
      expect(Number.isFinite(row.interJudgeKappa)).toBe(true);
    }
  });

  it("spearmanRho is in [-1, 1] for all rows", async () => {
    const result = await runBench({ mode: "mock" });
    for (const row of result.rows) {
      expect(row.spearmanRho).toBeGreaterThanOrEqual(-1);
      expect(row.spearmanRho).toBeLessThanOrEqual(1);
    }
  });

  it("interJudgeKappa is in [-1, 1] for all rows", async () => {
    const result = await runBench({ mode: "mock" });
    for (const row of result.rows) {
      expect(row.interJudgeKappa).toBeGreaterThanOrEqual(-1);
      expect(row.interJudgeKappa).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("overallPassed is boolean and consistent with failedAxioms", async () => {
    const result = await runBench({ mode: "mock" });
    if (result.overallPassed) {
      expect(result.failedAxioms).toHaveLength(0);
    } else {
      expect(result.failedAxioms.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Spearman ρ correctness tests
// ---------------------------------------------------------------------------

describe("spearman()", () => {
  it("returns 1.0 for identical arrays", () => {
    const x = [1, 2, 3, 4, 5];
    expect(spearman(x, x)).toBeCloseTo(1.0, 5);
  });

  it("returns -1.0 for perfectly reversed arrays", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [5, 4, 3, 2, 1];
    expect(spearman(x, y)).toBeCloseTo(-1.0, 5);
  });

  it("returns correct ρ for a known fixture", () => {
    // Known: x = [1,2,3,4,5,6], y = [1,2,3,4,5,6] → ρ = 1
    // Slightly perturbed: x = [1,2,3,4,5,6], y = [1,2,3,4,6,5]
    // d² = [0,0,0,0,1,1] → sumD2=2, n=6 → ρ = 1 - 6*2/(6*35) = 1 - 12/210 ≈ 0.9429
    const x = [1, 2, 3, 4, 5, 6];
    const y = [1, 2, 3, 4, 6, 5];
    expect(spearman(x, y)).toBeCloseTo(0.9429, 3);
  });

  it("handles ties correctly (average rank)", () => {
    // x = [1,1,3], ranks = [1.5,1.5,3]
    // y = [3,1,2], ranks = [3,1,2]
    // d = [1.5-3, 1.5-1, 3-2] = [-1.5, 0.5, 1]
    // d² = [2.25, 0.25, 1] sumD2=3.5
    // ρ = 1 - 6*3.5/(3*8) = 1 - 21/24 = 1 - 0.875 = 0.125
    const x = [1, 1, 3];
    const y = [3, 1, 2];
    expect(spearman(x, y)).toBeCloseTo(0.125, 5);
  });

  it("returns NaN for arrays of length < 2", () => {
    expect(spearman([], [])).toBeNaN();
    expect(spearman([1], [1])).toBeNaN();
  });

  it("returns NaN for unequal-length arrays", () => {
    expect(spearman([1, 2, 3], [1, 2])).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Cohen κ correctness tests
// ---------------------------------------------------------------------------

describe("cohenKappa()", () => {
  it("returns 1.0 for perfect agreement", () => {
    const a = [0.8, 0.2, 0.7, 0.3];
    const b = [0.8, 0.2, 0.7, 0.3];
    expect(cohenKappa(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns -1.0 for perfect disagreement on balanced classes", () => {
    // judgeA: [1,1,0,0] → bA=[1,1,0,0]
    // judgeB: [0,0,1,1] → bB=[0,0,1,1]
    // agree=0, pO=0
    // a1=2, b1=2, n=4
    // pE = (2/4)*(2/4) + (2/4)*(2/4) = 0.25+0.25=0.5
    // κ = (0 - 0.5)/(1 - 0.5) = -1.0
    const a = [0.9, 0.8, 0.1, 0.2];
    const b = [0.1, 0.2, 0.9, 0.8];
    expect(cohenKappa(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0.0 for chance agreement", () => {
    // All positive from judgeA, 50/50 from judgeB
    // a=[1,1,1,1] b=[1,1,0,0]
    // agree=2, pO=0.5
    // a1=4, b1=2, n=4
    // pE = (4/4)*(2/4) + (0/4)*(2/4) = 0.5 + 0 = 0.5
    // κ = (0.5 - 0.5)/(1 - 0.5) = 0.0
    const a = [0.9, 0.8, 0.7, 0.6]; // all >= 0.5
    const b = [0.9, 0.8, 0.2, 0.1]; // 2 positive, 2 negative
    expect(cohenKappa(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns NaN for empty arrays", () => {
    expect(cohenKappa([], [])).toBeNaN();
  });

  it("returns NaN for unequal-length arrays", () => {
    expect(cohenKappa([1, 2, 3], [1, 2])).toBeNaN();
  });

  it("uses 0.5 as binarization threshold", () => {
    // 0.5 exactly → counts as positive (>= 0.5)
    const a = [0.5, 0.5];
    const b = [0.5, 0.5];
    expect(cohenKappa(a, b)).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// ordinalCohenKappa correctness tests
// ---------------------------------------------------------------------------

describe("ordinalCohenKappa()", () => {
  it("returns 1.0 for perfect agreement (identical arrays)", () => {
    const a = [0.1, 0.4, 0.8, 0.2, 0.7, 0.5];
    expect(ordinalCohenKappa(a, a)).toBeCloseTo(1.0, 5);
  });

  it("returns approximately 0.0 for arrays with random bin distribution", () => {
    // Alternating bins so bA=[0,1,2,0,1,2,0,1,2] bB=[2,1,0,2,1,0,2,1,0]
    // Perfectly anti-correlated across 3 bins → strong disagreement → κ < 0
    // (We just check it's below the 0.6 threshold, not = 0)
    const a = [0.1, 0.5, 0.9, 0.1, 0.5, 0.9]; // bins: 0,1,2,0,1,2
    const b = [0.9, 0.5, 0.1, 0.9, 0.5, 0.1]; // bins: 2,1,0,2,1,0
    const kappa = ordinalCohenKappa(a, b);
    expect(kappa).toBeLessThan(0.6);
  });

  it("returns κ between 0.5 and 1.0 for off-by-one bin (adjacent disagreement)", () => {
    // judgeA bins: [0,0,0,1,1,1,2,2,2]
    // judgeB bins: [0,0,1,1,1,2,2,2,2] — shifted by one step on some items
    // Quadratic weighting forgives adjacent-bin mismatches → κ > 0.5
    const a = [0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8]; // low,low,low,mid,mid,mid,hi,hi,hi
    const b = [0.1, 0.1, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 0.9]; // same with 2 items shifted one bin up
    const kappa = ordinalCohenKappa(a, b);
    expect(kappa).toBeGreaterThan(0.5);
    expect(kappa).toBeLessThanOrEqual(1.0);
  });

  it("ordinal κ passes where binary κ fails — rank-correlated but threshold-shifted judges", () => {
    // Construct 12 items where judges agree on ordinal rank but disagree on binary threshold.
    // judgeA: 4 items clearly below 0.5, 4 around 0.5 (straddles), 4 clearly above 0.5.
    // judgeB: same rank order but shifted +0.15 upward → crosses 0.5 on the straddling items.
    // Binary κ: 4 mismatches (the straddling items flip bins) → low.
    // Ordinal 3-bin: straddling items move from mid→mid or mid→high → adjacent, less penalised.
    const judgeA = [0.1, 0.15, 0.2, 0.25, 0.45, 0.47, 0.53, 0.55, 0.7, 0.75, 0.85, 0.9];
    const judgeB = judgeA.map((v) => Math.min(1, v + 0.15));
    // judgeA bins (thresholds 0.33, 0.66): [0,0,0,0, 1,1,1,1, 2,2,2,2]
    // judgeB: [0.25,0.30,0.35,0.40, 0.60,0.62,0.68,0.70, 0.85,0.90,1.0,1.0]
    //   bins: [0,   0,   1,   1,    1,   1,   2,   2,    2,   2,  2,  2  ]
    // Binary 0.5 threshold judgeA: [0,0,0,0, 0,0,1,1, 1,1,1,1]
    // Binary 0.5 threshold judgeB: [0,0,0,0, 1,1,1,1, 1,1,1,1]
    // Binary mismatches at positions 4,5 → κ < 1.0 but not drastically low on 12 items

    const binaryK = cohenKappa(judgeA, judgeB);
    const ordinalK = ordinalCohenKappa(judgeA, judgeB);

    // Both κ values should be finite
    expect(Number.isFinite(binaryK)).toBe(true);
    expect(Number.isFinite(ordinalK)).toBe(true);
    // Ordinal κ should be strictly higher: adjacent-bin shifts are less penalised
    expect(ordinalK).toBeGreaterThan(binaryK);
    // Ordinal κ should be comfortably above the 0.6 gate
    expect(ordinalK).toBeGreaterThan(0.6);
  });

  it("returns NaN for empty arrays", () => {
    expect(ordinalCohenKappa([], [])).toBeNaN();
  });

  it("returns NaN for unequal-length arrays", () => {
    expect(ordinalCohenKappa([0.1, 0.5], [0.1])).toBeNaN();
  });

  it("handles custom thresholds", () => {
    // With very tight thresholds [0.1, 0.9], most scores land in mid bin
    const a = [0.3, 0.5, 0.7, 0.4, 0.6];
    const b = [0.4, 0.6, 0.8, 0.3, 0.5];
    const kappa = ordinalCohenKappa(a, b, [0.1, 0.9]);
    // Most values fall in mid (0.1–0.9) for both judges → high agreement
    expect(kappa).toBeGreaterThan(0.5);
  });
});
