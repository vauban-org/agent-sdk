/**
 * src/verify/formal/index.ts
 *
 * Sprint-587 — Formal verification entry point.
 *
 * Orchestrates : AxiomSpec → SMT-LIB → Z3 subprocess → 4-state result →
 * (optionally) per-axiom policy decision.
 *
 * When `z3` is not in PATH, every spec resolves to UNKNOWN with a uniform
 * rationale. Callers can then apply their policies — typically resulting in
 * escalation or log (depending on the axiom and consumer mode).
 *
 * @module verify/formal
 */

import {
  type AxiomPolicy,
  type ConsumerMode,
  DEFAULT_POLICIES,
  type PolicyDecision,
  type VerifyContext,
  applyPolicy,
} from "./policy.js";
import type { FormalVerifyResult } from "./result.js";
import { checkSmt, isZ3Available } from "./solver.js";
import { type AxiomSpec, compileToSmt } from "./spec-language.js";

export type {
  FormalVerifyResult,
  FormalVerifyState,
  FormalSolver,
} from "./result.js";
export {
  type AxiomPolicy,
  type ConsumerMode,
  type VerifyContext,
  type PolicyAction,
  type PolicyDecision,
  type OnUnknown,
  type OnUnsafe,
  DEFAULT_POLICIES,
  applyPolicy,
} from "./policy.js";
export {
  type AxiomSpec,
  type Condition,
  AXIOM_SPECS,
  compileToSmt,
} from "./spec-language.js";
export {
  type SmtCheckResult,
  type SolverOptions,
  checkSmt,
  isZ3Available,
} from "./solver.js";

/**
 * Bundle returned by {@link formalVerify} : the raw verification result plus
 * the policy-resolved decision.
 * @public
 */
export interface FormalVerifyDecision {
  result: FormalVerifyResult;
  decision: PolicyDecision;
}

/**
 * Verify every supplied AxiomSpec, apply the per-axiom policy, and return
 * one {@link FormalVerifyDecision} per spec.
 *
 * If `z3` is not available on PATH, every result is UNKNOWN with
 * `solver: "none"`, and the policy layer handles routing.
 *
 * @param axiomSpecs       List of specs to verify (typically derived from
 *                         {@link AXIOM_SPECS}, possibly customised).
 * @param mode             Consumer mode (strict / permissive / audit_only).
 * @param context          Calling context (runtime / skill_ingestion).
 * @param customPolicies   Optional override map keyed by axiom label.
 * @public
 */
export async function formalVerify(
  axiomSpecs: AxiomSpec[],
  mode: ConsumerMode,
  context: VerifyContext,
  customPolicies?: Partial<Record<string, AxiomPolicy>>,
): Promise<FormalVerifyDecision[]> {
  const z3Available = await isZ3Available();

  const out: FormalVerifyDecision[] = [];

  for (const spec of axiomSpecs) {
    const policy = customPolicies?.[spec.axiom] ??
      DEFAULT_POLICIES[spec.axiom] ?? {
        // Fallback policy for unknown axioms : permissive defaults.
        onSafe: "proceed" as const,
        onUnsafe: "escalate_human" as const,
        onUnknown: "proceed_with_log" as const,
        timeout_ms: spec.timeout_ms ?? 5000,
        skillLoopStrict: true,
      };

    const timeout_ms = spec.timeout_ms ?? policy.timeout_ms ?? 5000;

    let result: FormalVerifyResult;

    if (!z3Available) {
      result = {
        state: "UNKNOWN",
        axiom: spec.axiom,
        rationale: "z3 binary not available on PATH",
        time_ms: 0,
        solver: "none",
      };
    } else {
      const smt = compileToSmt(spec);
      const smtRes = await checkSmt(smt, { timeout_ms });

      if (smtRes.sat === false) {
        // unsat → no counterexample → property holds → SAFE
        result = {
          state: "SAFE",
          axiom: spec.axiom,
          rationale: `Z3 proved post-conditions hold for axiom ${spec.axiom}`,
          time_ms: smtRes.time_ms,
          solver: "z3",
        };
      } else if (smtRes.sat === true) {
        // sat → counterexample → property violated → UNSAFE
        result = {
          state: "UNSAFE",
          axiom: spec.axiom,
          rationale: `Z3 found a counterexample for axiom ${spec.axiom}`,
          counterexample: smtRes.model,
          time_ms: smtRes.time_ms,
          solver: "z3",
        };
      } else {
        // null → unknown / timeout / error → UNKNOWN
        result = {
          state: "UNKNOWN",
          axiom: spec.axiom,
          rationale: smtRes.reason ?? "z3 returned unknown",
          time_ms: smtRes.time_ms,
          solver: "z3",
        };
      }
    }

    const decision = applyPolicy(result, policy as AxiomPolicy, mode, context);
    out.push({ result, decision });
  }

  return out;
}
