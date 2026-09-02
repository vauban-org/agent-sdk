/**
 * src/compute/strategies/two-phase-orient.ts
 *
 * Two-Phase Orient pattern.
 *
 * Phase 1 — Orient: read-only context gathering, produces an orientation state.
 * Phase 2 — Act:    state-mutating execution driven by the orientation.
 *
 * The separation enforces a hard OODA discipline:
 * - Phase 1 has no side effects; it may be retried cheaply on failure.
 * - Phase 2 consumes the orientation and may be retried up to `maxActRetries`.
 *
 * Error semantics:
 * - `TwoPhaseOrientError` (phase: "orient") — Phase 1 threw; Phase 2 is never reached.
 * - `TwoPhaseOrientError` (phase: "act")    — Phase 2 exhausted all retries.
 * - Each Phase 2 retry attempt is tracked in `retriesUsed` (0 = first attempt succeeded).
 * @public
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TwoPhaseOrientError extends Error {
  readonly phase: "orient" | "act";
  readonly cause: unknown;
  readonly retriesUsed: number;

  constructor(phase: "orient" | "act", cause: unknown, retriesUsed: number, message: string) {
    super(message);
    this.name = "TwoPhaseOrientError";
    this.phase = phase;
    this.cause = cause;
    this.retriesUsed = retriesUsed;
    // Restore prototype chain (tsc targets < ES2022)
    Object.setPrototypeOf(this, TwoPhaseOrientError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Config + return type
// ---------------------------------------------------------------------------

/** @public */
export interface TwoPhaseOrientConfig<C, O, R> {
  /**
   * Phase 1: orientation (read-only, observe + analyse).
   * Receives the raw context and returns an orientation state.
   * Must not produce observable side effects.
   */
  orient: (context: C) => Promise<O>;

  /**
   * Phase 2: act on the orientation.
   * Receives both the orientation produced by Phase 1 and the original context.
   * Returns the final result.
   */
  act: (orientation: O, context: C) => Promise<R>;

  /**
   * Maximum number of times Phase 2 may be retried after a recoverable failure.
   * `maxActRetries = 1` means one initial attempt + one retry = 2 total attempts.
   * Default: 1.
   * Must be a non-negative integer; values < 0 are treated as 0.
   */
  maxActRetries?: number;
}

/** @public */
export interface TwoPhaseOrientResult<O, R> {
  orientation: O;
  result: R;
  /** Number of Phase-2 retries consumed (0 = succeeded on first attempt). */
  retriesUsed: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Executes the Two-Phase Orient pattern.
 *
 * @param config  Wiring for both phases + optional retry cap.
 * @param context Opaque context forwarded to both `orient` and `act`.
 *
 * @throws {TwoPhaseOrientError} When Phase 1 throws (phase: "orient") or
 *   Phase 2 exhausts all retries (phase: "act").
 *
 * @example
 * ```ts
 * const { orientation, result, retriesUsed } = await runTwoPhaseOrient(
 *   {
 *     orient: async (ctx) => await gatherSignals(ctx),
 *     act:    async (orient, ctx) => await executeDecision(orient, ctx),
 *   },
 *   requestContext,
 * );
 * ```
 * @public
 */
export async function runTwoPhaseOrient<C, O, R>(
  config: TwoPhaseOrientConfig<C, O, R>,
  context: C,
): Promise<TwoPhaseOrientResult<O, R>> {
  const maxRetries = Math.max(0, Math.floor(config.maxActRetries ?? 1));

  // ── Phase 1: Orient ───────────────────────────────────────────────────────
  let orientation: O;
  try {
    orientation = await config.orient(context);
  } catch (err) {
    throw new TwoPhaseOrientError(
      "orient",
      err,
      0,
      `TwoPhaseOrient Phase 1 (orient) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Phase 2: Act (with retries) ───────────────────────────────────────────
  let lastActError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await config.act(orientation, context);
      return { orientation, result, retriesUsed: attempt };
    } catch (err) {
      lastActError = err;
      // Continue to next attempt if retries remain.
    }
  }

  // All attempts exhausted.
  throw new TwoPhaseOrientError(
    "act",
    lastActError,
    maxRetries,
    `TwoPhaseOrient Phase 2 (act) failed after ${maxRetries + 1} attempt(s): ${
      lastActError instanceof Error ? lastActError.message : String(lastActError)
    }`,
  );
}
