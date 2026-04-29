import { describe, expect, it } from "vitest";
import { computeRoi } from "../src/outcomes/compute-roi.js";
import type { Outcome } from "../src/outcomes/types.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeOutcome(
  id: string,
  valueCents: number,
  isPending = false,
): Outcome {
  return {
    id,
    agent_id: "agent-test",
    agent_run_id: null,
    outcome_type: "test_outcome",
    value_cents: valueCents,
    currency: "USD",
    occurred_at: "2026-04-28T00:00:00.000Z",
    is_pending_backfill: isPending,
    metadata: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeRoi", () => {
  it("returns all-zero result and null ratios for empty input", () => {
    const result = computeRoi({ outcomes: [] });
    expect(result).toEqual({
      totalValueCents: 0,
      totalCostCents: 0,
      valueToCostRatio: null,
      netRoiPct: null,
      outcomeCount: 0,
      pendingCount: 0,
    });
  });

  it("handles all-positive values with no costs (no external map)", () => {
    const outcomes = [
      makeOutcome("a", 1000),
      makeOutcome("b", 500),
    ];
    const result = computeRoi({ outcomes });
    expect(result.totalValueCents).toBe(1500);
    expect(result.totalCostCents).toBe(0);
    expect(result.valueToCostRatio).toBeNull();
    expect(result.netRoiPct).toBeNull();
    expect(result.outcomeCount).toBe(2);
  });

  it("infers cost from negative value_cents when no external map", () => {
    const outcomes = [
      makeOutcome("a", 2000),  // value
      makeOutcome("b", -800),  // cost
    ];
    const result = computeRoi({ outcomes });
    expect(result.totalValueCents).toBe(2000);
    expect(result.totalCostCents).toBe(800);
    expect(result.valueToCostRatio).toBeCloseTo(2000 / 800, 10);
    expect(result.netRoiPct).toBeCloseTo(((2000 - 800) / 800) * 100, 10);
  });

  it("uses external costsCentsByOutcomeId map when provided", () => {
    const outcomes = [
      makeOutcome("a", 3000),
      makeOutcome("b", 1000),
    ];
    const costMap = new Map<string, number>([
      ["a", 500],
      ["b", 200],
    ]);
    const result = computeRoi({ outcomes, costsCentsByOutcomeId: costMap });
    expect(result.totalValueCents).toBe(4000);
    expect(result.totalCostCents).toBe(700);
    expect(result.valueToCostRatio).toBeCloseTo(4000 / 700, 10);
    expect(result.netRoiPct).toBeCloseTo(((4000 - 700) / 700) * 100, 10);
  });

  it("defaults missing map entries to 0 cost when external map provided", () => {
    const outcomes = [makeOutcome("x", 500)];
    const costMap = new Map<string, number>(); // empty
    const result = computeRoi({ outcomes, costsCentsByOutcomeId: costMap });
    expect(result.totalCostCents).toBe(0);
    expect(result.valueToCostRatio).toBeNull();
  });

  it("counts pending outcomes correctly regardless of value sign", () => {
    const outcomes = [
      makeOutcome("a", 1000, true),   // pending + value
      makeOutcome("b", -200, true),   // pending + cost
      makeOutcome("c", 500, false),   // not pending
    ];
    const result = computeRoi({ outcomes });
    expect(result.pendingCount).toBe(2);
    expect(result.outcomeCount).toBe(3);
  });

  it("handles mixed signed values correctly (inferred mode)", () => {
    const outcomes = [
      makeOutcome("a", 5000),
      makeOutcome("b", -1000),
      makeOutcome("c", 3000),
      makeOutcome("d", -500),
    ];
    const result = computeRoi({ outcomes });
    expect(result.totalValueCents).toBe(8000);
    expect(result.totalCostCents).toBe(1500);
    expect(result.netRoiPct).toBeCloseTo(((8000 - 1500) / 1500) * 100, 10);
    expect(result.outcomeCount).toBe(4);
  });

  it("handles zero-value outcomes correctly", () => {
    const outcomes = [makeOutcome("a", 0)];
    const result = computeRoi({ outcomes });
    expect(result.totalValueCents).toBe(0);
    expect(result.totalCostCents).toBe(0);
    expect(result.valueToCostRatio).toBeNull();
    expect(result.netRoiPct).toBeNull();
  });
});
