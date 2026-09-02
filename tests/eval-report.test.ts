/**
 * tests/eval-report.test.ts
 *
 * A5 slice 3: the eval runner + CI gate. runEval turns a curated golden dataset
 * into a metrics report (pass^k, end-to-end success, judge calibration via the
 * slice-1 metrics); gateEval checks a report against CI thresholds. Both pure.
 */

import { describe, expect, it } from "vitest";
import { type EvalCase, type EvalThresholds, gateEval, runEval } from "../src/evals/report.js";

describe("runEval (golden dataset -> metrics report)", () => {
  it("aggregates pass^k and pass@k over cases at the configured k", () => {
    const cases: EvalCase[] = [
      { id: "a", attempts: { n: 4, c: 4 } },
      { id: "b", attempts: { n: 4, c: 2 } },
    ];
    const r = runEval(cases, 2);
    expect(r.k).toBe(2);
    expect(r.total).toBe(2);
    expect(r.passHatK).toBeCloseTo((1 + 1 / 6) / 2, 10);
    expect(r.passAtK).toBeCloseTo((1 + 5 / 6) / 2, 10);
  });

  it("computes end-to-end success only over cases that carry it", () => {
    const cases: EvalCase[] = [
      { id: "a", attempts: { n: 1, c: 1 }, endToEnd: true },
      { id: "b", attempts: { n: 1, c: 0 }, endToEnd: false },
      { id: "c", attempts: { n: 1, c: 1 } },
    ];
    expect(runEval(cases, 1).endToEndSuccessRate).toBeCloseTo(0.5, 10);
  });

  it("computes judge calibration only over cases with a judge verdict", () => {
    const cases: EvalCase[] = [
      {
        id: "1",
        attempts: { n: 1, c: 1 },
        judge: { verdict: true, gold: true },
      },
      {
        id: "2",
        attempts: { n: 1, c: 1 },
        judge: { verdict: true, gold: true },
      },
      {
        id: "3",
        attempts: { n: 1, c: 0 },
        judge: { verdict: true, gold: false },
      },
      { id: "4", attempts: { n: 1, c: 1 } },
    ];
    const r = runEval(cases, 1);
    expect(r.judgeCalibration).not.toBeNull();
    expect(r.judgeCalibration?.agreement).toBeCloseTo(2 / 3, 10);
    expect(r.judgeCalibration?.kappa).toBeCloseTo(0, 10);
  });

  it("returns null judge calibration when no case has a judge verdict", () => {
    expect(runEval([{ id: "a", attempts: { n: 1, c: 1 } }], 1).judgeCalibration).toBeNull();
  });

  it("handles an empty dataset (zeros, null calibration)", () => {
    const r = runEval([], 3);
    expect(r.total).toBe(0);
    expect(r.passHatK).toBe(0);
    expect(r.endToEndSuccessRate).toBe(0);
    expect(r.judgeCalibration).toBeNull();
  });
});

describe("gateEval (CI threshold gate)", () => {
  const report = runEval(
    [
      {
        id: "a",
        attempts: { n: 1, c: 1 },
        endToEnd: true,
        judge: { verdict: true, gold: true },
      },
      {
        id: "b",
        attempts: { n: 1, c: 0 },
        endToEnd: false,
        judge: { verdict: false, gold: false },
      },
    ],
    1,
  );

  it("passes when every threshold is met", () => {
    const t: EvalThresholds = {
      minPassHatK: 0.4,
      minEndToEndSuccess: 0.4,
      minJudgeKappa: 0.5,
    };
    const g = gateEval(report, t);
    expect(g.pass).toBe(true);
    expect(g.failures).toEqual([]);
  });

  it("fails and names each metric under its threshold", () => {
    const g = gateEval(report, { minPassHatK: 0.9, minEndToEndSuccess: 0.9 });
    expect(g.pass).toBe(false);
    expect(g.failures.some((f) => /pass\^k/.test(f))).toBe(true);
    expect(g.failures.some((f) => /end-to-end/.test(f))).toBe(true);
  });

  it("skips a judge-kappa threshold when there is no calibration data", () => {
    const noJudge = runEval([{ id: "a", attempts: { n: 1, c: 1 } }], 1);
    expect(gateEval(noJudge, { minJudgeKappa: 0.9 }).pass).toBe(true);
  });
});
