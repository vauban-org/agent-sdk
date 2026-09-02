/**
 * Unit tests for ResourceLimitsRunner — sprint-525:quick-2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceLimitsRunner,
  StepCountExceededError,
} from "../src/orchestration/ooda/resource-limits.js";

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

describe("ResourceLimitsRunner — constructor defaults", () => {
  it("applies default phaseTimeoutMs = 60000", () => {
    const runner = new ResourceLimitsRunner();
    expect(runner.phaseTimeoutMs).toBe(60_000);
  });

  it("applies default maxStepsPerCycle = 200", () => {
    const runner = new ResourceLimitsRunner();
    expect(runner.maxStepsPerCycle).toBe(200);
  });

  it("applies default maxHeapMb = 256", () => {
    const runner = new ResourceLimitsRunner();
    expect(runner.maxHeapMb).toBe(256);
  });

  it("respects custom phaseTimeoutMs", () => {
    const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 5_000 });
    expect(runner.phaseTimeoutMs).toBe(5_000);
  });

  it("respects custom maxStepsPerCycle", () => {
    const runner = new ResourceLimitsRunner({ maxStepsPerCycle: 50 });
    expect(runner.maxStepsPerCycle).toBe(50);
  });

  it("respects custom maxHeapMb", () => {
    const runner = new ResourceLimitsRunner({ maxHeapMb: 512 });
    expect(runner.maxHeapMb).toBe(512);
  });

  it("throws when phaseTimeoutMs <= 0", () => {
    expect(() => new ResourceLimitsRunner({ phaseTimeoutMs: 0 })).toThrow(
      "phaseTimeoutMs must be > 0",
    );
  });

  it("throws when phaseTimeoutMs is negative", () => {
    expect(() => new ResourceLimitsRunner({ phaseTimeoutMs: -1 })).toThrow(
      "phaseTimeoutMs must be > 0",
    );
  });

  it("throws when maxStepsPerCycle <= 0", () => {
    expect(() => new ResourceLimitsRunner({ maxStepsPerCycle: 0 })).toThrow(
      "maxStepsPerCycle must be > 0",
    );
  });

  it("throws when maxHeapMb <= 0", () => {
    expect(() => new ResourceLimitsRunner({ maxHeapMb: 0 })).toThrow("maxHeapMb must be > 0");
  });
});

// ---------------------------------------------------------------------------
// StepCountExceededError
// ---------------------------------------------------------------------------

describe("StepCountExceededError", () => {
  it("has name === 'StepCountExceededError'", () => {
    const err = new StepCountExceededError(5, 3);
    expect(err.name).toBe("StepCountExceededError");
  });

  it("has code === 'OODA_STEP_COUNT_EXCEEDED'", () => {
    const err = new StepCountExceededError(5, 3);
    expect(err.code).toBe("OODA_STEP_COUNT_EXCEEDED");
  });

  it("is instanceof Error", () => {
    const err = new StepCountExceededError(5, 3);
    expect(err instanceof Error).toBe(true);
  });

  it("message includes the current count", () => {
    const err = new StepCountExceededError(42, 10);
    expect(err.message).toContain("42");
  });

  it("message includes the max value", () => {
    const err = new StepCountExceededError(42, 10);
    expect(err.message).toContain("10");
  });
});

// ---------------------------------------------------------------------------
// enforceStepCount
// ---------------------------------------------------------------------------

describe("ResourceLimitsRunner.enforceStepCount", () => {
  const runner = new ResourceLimitsRunner({ maxStepsPerCycle: 10 });

  it("does not throw when count is below max", () => {
    expect(() => runner.enforceStepCount(9)).not.toThrow();
  });

  it("does not throw when count equals max (at limit, not exceeded)", () => {
    expect(() => runner.enforceStepCount(10)).not.toThrow();
  });

  it("throws StepCountExceededError when count exceeds max", () => {
    expect(() => runner.enforceStepCount(11)).toThrow(StepCountExceededError);
  });

  it("error carries correct currentCount", () => {
    let caught: StepCountExceededError | undefined;
    try {
      runner.enforceStepCount(15);
    } catch (e) {
      caught = e as StepCountExceededError;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("15");
  });

  it("error carries correct max value", () => {
    let caught: StepCountExceededError | undefined;
    try {
      runner.enforceStepCount(15);
    } catch (e) {
      caught = e as StepCountExceededError;
    }
    expect(caught?.message).toContain("10");
  });

  it("does not throw for count = 0", () => {
    expect(() => runner.enforceStepCount(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createPhaseAbortController
// ---------------------------------------------------------------------------

describe("ResourceLimitsRunner.createPhaseAbortController", () => {
  it("returns an AbortController", () => {
    const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 10_000 });
    const ac = runner.createPhaseAbortController();
    expect(ac).toBeInstanceOf(AbortController);
  });

  it("signal is not aborted immediately after creation", () => {
    const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 10_000 });
    const ac = runner.createPhaseAbortController();
    expect(ac.signal.aborted).toBe(false);
  });

  it("signal supports addEventListener", () => {
    const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 10_000 });
    const ac = runner.createPhaseAbortController();
    expect(typeof ac.signal.addEventListener).toBe("function");
  });

  it("signal can be manually aborted before the timeout fires", () => {
    const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 10_000 });
    const ac = runner.createPhaseAbortController();
    ac.abort();
    expect(ac.signal.aborted).toBe(true);
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("signal aborts after phaseTimeoutMs elapses", () => {
      const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 1_000 });
      const ac = runner.createPhaseAbortController();
      expect(ac.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1_001);
      expect(ac.signal.aborted).toBe(true);
    });

    it("signal is still live just before timeout fires", () => {
      const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 2_000 });
      const ac = runner.createPhaseAbortController();
      vi.advanceTimersByTime(1_999);
      expect(ac.signal.aborted).toBe(false);
    });

    it("two controllers created with different timeouts abort independently", () => {
      const fast = new ResourceLimitsRunner({ phaseTimeoutMs: 500 });
      const slow = new ResourceLimitsRunner({ phaseTimeoutMs: 2_000 });
      const acFast = fast.createPhaseAbortController();
      const acSlow = slow.createPhaseAbortController();
      vi.advanceTimersByTime(600);
      expect(acFast.signal.aborted).toBe(true);
      expect(acSlow.signal.aborted).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// checkHeap
// ---------------------------------------------------------------------------

describe("ResourceLimitsRunner.checkHeap", () => {
  it("does not call onHeapExceeded when heap is below threshold", () => {
    const onHeapExceeded = vi.fn();
    // Use a very large threshold so the current process heap will be below it.
    const runner = new ResourceLimitsRunner({
      maxHeapMb: 999_999,
      onHeapExceeded,
    });
    runner.checkHeap();
    expect(onHeapExceeded).not.toHaveBeenCalled();
  });

  it("calls onHeapExceeded when heap exceeds threshold", () => {
    const onHeapExceeded = vi.fn();
    // Use threshold of 1 byte (effectively 0 MiB) so current heap always exceeds it.
    const runner = new ResourceLimitsRunner({
      maxHeapMb: 0.000001,
      onHeapExceeded,
    });
    runner.checkHeap();
    expect(onHeapExceeded).toHaveBeenCalledOnce();
  });

  it("onHeapExceeded callback receives rssMb, heapMb, and max fields", () => {
    const onHeapExceeded = vi.fn();
    const runner = new ResourceLimitsRunner({
      maxHeapMb: 0.000001,
      onHeapExceeded,
    });
    runner.checkHeap();
    const arg = onHeapExceeded.mock.calls[0]?.[0] as {
      rssMb: number;
      heapMb: number;
      max: number;
    };
    expect(typeof arg.rssMb).toBe("number");
    expect(typeof arg.heapMb).toBe("number");
    expect(arg.max).toBe(0.000001);
  });

  it("falls back to console.warn when no onHeapExceeded is provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = new ResourceLimitsRunner({ maxHeapMb: 0.000001 });
    runner.checkHeap();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not throw — checkHeap is always a no-throw operation", () => {
    const runner = new ResourceLimitsRunner({ maxHeapMb: 0.000001 });
    expect(() => runner.checkHeap()).not.toThrow();
  });
});
