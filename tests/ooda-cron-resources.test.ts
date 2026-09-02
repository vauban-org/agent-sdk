/**
 * Tests for ooda/cron-schedule.ts + ooda/resource-limits.ts
 *
 * Coverage (cron-schedule):
 *   cronSessionGuard — throws on invalid expression,
 *     "* * * * *" matches any date,
 *     specific minute+hour, range, step, list
 *
 * Coverage (resource-limits):
 *   ResourceLimitsRunner — constructor defaults, validation errors,
 *     enforceStepCount — passes under limit, throws StepCountExceededError at limit+1,
 *     checkHeap — calls onHeapExceeded when threshold exceeded (mock memoryUsage),
 *     createPhaseAbortController — returns AbortController (not yet aborted)
 *
 * Ref: test coverage for ooda/cron-schedule.ts + ooda/resource-limits.ts (no prior tests)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronSessionGuard } from "../src/orchestration/ooda/cron-schedule.js";
import {
  ResourceLimitsRunner,
  StepCountExceededError,
} from "../src/orchestration/ooda/resource-limits.js";

// ─── cronSessionGuard ──────────────────────────────────────────────────────────

describe("cronSessionGuard", () => {
  it("throws for invalid expression (wrong field count)", () => {
    expect(() => cronSessionGuard("* * * *")).toThrow("5 fields");
  });

  it("'* * * * *' matches any date", async () => {
    const guard = cronSessionGuard("* * * * *");
    expect(await guard.isActive(new Date())).toBe(true);
  });

  it("guard name includes the expression", () => {
    const guard = cronSessionGuard("0 9 * * 1-5");
    expect(guard.name).toContain("0 9 * * 1-5");
  });

  it("specific minute+hour: matches exact time", async () => {
    // "30 14 * * *" = 14:30 UTC any day
    const guard = cronSessionGuard("30 14 * * *");
    const match = new Date("2026-01-05T14:30:00Z"); // Monday 14:30 UTC
    const miss = new Date("2026-01-05T14:31:00Z");
    expect(await guard.isActive(match)).toBe(true);
    expect(await guard.isActive(miss)).toBe(false);
  });

  it("weekday range 1-5: matches Monday, not Sunday (0)", async () => {
    const guard = cronSessionGuard("0 9 * * 1-5");
    const monday = new Date("2026-01-05T09:00:00Z"); // Monday
    const sunday = new Date("2026-01-04T09:00:00Z"); // Sunday
    expect(await guard.isActive(monday)).toBe(true);
    expect(await guard.isActive(sunday)).toBe(false);
  });

  it("step: */15 * * * * matches minute 0, 15, 30, 45", async () => {
    const guard = cronSessionGuard("*/15 * * * *");
    const m0 = new Date("2026-01-01T10:00:00Z");
    const m15 = new Date("2026-01-01T10:15:00Z");
    const m30 = new Date("2026-01-01T10:30:00Z");
    const m10 = new Date("2026-01-01T10:10:00Z");
    for (const d of [m0, m15, m30]) {
      expect(await guard.isActive(d)).toBe(true);
    }
    expect(await guard.isActive(m10)).toBe(false);
  });

  it("list: 0,30 matches minute 0 and 30 but not 15", async () => {
    const guard = cronSessionGuard("0,30 * * * *");
    const m0 = new Date("2026-01-01T10:00:00Z");
    const m30 = new Date("2026-01-01T10:30:00Z");
    const m15 = new Date("2026-01-01T10:15:00Z");
    expect(await guard.isActive(m0)).toBe(true);
    expect(await guard.isActive(m30)).toBe(true);
    expect(await guard.isActive(m15)).toBe(false);
  });
});

// ─── ResourceLimitsRunner ─────────────────────────────────────────────────────

describe("ResourceLimitsRunner", () => {
  it("uses default values when no opts provided", () => {
    const runner = new ResourceLimitsRunner();
    expect(runner.phaseTimeoutMs).toBe(60_000);
    expect(runner.maxStepsPerCycle).toBe(200);
    expect(runner.maxHeapMb).toBe(256);
  });

  it("overrides defaults with provided values", () => {
    const runner = new ResourceLimitsRunner({
      phaseTimeoutMs: 30_000,
      maxStepsPerCycle: 100,
    });
    expect(runner.phaseTimeoutMs).toBe(30_000);
    expect(runner.maxStepsPerCycle).toBe(100);
  });

  it("throws when phaseTimeoutMs <= 0", () => {
    expect(() => new ResourceLimitsRunner({ phaseTimeoutMs: 0 })).toThrow("phaseTimeoutMs");
  });

  it("throws when maxStepsPerCycle <= 0", () => {
    expect(() => new ResourceLimitsRunner({ maxStepsPerCycle: 0 })).toThrow("maxStepsPerCycle");
  });

  describe("enforceStepCount", () => {
    it("does not throw when count is within limit", () => {
      const runner = new ResourceLimitsRunner({ maxStepsPerCycle: 10 });
      expect(() => runner.enforceStepCount(10)).not.toThrow();
      expect(() => runner.enforceStepCount(5)).not.toThrow();
    });

    it("throws StepCountExceededError when count exceeds limit", () => {
      const runner = new ResourceLimitsRunner({ maxStepsPerCycle: 10 });
      expect(() => runner.enforceStepCount(11)).toThrow(StepCountExceededError);
    });

    it("StepCountExceededError has correct code and name", () => {
      const err = new StepCountExceededError(11, 10);
      expect(err.code).toBe("OODA_STEP_COUNT_EXCEEDED");
      expect(err.name).toBe("StepCountExceededError");
    });
  });

  describe("checkHeap", () => {
    it("calls onHeapExceeded when heap exceeds threshold", () => {
      const onHeapExceeded = vi.fn();
      const runner = new ResourceLimitsRunner({ maxHeapMb: 1, onHeapExceeded });
      // Process heap will definitely exceed 1 MiB
      runner.checkHeap();
      expect(onHeapExceeded).toHaveBeenCalledOnce();
      const info = onHeapExceeded.mock.calls[0][0];
      expect(info.max).toBe(1);
      expect(info.heapMb).toBeGreaterThan(1);
    });

    it("does not call onHeapExceeded when heap is within threshold", () => {
      const onHeapExceeded = vi.fn();
      const runner = new ResourceLimitsRunner({
        maxHeapMb: 99999,
        onHeapExceeded,
      });
      runner.checkHeap();
      expect(onHeapExceeded).not.toHaveBeenCalled();
    });

    it("does not throw even when heap exceeds threshold (soft warning only)", () => {
      const runner = new ResourceLimitsRunner({ maxHeapMb: 1 });
      expect(() => runner.checkHeap()).not.toThrow();
    });
  });

  describe("createPhaseAbortController", () => {
    it("returns an AbortController that is not yet aborted", () => {
      const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 60_000 });
      const ac = runner.createPhaseAbortController();
      expect(ac.signal.aborted).toBe(false);
      ac.abort(); // clean up
    });
  });
});
