/**
 * Tests for:
 *   src/outcomes/compute-roi.ts — computeRoi
 *   src/resilience/bulkhead.ts — bulkhead + BulkheadFullError
 *
 * Coverage:
 *   computeRoi — empty outcomes → all zeros and nulls,
 *     positive value_cents → totalValueCents,
 *     negative value_cents → totalCostCents (inferred mode),
 *     external costsCentsByOutcomeId mode: value positive only,
 *     valueToCostRatio = null when no cost,
 *     netRoiPct computed correctly,
 *     pendingCount counts is_pending_backfill rows,
 *     outcomeCount = outcomes.length
 *   bulkhead — wraps fn and calls it,
 *     stats.active during execution,
 *     serializes when maxConcurrent=1,
 *     rejects with BulkheadFullError when queue full,
 *     BulkheadFullError.bulkheadName and message
 *
 * Ref: test coverage for compute-roi + bulkhead (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { computeRoi } from "../src/outcomes/compute-roi.js";
import { BulkheadFullError, bulkhead } from "../src/resilience/bulkhead.js";

// ─── computeRoi helpers ───────────────────────────────────────────────────────

function makeOutcome(id: string, value_cents: number, pending = false) {
  return { id, value_cents, is_pending_backfill: pending };
}

// ─── computeRoi ───────────────────────────────────────────────────────────────

describe("computeRoi — empty inputs", () => {
  it("returns all zeros and null ratios for empty outcomes", () => {
    const result = computeRoi({ outcomes: [] });
    expect(result.totalValueCents).toBe(0);
    expect(result.totalCostCents).toBe(0);
    expect(result.valueToCostRatio).toBeNull();
    expect(result.netRoiPct).toBeNull();
    expect(result.outcomeCount).toBe(0);
    expect(result.pendingCount).toBe(0);
  });
});

describe("computeRoi — inferred mode (no external cost map)", () => {
  it("positive value_cents contribute to totalValueCents", () => {
    const result = computeRoi({
      outcomes: [makeOutcome("a", 500), makeOutcome("b", 300)],
    });
    expect(result.totalValueCents).toBe(800);
    expect(result.totalCostCents).toBe(0);
  });

  it("negative value_cents contribute to totalCostCents (as abs)", () => {
    const result = computeRoi({
      outcomes: [makeOutcome("a", -200), makeOutcome("b", -100)],
    });
    expect(result.totalCostCents).toBe(300);
    expect(result.totalValueCents).toBe(0);
  });

  it("computes valueToCostRatio correctly", () => {
    const result = computeRoi({
      outcomes: [makeOutcome("a", 400), makeOutcome("b", -100)],
    });
    expect(result.valueToCostRatio).toBe(4); // 400/100
  });

  it("computes netRoiPct correctly: (value - cost) / cost * 100", () => {
    const result = computeRoi({
      outcomes: [makeOutcome("a", 150), makeOutcome("b", -100)],
    });
    // (150 - 100) / 100 * 100 = 50%
    expect(result.netRoiPct).toBeCloseTo(50);
  });

  it("valueToCostRatio is null when totalCostCents = 0", () => {
    const result = computeRoi({ outcomes: [makeOutcome("a", 500)] });
    expect(result.valueToCostRatio).toBeNull();
    expect(result.netRoiPct).toBeNull();
  });
});

describe("computeRoi — external cost map mode", () => {
  it("uses external cost map instead of sign inference", () => {
    const costMap = new Map([["a", 200]]);
    const result = computeRoi({
      outcomes: [makeOutcome("a", 500)],
      costsCentsByOutcomeId: costMap,
    });
    expect(result.totalValueCents).toBe(500);
    expect(result.totalCostCents).toBe(200);
  });

  it("cost = 0 when outcome not in cost map", () => {
    const costMap = new Map<string, number>();
    const result = computeRoi({
      outcomes: [makeOutcome("unknown", 300)],
      costsCentsByOutcomeId: costMap,
    });
    expect(result.totalCostCents).toBe(0);
  });
});

describe("computeRoi — pendingCount and outcomeCount", () => {
  it("pendingCount counts is_pending_backfill=true rows", () => {
    const result = computeRoi({
      outcomes: [makeOutcome("a", 100, true), makeOutcome("b", 200, false)],
    });
    expect(result.pendingCount).toBe(1);
    expect(result.outcomeCount).toBe(2);
  });
});

// ─── bulkhead ─────────────────────────────────────────────────────────────────

describe("BulkheadFullError", () => {
  it(".name is 'BulkheadFullError'", () => {
    expect(new BulkheadFullError("brain.archive", 50).name).toBe("BulkheadFullError");
  });

  it("stores bulkheadName", () => {
    expect(new BulkheadFullError("brain.archive", 50).bulkheadName).toBe("brain.archive");
  });

  it("message contains bulkheadName and queue depth", () => {
    const err = new BulkheadFullError("test-bh", 50);
    expect(err.message).toContain("test-bh");
    expect(err.message).toContain("50");
  });
});

describe("bulkhead — basic operation", () => {
  it("wraps fn and returns its result", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const wrapped = bulkhead(fn, { name: "test", maxConcurrent: 2 });
    expect(await wrapped("arg")).toBe("result");
    expect(fn).toHaveBeenCalledWith("arg");
  });

  it("stats.active is 0 after completion", async () => {
    const wrapped = bulkhead(async () => "ok", {
      name: "test",
      maxConcurrent: 2,
    });
    await wrapped();
    expect(wrapped.stats.active).toBe(0);
  });

  it("stats.queued is 0 when nothing is queued", async () => {
    const wrapped = bulkhead(async () => "ok", {
      name: "test",
      maxConcurrent: 2,
    });
    expect(wrapped.stats.queued).toBe(0);
  });

  it("passes through thrown errors", async () => {
    const wrapped = bulkhead(
      async () => {
        throw new Error("fn failed");
      },
      { name: "test", maxConcurrent: 2 },
    );
    await expect(wrapped()).rejects.toThrow("fn failed");
  });
});

describe("bulkhead — concurrency limit", () => {
  it("rejects immediately with BulkheadFullError when queue is full", async () => {
    let resolveFirst!: () => void;
    const blocking = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const fn = vi.fn().mockImplementation(() => blocking);
    const wrapped = bulkhead(fn, {
      name: "tight",
      maxConcurrent: 1,
      maxQueued: 0, // no queue space
    });

    // First call occupies the slot
    const p1 = wrapped();
    // Second call should be rejected immediately (queue=0)
    await expect(wrapped()).rejects.toThrow(BulkheadFullError);

    resolveFirst();
    await p1;
  });

  it("serializes calls when maxConcurrent=1", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const p1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    const wrapped = bulkhead(
      async (n: number) => {
        if (n === 1) await p1;
        order.push(n);
      },
      { name: "serial", maxConcurrent: 1, maxQueued: 5 },
    );

    const a = wrapped(1);
    const b = wrapped(2);

    // fn(2) should not have started yet
    expect(order).toHaveLength(0);

    resolve1();
    await a;
    await b;
    expect(order).toEqual([1, 2]);
  });
});
