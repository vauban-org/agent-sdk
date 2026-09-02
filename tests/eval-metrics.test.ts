/**
 * tests/eval-metrics.test.ts
 *
 * A5 / audit C2 + R2 eval metrics — TDD tests.
 * pass^k (reliability) vs pass@k (capacity), end-to-end run success, tool-call
 * correctness, and LLM-judge calibration (raw agreement misleads on imbalanced
 * sets, so kappa is the honest calibration signal). nDCG is deliberately ABSENT:
 * it is a retrieval metric reserved for the Brain memory layer, not agent quality.
 */

import { describe, expect, it } from "vitest";
import {
  cohenKappa,
  confusionMatrix,
  endToEndSuccess,
  meanPassAtK,
  meanPassHatK,
  passAtK,
  passHatK,
  successRate,
  toolCallCorrectness,
} from "../src/evals/metrics.js";

describe("passHatK (pass^k — ALL k attempts pass; reliability)", () => {
  it("is 1 when every attempt is correct", () => {
    expect(passHatK(3, 3, 3)).toBe(1);
  });
  it("is 0 when fewer attempts are correct than k", () => {
    expect(passHatK(3, 2, 3)).toBe(0);
  });
  it("equals c/n at k=1", () => {
    expect(passHatK(10, 7, 1)).toBeCloseTo(0.7, 10);
  });
  it("uses the unbiased estimator C(c,k)/C(n,k)", () => {
    expect(passHatK(4, 2, 2)).toBeCloseTo(1 / 6, 10);
    expect(passHatK(10, 7, 3)).toBeCloseTo(35 / 120, 10);
  });
  it("throws on invalid counts (k>n, c>n, k<1)", () => {
    expect(() => passHatK(3, 2, 5)).toThrow();
    expect(() => passHatK(3, 5, 2)).toThrow();
    expect(() => passHatK(3, 2, 0)).toThrow();
  });
});

describe("passAtK (pass@k — AT LEAST ONE of k passes; capacity)", () => {
  it("is 0 when no attempt is correct", () => {
    expect(passAtK(3, 0, 3)).toBe(0);
  });
  it("equals c/n at k=1 (same as pass^k there)", () => {
    expect(passAtK(10, 7, 1)).toBeCloseTo(0.7, 10);
  });
  it("uses the unbiased estimator 1 - C(n-c,k)/C(n,k)", () => {
    expect(passAtK(4, 2, 2)).toBeCloseTo(5 / 6, 10);
    expect(passAtK(10, 7, 3)).toBeCloseTo(1 - 1 / 120, 10);
  });
  it("is always >= pass^k for the same (n,c,k)", () => {
    expect(passAtK(10, 7, 3)).toBeGreaterThanOrEqual(passHatK(10, 7, 3));
  });
});

describe("mean aggregates over tasks", () => {
  it("meanPassHatK averages per-task pass^k", () => {
    expect(
      meanPassHatK(
        [
          { n: 4, c: 2 },
          { n: 4, c: 4 },
        ],
        2,
      ),
    ).toBeCloseTo(7 / 12, 10);
  });
  it("meanPassAtK averages per-task pass@k", () => {
    expect(
      meanPassAtK(
        [
          { n: 4, c: 2 },
          { n: 4, c: 2 },
        ],
        2,
      ),
    ).toBeCloseTo(5 / 6, 10);
  });
  it("is 0 for an empty dataset", () => {
    expect(meanPassHatK([], 1)).toBe(0);
    expect(meanPassAtK([], 1)).toBe(0);
  });
});

describe("endToEndSuccess (R2 — whole run, not a per-stage average)", () => {
  it("is true only when every stage sealed", () => {
    expect(endToEndSuccess([true, true, true])).toBe(true);
    expect(endToEndSuccess([true, false, true])).toBe(false);
  });
  it("is false for an empty run", () => {
    expect(endToEndSuccess([])).toBe(false);
  });
});

describe("successRate", () => {
  it("is the mean of boolean outcomes", () => {
    expect(successRate([true, false, true, false])).toBeCloseTo(0.5, 10);
  });
  it("is 0 for empty input", () => {
    expect(successRate([])).toBe(0);
  });
});

describe("toolCallCorrectness (precision/recall/f1 over tool calls)", () => {
  it("is perfect when actual matches expected", () => {
    expect(
      toolCallCorrectness([{ name: "a" }, { name: "b" }], [{ name: "a" }, { name: "b" }]),
    ).toEqual({ precision: 1, recall: 1, f1: 1 });
  });
  it("penalizes a missing call (recall < 1)", () => {
    const r = toolCallCorrectness([{ name: "a" }, { name: "b" }], [{ name: "a" }]);
    expect(r.precision).toBeCloseTo(1, 10);
    expect(r.recall).toBeCloseTo(0.5, 10);
  });
  it("penalizes a spurious call (precision < 1)", () => {
    const r = toolCallCorrectness([{ name: "a" }], [{ name: "a" }, { name: "b" }]);
    expect(r.precision).toBeCloseTo(0.5, 10);
    expect(r.recall).toBeCloseTo(1, 10);
  });
  it("distinguishes args (same name, different args is not a match)", () => {
    expect(
      toolCallCorrectness([{ name: "x", args: { a: 1 } }], [{ name: "x", args: { a: 2 } }]).f1,
    ).toBe(0);
  });
  it("matches args regardless of key order", () => {
    expect(
      toolCallCorrectness(
        [{ name: "x", args: { a: 1, b: 2 } }],
        [{ name: "x", args: { b: 2, a: 1 } }],
      ).f1,
    ).toBe(1);
  });
  it("scores two empty sequences as perfect", () => {
    expect(toolCallCorrectness([], [])).toEqual({
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });
});

describe("judge calibration (C2 — raw agreement misleads on imbalanced sets)", () => {
  it("cohenKappa is 1 on perfect agreement", () => {
    expect(cohenKappa([true, true, false, false], [true, true, false, false])).toBeCloseTo(1, 10);
  });
  it("a rubber-stamp judge scores high agreement but ~0 kappa", () => {
    const judge = Array<boolean>(10).fill(true);
    const gold = [...Array<boolean>(9).fill(true), false];
    const cm = confusionMatrix(judge, gold);
    expect(cm.agreement).toBeCloseTo(0.9, 10);
    expect(cm.kappa).toBeCloseTo(0, 10);
  });
  it("confusionMatrix counts tp/fp/tn/fn correctly", () => {
    const cm = confusionMatrix([true, true, false, false], [true, false, true, false]);
    expect(cm).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(cm.precision).toBeCloseTo(0.5, 10);
    expect(cm.recall).toBeCloseTo(0.5, 10);
  });
  it("throws on a length mismatch", () => {
    expect(() => cohenKappa([true], [true, false])).toThrow();
  });
});
