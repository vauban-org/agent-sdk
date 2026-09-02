/**
 * tests/bench-sprint-a.test.ts
 *
 * Sanity test for the Sprint-580 BoN-MAV bench harness.
 *
 * Validates:
 * - runBench() resolves and returns a well-formed BenchReport
 * - All 5 strategy entries are present with sane accuracy values
 * - BoN variants cost more calls than single-shot
 * - No NaN / Infinity in any numeric field
 */

import { describe, expect, it } from "vitest";
import { runBench } from "../bench/sprint-a-bench.js";
import type { BenchReport } from "../bench/sprint-a-bench.js";

describe("sprint-a bench harness", () => {
  it("resolves and returns a BenchReport with 5 strategy rows", async () => {
    const report: BenchReport = await runBench();

    expect(report).toBeDefined();
    expect(report.nTasks).toBe(30);
    expect(report.results).toHaveLength(5);
    expect(report.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("single-shot has accuracy in [0,1] and cost.calls = 1", async () => {
    const report = await runBench();
    const ss = report.results.find((r) => r.strategyName === "single-shot");
    expect(ss).toBeDefined();
    expect(ss?.accuracy).toBeGreaterThanOrEqual(0);
    expect(ss?.accuracy).toBeLessThanOrEqual(1);
    expect(ss?.meanCostCalls).toBe(1);
  });

  it("BoN and BoN-MAV variants have cost.calls = 4", async () => {
    const report = await runBench();
    for (const r of report.results.filter((r) => r.strategyName !== "single-shot")) {
      expect(r.meanCostCalls).toBe(4);
    }
  });

  it("all numeric fields are finite (no NaN / Infinity)", async () => {
    const report = await runBench();
    for (const r of report.results) {
      expect(Number.isFinite(r.accuracy)).toBe(true);
      expect(Number.isFinite(r.accuracyCI.lo95)).toBe(true);
      expect(Number.isFinite(r.accuracyCI.hi95)).toBe(true);
      expect(Number.isFinite(r.meanCostCalls)).toBe(true);
      expect(Number.isFinite(r.meanLatencyMs)).toBe(true);
      expect(Number.isFinite(r.latencyCI.lo95)).toBe(true);
      expect(Number.isFinite(r.latencyCI.hi95)).toBe(true);
    }
  });

  it("CI bounds are ordered: lo95 <= mean <= hi95", async () => {
    const report = await runBench();
    for (const r of report.results) {
      expect(r.accuracyCI.lo95).toBeLessThanOrEqual(r.accuracy + 1e-9);
      expect(r.accuracy).toBeLessThanOrEqual(r.accuracyCI.hi95 + 1e-9);
    }
  });

  it("all 5 strategy names are present", async () => {
    const report = await runBench();
    const names = report.results.map((r) => r.strategyName);
    expect(names).toContain("single-shot");
    expect(names).toContain("best-of-n-4 (composite reward)");
    expect(names).toContain("bon-mav-4 (mean)");
    expect(names).toContain("bon-mav-4 (median)");
    expect(names).toContain("bon-mav-4 (majority-vote)");
  });
});
