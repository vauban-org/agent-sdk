/**
 * src/verify/formal/policy.ts
 *
 * Sprint-587 — Per-axiom policy + consumer mode resolution.
 *
 * The policy layer maps a 4-state {@link FormalVerifyResult} to an action
 * (proceed / block / escalate / log), parameterised by :
 *   - the axiom (Robuste, Institutionnel, … — each has different sensitivity)
 *   - the consumer mode (strict / permissive / audit_only)
 *   - the calling context (runtime vs skill_ingestion — see Tension Sprint C)
 *
 * Tension Sprint C : skill-loop ingestion is ALWAYS strict on UNKNOWN.
 * Even if the runtime policy says "proceed_with_log" on UNKNOWN for the
 * Profitable axiom, the skill-ingestion path must refuse to ingest the
 * skill until UNKNOWN becomes SAFE. This prevents UNKNOWN-tainted skills
 * from accumulating in the skill library.
 *
 * @module verify/formal/policy
 */

import type { FormalVerifyResult } from "./result.js";

/**
 * Action chosen by the policy resolver.
 *
 *   `proceed`        : continue without intervention
 *   `block`          : refuse the operation outright
 *   `escalate_human` : pause and request human approval (HITL)
 *   `log`            : continue but emit an audit-grade log entry
 * @public
 */
export type PolicyAction = "proceed" | "block" | "escalate_human" | "log";

/**
 * Strategy for handling UNKNOWN outcomes.
 *
 *   `escalate_human`        : refuse to make a unilateral decision
 *   `proceed_with_log`      : continue and emit a regular log entry
 *   `proceed_with_audit_log`: continue and emit an audit-grade log entry
 * @public
 */
export type OnUnknown = "escalate_human" | "proceed_with_log" | "proceed_with_audit_log";

/**
 * Strategy for handling UNSAFE outcomes — either hard-block or escalate.
 * @public
 */
export type OnUnsafe = "block" | "escalate_human";

/**
 * Policy bundle for one axiom.
 *
 * `skillLoopStrict` is ALWAYS true by design : it is exposed as a field so
 * downstream code can read it but is not configurable (see Tension Sprint C).
 * @public
 */
export interface AxiomPolicy {
  /** Action on SAFE. Fixed at `"proceed"` — kept explicit for symmetry. */
  onSafe: "proceed";
  /** Action on UNSAFE. */
  onUnsafe: OnUnsafe;
  /** Action on UNKNOWN. */
  onUnknown: OnUnknown;
  /** Solver timeout for this axiom, in milliseconds. */
  timeout_ms: number;
  /**
   * Skill-loop ingestion strict mode — always true. Exposed so callers can
   * assert the invariant. Do not set to false ; Tension Sprint C invariant.
   */
  skillLoopStrict: boolean;
}

/**
 * Default per-axiom policies.
 *
 * Rationale :
 *   Robuste / Institutionnel : hard axioms — UNSAFE blocks, UNKNOWN escalates
 *   SOTA                     : UNKNOWN allowed with audit log (SOTA evolves)
 *   AntiFragile / Profitable : softer — UNSAFE escalates, UNKNOWN logs
 * @public
 */
export const DEFAULT_POLICIES: Record<string, AxiomPolicy> = {
  Robuste: {
    onSafe: "proceed",
    onUnsafe: "block",
    onUnknown: "escalate_human",
    timeout_ms: 5000,
    skillLoopStrict: true,
  },
  Institutionnel: {
    onSafe: "proceed",
    onUnsafe: "block",
    onUnknown: "escalate_human",
    timeout_ms: 10_000,
    skillLoopStrict: true,
  },
  SOTA: {
    onSafe: "proceed",
    onUnsafe: "escalate_human",
    onUnknown: "proceed_with_audit_log",
    timeout_ms: 2000,
    skillLoopStrict: true,
  },
  AntiFragile: {
    onSafe: "proceed",
    onUnsafe: "escalate_human",
    onUnknown: "proceed_with_log",
    timeout_ms: 1000,
    skillLoopStrict: true,
  },
  Profitable: {
    onSafe: "proceed",
    onUnsafe: "escalate_human",
    onUnknown: "proceed_with_log",
    timeout_ms: 1000,
    skillLoopStrict: true,
  },
};

