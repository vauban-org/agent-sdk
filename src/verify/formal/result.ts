/**
 * src/verify/formal/result.ts
 *
 * Sprint-587 — Z3 formal verification result type.
 *
 * 4-state result discipline:
 *   - SAFE     : Z3 proved the post-conditions hold under pre-conditions
 *   - UNSAFE   : Z3 found a counterexample (state where pre-conditions hold
 *                but post-conditions are violated)
 *   - UNKNOWN  : Z3 returned `unknown` (timeout, undecidable, or solver
 *                limitation). EXPLICIT — never silently treated as SAFE.
 *   - SKIPPED  : Verification not run (consumer mode = permissive opt-out,
 *                or solver binary unavailable when caller chooses to skip)
 *
 * The distinction between UNKNOWN and SAFE is the core epistemic discipline
 * of this module : we never assert proof when none was produced.
 *
 * @module verify/formal/result
 */

/**
 * Discriminated state of a formal verification attempt.
 * @public
 */
export type FormalVerifyState = "SAFE" | "UNSAFE" | "UNKNOWN" | "SKIPPED";

/**
 * Solver backend identifier — currently only Z3 or `none` (no solver).
 * @public
 */
export type FormalSolver = "z3" | "none";

/**
 * Result of running a single axiom spec through the formal verifier.
 *
 * `state`           : 4-state outcome (see {@link FormalVerifyState})
 * `axiom`           : human-readable axiom label (e.g. "Robuste")
 * `rationale`       : human-readable explanation of the outcome
 * `witness`         : when SAFE, optional UNSAT-core or proof witness string
 *                     emitted by the solver (informational only)
 * `counterexample`  : when UNSAFE, SMT model (variable assignment) that
 *                     violates the post-conditions
 * `time_ms`         : wall-clock time spent in the solver, in milliseconds
 * `solver`          : which backend produced the result
 * @public
 */
export interface FormalVerifyResult {
  state: FormalVerifyState;
  axiom: string;
  rationale: string;
  witness?: string;
  counterexample?: string;
  time_ms: number;
  solver: FormalSolver;
}
