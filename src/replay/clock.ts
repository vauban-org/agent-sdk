/**
 * ClockPort — virtualized wall-clock for deterministic replay.
 *
 * - RealClock: delegates to Date.now() for production use.
 * - RecordedClock: replays a fixed sequence of timestamps from an original run.
 *   Throws ClockExhaustedError when all recorded timestamps are consumed.
 *
 * Usage during replay:
 *   const clock = new RecordedClock(originalRun.timestamps);
 *   // Pass clock to the agent harness instead of RealClock.
 *   // Every clock.now() call returns the next recorded value in order.
 *
 * @module replay/clock
 */

// ─── ClockPort interface ──────────────────────────────────────────────────────

/**
 * Abstract wall-clock port.
 * Inject a concrete implementation into the agent harness at boot time.
 * @public
 */
export interface ClockPort {
  /** Returns the current time as Unix epoch milliseconds. */
  now(): number;
}

// ─── RealClock ────────────────────────────────────────────────────────────────

/**
 * Production implementation: delegates to Date.now().
 * Non-deterministic by design — do NOT use during replay.
 * @public
 */
export class RealClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}

// ─── ClockExhaustedError ──────────────────────────────────────────────────────

/**
 * Thrown by RecordedClock when the cursor exceeds the recorded timestamps array.
 * Signals that the replay agent made more clock calls than the original run —
 * a sign of non-deterministic branching in the agent code.
 * @public
 */
export class ClockExhaustedError extends Error {
  constructor(recorded: number, requested: number) {
    super(`Clock exhausted: ${recorded} timestamps recorded, ${requested + 1} requested`);
    this.name = "ClockExhaustedError";
  }
}

// ─── RecordedClock ────────────────────────────────────────────────────────────

/**
 * Replay implementation: replays timestamps from an original run in order.
 *
 * Each call to now() returns the next recorded timestamp.
 * Throws ClockExhaustedError if the replay makes more clock calls
 * than were recorded in the original run.
 *
 * Thread safety: not thread-safe — single-agent use only.
 * @public
 */
export class RecordedClock implements ClockPort {
  private cursor = 0;

  constructor(private readonly recordedTs: readonly number[]) {}

  now(): number {
    if (this.cursor >= this.recordedTs.length) {
      throw new ClockExhaustedError(this.recordedTs.length, this.cursor);
    }
    return this.recordedTs[this.cursor++];
  }

  /** Returns the current cursor position (number of timestamps consumed). */
  getCursor(): number {
    return this.cursor;
  }

  /** Resets the cursor to zero so the same sequence can be replayed again. */
  reset(): void {
    this.cursor = 0;
  }

  /**
   * Returns a new RecordedClock that shares the same underlying timestamp array
   * and starts at the CURRENT cursor position. Advancing either clone or the
   * original advances only its own cursor — the arrays are shared (read-only),
   * but cursors are independent. Use for cross-cycle propagation where the child
   * cycle consumes the NEXT timestamps in the same sequence.
   *
   * Clone invariant: clone.now() returns the same value as `this.now()` would
   * at the moment clone() is called, and both consume subsequent timestamps
   * in the same order from the same array.
   */
  clone(): RecordedClock {
    const child = new RecordedClock(this.recordedTs);
    child.cursor = this.cursor;
    return child;
  }
}