/**
 * Consumer-level mode for the formal verifier.
 *
 *   `strict`     : enforce all policies as declared
 *   `permissive` : downgrade non-critical UNSAFE to log (Robuste/Institutionnel
 *                  remain enforced), and treat UNKNOWN as SKIPPED
 *   `audit_only` : never block ; map every actionable outcome to `log`
 * @public
 */
export type ConsumerMode = "strict" | "permissive" | "audit_only";

/**
 * Calling context — distinguishes between live runtime verification and
 * skill-loop ingestion. The latter has stricter rules on UNKNOWN.
 * @public
 */
export type VerifyContext = "runtime" | "skill_ingestion";

/**
 * Resolution outcome of {@link applyPolicy}.
 * @public
 */
export interface PolicyDecision {
  action: PolicyAction;
  rationale: string;
}

/**
 * Whether an axiom is in the "hard" set (Robuste, Institutionnel) whose
 * UNSAFE outcomes are non-negotiable.
 */
function isHardAxiom(axiom: string): boolean {
  return axiom === "Robuste" || axiom === "Institutionnel";
}

/**
 * Apply the policy + mode + context to a single verification result.
 *
 * Decision order :
 *   1. SKIPPED                                        → log
 *   2. skill_ingestion + UNKNOWN                      → block  (Tension Sprint C)
 *   3. mode = audit_only                              → log
 *   4. mode = permissive + UNKNOWN                    → log    (treated as SKIPPED)
 *   5. mode = permissive + UNSAFE + non-hard axiom    → log
 *   6. otherwise                                      → policy.on{Safe,Unsafe,Unknown}
 * @public
 */
export function applyPolicy(
  result: FormalVerifyResult,
  policy: AxiomPolicy,
  mode: ConsumerMode,
  context: VerifyContext,
): PolicyDecision {
  // 1. SKIPPED → log
  if (result.state === "SKIPPED") {
    return {
      action: "log",
      rationale: `Axiom ${result.axiom} verification was skipped (${result.rationale})`,
    };
  }

  // 2. Tension Sprint C : skill_ingestion + UNKNOWN → block, always.
  if (context === "skill_ingestion" && result.state === "UNKNOWN") {
    return {
      action: "block",
      rationale: `Skill ingestion refuses UNKNOWN on axiom ${result.axiom} (Tension Sprint C : skill-loop is always strict on UNKNOWN)`,
    };
  }

  // 3. audit_only never blocks.
  if (mode === "audit_only") {
    return {
      action: "log",
      rationale: `audit_only mode : axiom ${result.axiom} = ${result.state}`,
    };
  }

  // SAFE is always proceed.
  if (result.state === "SAFE") {
    return {
      action: "proceed",
      rationale: `Axiom ${result.axiom} proved SAFE in ${result.time_ms.toFixed(0)}ms`,
    };
  }

  // 4 + 5. Permissive softening.
  if (mode === "permissive") {
    if (result.state === "UNKNOWN") {
      return {
        action: "log",
        rationale:
          `permissive mode : UNKNOWN on axiom ${result.axiom} treated as ` +
          `non-blocking (${result.rationale})`,
      };
    }
    if (result.state === "UNSAFE" && !isHardAxiom(result.axiom)) {
      return {
        action: "log",
        rationale:
          `permissive mode : UNSAFE on soft axiom ${result.axiom} downgraded ` +
          `to log (${result.rationale})`,
      };
    }
    // UNSAFE on hard axiom : fall through to strict policy.
  }

  // 6. Strict policy resolution.
  if (result.state === "UNSAFE") {
    return {
      action: policy.onUnsafe,
      rationale:
        `UNSAFE on axiom ${result.axiom} : ${policy.onUnsafe} ` +
        `(counterexample : ${result.counterexample ?? "n/a"})`,
    };
  }

  // result.state === "UNKNOWN" (runtime context only)
  switch (policy.onUnknown) {
    case "escalate_human":
      return {
        action: "escalate_human",
        rationale: `UNKNOWN on axiom ${result.axiom} : escalating (${result.rationale})`,
      };
    case "proceed_with_audit_log":
      return {
        action: "log",
        rationale: `UNKNOWN on axiom ${result.axiom} : audit-log proceed (${result.rationale})`,
      };
    default:
      return {
        action: "log",
        rationale: `UNKNOWN on axiom ${result.axiom} : log-proceed (${result.rationale})`,
      };
  }
}
