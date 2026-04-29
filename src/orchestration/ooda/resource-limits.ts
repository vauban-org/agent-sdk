/**
 * OODA resource limits runtime — sprint-525:quick-2.
 *
 * `ResourceLimitsRunner` is the runtime helper enforcing the
 * `ResourceLimits` interface declared in `./types.ts` (quick-1).
 * Hard caps on phase wall-clock, step count per cycle, and process heap
 * usage. Defaults are conservative; agents with heavier workloads MUST
 * raise them explicitly via the constructor — there is no implicit
 * "unlimited" mode.
 *
 * Usage:
 *   const runner = new ResourceLimitsRunner({ phaseTimeoutMs: 90_000 });
 *   const ac = runner.createPhaseAbortController();
 *   await runPhase(observePayload, { signal: ac.signal });
 *   runner.enforceStepCount(steps.length);
 *   runner.checkHeap();
 *
 * @public
 */

export interface ResourceLimitsOpts {
  /** Hard wall-clock limit per OODA phase. Default: 60_000 ms. */
  phaseTimeoutMs: number;
  /** Max steps allowed per OODA cycle. Default: 200. */
  maxStepsPerCycle: number;
  /** Soft heap warning threshold (MiB). Default: 256. */
  maxHeapMb: number;
  /** Optional warn sink for heap excess (defaults to console.warn). */
  onHeapExceeded?: (info: { rssMb: number; heapMb: number; max: number }) => void;
}

const DEFAULTS: ResourceLimitsOpts = {
  phaseTimeoutMs: 60_000,
  maxStepsPerCycle: 200,
  maxHeapMb: 256,
};

export class StepCountExceededError extends Error {
  readonly code = "OODA_STEP_COUNT_EXCEEDED";
  constructor(currentCount: number, max: number) {
    super(`[ooda] step count ${currentCount} exceeds max ${max} per cycle`);
    this.name = "StepCountExceededError";
  }
}

export class ResourceLimitsRunner {
  readonly phaseTimeoutMs: number;
  readonly maxStepsPerCycle: number;
  readonly maxHeapMb: number;
  private readonly onHeapExceeded?: ResourceLimitsOpts["onHeapExceeded"];

  constructor(opts: Partial<ResourceLimitsOpts> = {}) {
    const merged = { ...DEFAULTS, ...opts };
    if (merged.phaseTimeoutMs <= 0) {
      throw new Error("[ooda/resource-limits] phaseTimeoutMs must be > 0");
    }
    if (merged.maxStepsPerCycle <= 0) {
      throw new Error("[ooda/resource-limits] maxStepsPerCycle must be > 0");
    }
    if (merged.maxHeapMb <= 0) {
      throw new Error("[ooda/resource-limits] maxHeapMb must be > 0");
    }
    this.phaseTimeoutMs = merged.phaseTimeoutMs;
    this.maxStepsPerCycle = merged.maxStepsPerCycle;
    this.maxHeapMb = merged.maxHeapMb;
    this.onHeapExceeded = merged.onHeapExceeded;
  }

  /**
   * Build an AbortController whose signal trips after `phaseTimeoutMs`.
   * The host is responsible for forwarding the signal to async work
   * (fetch, MCP calls, child Promise.race, …) so the abort actually
   * propagates.
   */
  createPhaseAbortController(): AbortController {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort(new Error(`[ooda] phase timeout after ${this.phaseTimeoutMs}ms`));
    }, this.phaseTimeoutMs);
    // Don't keep the event loop alive purely for this watchdog.
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    // Cancel the timer on natural abort to free the timer slot.
    ac.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
    return ac;
  }

  /**
   * Throw if `currentCount` exceeds `maxStepsPerCycle`. Caller increments
   * the counter as steps are committed and calls this before the next
   * step starts.
   */
  enforceStepCount(currentCount: number): void {
    if (currentCount > this.maxStepsPerCycle) {
      throw new StepCountExceededError(currentCount, this.maxStepsPerCycle);
    }
  }

  /**
   * Sample the process heap and warn if it exceeds `maxHeapMb`. Pure
   * observability — never throws (a hard kill is the OS' job).
   */
  checkHeap(): void {
    if (typeof process === "undefined" || typeof process.memoryUsage !== "function") {
      return;
    }
    const mem = process.memoryUsage();
    const heapMb = mem.heapUsed / (1024 * 1024);
    const rssMb = mem.rss / (1024 * 1024);
    if (heapMb > this.maxHeapMb) {
      const info = { rssMb, heapMb, max: this.maxHeapMb };
      if (this.onHeapExceeded) {
        this.onHeapExceeded(info);
      } else {
        // eslint-disable-next-line no-console -- intentional fallback when no sink wired
        console.warn("[ooda/resource-limits] heap exceeded", info);
      }
    }
  }
}
