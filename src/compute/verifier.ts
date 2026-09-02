/**
 * Verifier — caller-provided domain-specific evaluation interface.
 *
 * Design intent:
 * - No built-in verifier pool or registry. Each caller constructs their own
 *   verifier that encodes domain knowledge (math, code correctness, policy, …).
 * - `evaluate` may be sync or async to accommodate both lightweight heuristics
 *   and LLM-backed judges without forcing unnecessary Promise overhead.
 * - `name` is mandatory for telemetry correlation (spans, metrics, logs).
 */

// ─── Result ──────────────────────────────────────────────────────────────────

/**
 * Output of a single verifier evaluation.
 * @public
 */
export interface VerifierResult {
  /**
   * Continuous score in [0, 1] inclusive.
   * 0 = reject (completely wrong), 1 = accept (fully correct).
   * Intermediate values signal partial quality (e.g. 0.75 = mostly correct).
   */
  score: number;
  /** Human-readable explanation of the score for debugging and audit. */
  rationale: string;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * Domain-specific verifier supplied by the caller.
 *
 * @typeParam TOutput - Shape of the agent output being evaluated.
 *   Defaults to `unknown` so callers can start untyped and tighten later.
 * @public
 */
export interface Verifier<TOutput = unknown> {
  /**
   * Stable identifier used in telemetry (spans, metrics, audit logs).
   * Recommended format: kebab-case, e.g. "math-correctness", "policy-guard".
   */
  readonly name: string;

  /**
   * Evaluate the agent output and return a quality score with rationale.
   *
   * Returning a plain `VerifierResult` (no Promise) is allowed for sync
   * verifiers to avoid unnecessary microtask overhead. Callers that `await`
   * the result handle both cases transparently.
   */
  evaluate(output: TOutput): Promise<VerifierResult> | VerifierResult;
}

// ─── Runtime guard ───────────────────────────────────────────────────────────

/**
 * Assert that `r` is a valid {@link VerifierResult} at runtime.
 *
 * Throws a `TypeError` with a descriptive message when:
 * - `r` is null or not an object
 * - `score` is not a finite number in [0, 1]
 * - `rationale` is not a string
 *
 * Use this after `await verifier.evaluate(output)` when the verifier is
 * provided by untrusted third-party code.
 * @public
 */
export function assertVerifierResult(r: VerifierResult): void {
  if (r === null || r === undefined || typeof r !== "object") {
    throw new TypeError(
      `assertVerifierResult: expected an object, got ${r === null ? "null" : typeof r}`,
    );
  }

  const { score, rationale } = r as unknown as Record<string, unknown>;

  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new TypeError(
      `assertVerifierResult: score must be a finite number in [0,1], got ${String(score)}`,
    );
  }

  if (typeof rationale !== "string") {
    throw new TypeError(
      `assertVerifierResult: rationale must be a string, got ${typeof rationale}`,
    );
  }
}
