/**
 * critic.ts — CRITIC pattern: tool-grounded self-correction loop.
 *
 * Reference: Gou et al., "CRITIC: Large Language Models Can Self-Correct with
 * Tool-Interactive Critiquing", ICLR 2024, arXiv:2305.11738.
 *
 * Design invariant (enforced by the API shape):
 *   Correction is TOOL-GROUNDED only. The verifier MUST produce a structured
 *   discrepancy derived from an external tool call (e.g. run tests, grep,
 *   syntax check, type-check). Pure LLM introspection is explicitly NOT
 *   supported here.
 *
 *   Rationale: Huang et al. (arXiv:2310.01798, "Large Language Models Cannot
 *   Self-Correct Reasoning Yet") demonstrate that models evaluating their own
 *   outputs without external grounding produce net-negative corrections.
 *   Tool-grounded feedback (deterministic oracle, static analyser, test runner)
 *   is the only form of self-correction with reliable empirical gains.
 *
 * Usage example:
 *
 * ```ts
 * import { criticLoop, type CriticVerifier } from "@vauban-org/agent-sdk";
 *
 * // Fake verifier: rejects outputs shorter than 10 chars.
 * const lengthCheck: CriticVerifier<string> = async (output) => {
 *   if (output.length >= 10) return { ok: true };
 *   return { ok: false, discrepancy: `Output too short: ${output.length} chars (min 10)` };
 * };
 *
 * // Fake reviser: pads the string to satisfy the verifier.
 * const padReviser = async (current: string, discrepancy: string): Promise<string> => {
 *   void discrepancy; // use discrepancy to build a targeted revision prompt
 *   return current.padEnd(10, ".");
 * };
 *
 * const result = await criticLoop("hi", lengthCheck, padReviser);
 * // result.output   → "hi........"
 * // result.rounds   → 1
 * // result.verified → true
 * // result.history  → [{ round: 1, discrepancy: "Output too short: 2 chars (min 10)" }]
 * ```
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A tool-grounded verifier.
 *
 * The implementation MUST invoke an external tool (test runner, linter, grep,
 * type checker, schema validator, …) and translate its output into either
 * `{ ok: true }` or `{ ok: false; discrepancy: string }`.
 *
 * Do NOT implement this by asking an LLM to rate its own output — see module
 * doc for the Huang et al. rationale.
 *
 * @alpha
 */
export type CriticVerifier<T> = (
  output: T,
) => Promise<{ ok: true } | { ok: false; discrepancy: string }>;

/**
 * A single entry in the correction history.
 *
 * @alpha
 */
export interface CriticHistoryEntry {
  /** 1-based correction round number. */
  round: number;
  /** Structured discrepancy string produced by the tool-grounded verifier. */
  discrepancy: string;
}

/**
 * Result returned by {@link criticLoop}.
 *
 * @alpha
 */
export interface CriticResult<T> {
  /**
   * Final accepted output (after up to `maxRounds` revisions).
   * If verification never passes, this is the last revised output.
   */
  output: T;
  /**
   * Number of correction rounds applied.
   * 0 means the initial output passed verification on the first attempt.
   */
  rounds: number;
  /**
   * Whether the final output passed the tool-grounded verifier.
   * `false` means `maxRounds` was exhausted without a passing verification.
   */
  verified: boolean;
  /**
   * Ordered history of discrepancies for telemetry, logging, and fine-tuning.
   * Empty when `rounds === 0`.
   */
  history: CriticHistoryEntry[];
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Apply a tool-grounded self-correction loop (CRITIC pattern).
 *
 * The loop:
 * 1. Verifies `initial` using the tool-grounded `verify` function.
 * 2. If verification passes → returns immediately (`rounds = 0`).
 * 3. Otherwise → calls `revise(current, discrepancy)` to produce a new
 *    candidate and repeats from step 1, up to `maxRounds` times.
 * 4. Stops when either (a) verification passes or (b) `maxRounds` is reached.
 *
 * Pure module: no side effects, no I/O, no logging.
 * The caller supplies all behaviour via `verify` and `revise`.
 *
 * @param initial   - The initial generated output to verify and potentially revise.
 * @param verify    - Tool-grounded verifier (must call an external tool, not LLM introspection).
 * @param revise    - Produces a revised output given the current output and the discrepancy.
 * @param maxRounds - Maximum number of correction rounds (default: 3).
 *                    Must be a non-negative integer; 0 disables all correction.
 * @returns {@link CriticResult} — final output, number of rounds, verification
 *          status, and the ordered discrepancy history.
 *
 * @throws {TypeError} If `maxRounds` is not a non-negative integer.
 *
 * @alpha
 * @remarks Experimental. A general primitive (CRITIC, ICLR 2024) to be wired
 * per-use-case where a tool-grounded oracle exists (tests / type-check / compiler /
 * schema). It is deliberately NOT auto-wired into the default agent loop: its
 * verifier must be tool-grounded, never pure LLM introspection.
 *
 * For the structured-output case specifically, the SDK already ships the public
 * {@link withStructuredOutput} (JSON.parse + Zod oracle, message-thread re-prompt,
 * retry) ; use that rather than re-wrapping criticLoop. criticLoop is reserved for
 * other tool-grounded correction targets (a tool call, a plan, a diff) that have no
 * dedicated helper yet, pending a justified consumer per level-discipline.
 */
export async function criticLoop<T>(
  initial: T,
  verify: CriticVerifier<T>,
  revise: (current: T, discrepancy: string) => Promise<T>,
  maxRounds = 3,
): Promise<CriticResult<T>> {
  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    throw new TypeError(
      `criticLoop: maxRounds must be a non-negative integer, got ${String(maxRounds)}`,
    );
  }

  const history: CriticHistoryEntry[] = [];
  let current = initial;

  for (let round = 1; round <= maxRounds; round++) {
    const verdict = await verify(current);

    if (verdict.ok) {
      return {
        output: current,
        rounds: round - 1,
        verified: true,
        history,
      };
    }

    // Tool-grounded discrepancy: record and revise.
    history.push({ round, discrepancy: verdict.discrepancy });
    current = await revise(current, verdict.discrepancy);
  }

  // After all revision rounds, run a final verification pass.
  const finalVerdict = await verify(current);

  if (finalVerdict.ok) {
    return {
      output: current,
      rounds: maxRounds,
      verified: true,
      history,
    };
  }

  // maxRounds exhausted without passing — return last output unverified.
  return {
    output: current,
    rounds: maxRounds,
    verified: false,
    history,
  };
}
