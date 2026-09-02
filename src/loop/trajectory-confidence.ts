/**
 * trajectory-confidence — cumulative confidence tracker for agentic sessions.
 *
 * Reference: Agentic Confidence Calibration (ACC, arXiv:2601.15778).
 *
 * Motivation: per-step confidence fluctuations are noisy. Early low-confidence
 * decisions propagate and poison downstream steps, so the correct interrupt
 * signal is a DROP IN TRAJECTORY CONFIDENCE (the EWMA over recent steps), not
 * a single-step low score. Interrupting only on per-step lows misses cumulative
 * degradation; interrupting on trajectory lows catches compounding uncertainty
 * before it manifests as a hard failure.
 *
 * Design choices:
 * - EWMA (exponentially-weighted moving average) because it is O(1) memory and
 *   naturally up-weights recent observations without a hard window cut-off.
 * - Default alpha=0.3: moderate responsiveness. Higher alpha (e.g. 0.5) is more
 *   reactive; lower alpha (e.g. 0.1) is more inertial. Configurable per caller.
 * - Default tau=0.70: matches ACC paper recommendation for HITL trigger threshold.
 * - Require >=2 observations before recommending interrupt: avoids false positives
 *   on a single uncertain first step.
 *
 * Pure module: no I/O, no imports beyond this file. Stateless except the
 * mutable tracker instance. Thread-safe within a single-threaded JS runtime.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

/**
 * Configuration for a {@link TrajectoryConfidenceTracker}.
 * All fields are optional; defaults are documented inline.
 * @public
 */
export interface TrajectoryConfidenceConfig {
  /**
   * Seed confidence injected as the first implicit observation.
   * Default: 1.0 (fully confident at session start).
   */
  initial?: number;
  /**
   * EWMA alpha — weight assigned to the newest observation.
   * Must be in (0, 1]. Default: 0.3.
   *
   * `ewma_new = alpha * stepConfidence + (1 - alpha) * ewma_prev`
   */
  alpha?: number;
  /**
   * Interrupt threshold tau.
   * When trajectory confidence < tau AND >=2 observations have been
   * recorded, {@link TrajectoryConfidenceTracker.isInterruptRecommended}
   * returns true. Default: 0.70.
   */
  tau?: number;
}

// ─── State snapshot ────────────────────────────────────────────────────────

/**
 * Point-in-time snapshot of the tracker state.
 * Returned by {@link TrajectoryConfidenceTracker.observe} and
 * {@link TrajectoryConfidenceTracker.snapshot}.
 * @public
 */
export interface TrajectoryConfidenceState {
  /** Current trajectory confidence (EWMA), in [0, 1]. */
  value: number;
  /** Number of per-step observations recorded so far. */
  observations: number;
  /** Highest trajectory value seen since construction or last reset. */
  peak: number;
  /** Lowest trajectory value seen since construction or last reset. */
  trough: number;
}

// ─── Tracker ──────────────────────────────────────────────────────────────

/**
 * Tracks cumulative agent confidence across a session using an EWMA.
 *
 * Construct one tracker per session; call `observe` after each tool
 * call with the confidence score extracted from the tool's {@link RiskVector}
 * (or any other per-step confidence signal). Call
 * `isInterruptRecommended` to decide whether to route to HITL.
 *
 * @example
 * ```ts
 * import { TrajectoryConfidenceTracker } from "@vauban-org/agent-sdk";
 *
 * const tracker = new TrajectoryConfidenceTracker({ tau: 0.70 });
 *
 * for (const step of agentSteps) {
 *   const state = tracker.observe(step.riskVector.confidence);
 *   if (tracker.isInterruptRecommended()) {
 *     await hitlGate.requestApproval({ reason: "trajectory_confidence_low", state });
 *   }
 * }
 * ```
 * @public
 */
export class TrajectoryConfidenceTracker {
  private readonly _alpha: number;
  private readonly _tau: number;
  private readonly _initial: number;

  private _value: number;
  private _observations: number;
  private _peak: number;
  private _trough: number;

  constructor(config?: TrajectoryConfidenceConfig) {
    const initial = config?.initial ?? 1.0;
    const alpha = config?.alpha ?? 0.3;
    const tau = config?.tau ?? 0.7;

    // Validate initial
    if (!Number.isFinite(initial)) {
      throw new RangeError(
        `TrajectoryConfidenceTracker: initial must be a finite number, got ${String(initial)}`,
      );
    }
    // Validate alpha
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
      throw new RangeError(
        `TrajectoryConfidenceTracker: alpha must be in (0, 1], got ${String(alpha)}`,
      );
    }
    // Validate tau
    if (!Number.isFinite(tau) || tau < 0 || tau > 1) {
      throw new RangeError(
        `TrajectoryConfidenceTracker: tau must be in [0, 1], got ${String(tau)}`,
      );
    }

    this._alpha = alpha;
    this._tau = tau;
    this._initial = Math.max(0, Math.min(1, initial));

    this._value = this._initial;
    this._observations = 0;
    this._peak = this._initial;
    this._trough = this._initial;
  }

  /**
   * Record a new per-step confidence score and update the EWMA.
   *
   * The input is clamped to [0, 1]. NaN and non-finite values throw.
   *
   * @param stepConfidence Per-step confidence in [0, 1]. Typically
   *   `riskVector.confidence` from the tool's {@link RiskVector}.
   * @returns The updated {@link TrajectoryConfidenceState}.
   */
  observe(stepConfidence: number): TrajectoryConfidenceState {
    if (!Number.isFinite(stepConfidence)) {
      throw new RangeError(
        `TrajectoryConfidenceTracker.observe: stepConfidence must be a finite number, got ${String(
          stepConfidence,
        )}`,
      );
    }

    const clamped = Math.max(0, Math.min(1, stepConfidence));
    this._value = this._alpha * clamped + (1 - this._alpha) * this._value;
    this._observations++;

    if (this._value > this._peak) this._peak = this._value;
    if (this._value < this._trough) this._trough = this._value;

    return this.snapshot();
  }

  /**
   * Return the current tracker state without recording a new observation.
   */
  snapshot(): TrajectoryConfidenceState {
    return {
      value: this._value,
      observations: this._observations,
      peak: this._peak,
      trough: this._trough,
    };
  }

  /**
   * Returns true when both conditions hold:
   * 1. At least 2 observations have been recorded.
   * 2. The current trajectory confidence is strictly below tau.
   *
   * The 2-observation minimum prevents false positives on a single uncertain
   * first step (no trajectory context yet).
   */
  isInterruptRecommended(): boolean {
    return this._observations >= 2 && this._value < this._tau;
  }

  /**
   * Reset all state to the initial configuration values.
   * Useful on `/clear` or new sub-task boundaries within the same session.
   */
  reset(): void {
    this._value = this._initial;
    this._observations = 0;
    this._peak = this._initial;
    this._trough = this._initial;
  }
}
