/**
 * src/constitution/gate.ts
 *
 * HardGate — constitutional hard-stop rules evaluated before cycle execution.
 * Each rule is explicit, isolated, and maps to a single axiom.
 *
 * Rules are evaluated deterministically and synchronously.
 * Any `block` violation causes `pass: false` in the result.
 *
 * @module constitution/gate
 */

import { SECRET_PATTERN } from "./axioms.js";
import type { CycleSnapshot, GateViolation } from "./types.js";
import { cycleSnapshotSchema } from "./types.js";

// ---------------------------------------------------------------------------
// Partial parent context needed by the gate
// ---------------------------------------------------------------------------

/** @public */
export interface ParentCycleContext {
  /** Maximum budget the parent was authorised to spend (in USD). */
  budgetUsdMax: number;
  /** Scope IDs the child is allowed to operate in. */
  allowed_scope_ids?: string[];
}

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

/** @public */
export interface GateResult {
  /** True only when zero violations are detected. */
  pass: boolean;
  /** All detected violations (may be empty). */
  violations: GateViolation[];
}

// ---------------------------------------------------------------------------
// HardGate
// ---------------------------------------------------------------------------

/**
 * HardGate evaluates a fixed set of hard-stop rules against a CycleSnapshot.
 *
 * Rules (in evaluation order):
 *   1. Child budget > parent budget              → Profitable / block
 *   2. Secret in step output                     → Robuste / block
 *   3. Scope dépassé (scope_id ∉ allowed)        → Robuste / block
 *   4. PII without redacted flag                 → Institutionnel / block
 *   5. RSO veto                                  → Institutionnel / block
 * @public
 */
export class HardGate {
  /**
   * Evaluate all hard-gate rules against the cycle.
   *
   * @param cycle   - The cycle to evaluate (validated via Zod before checks).
   * @param parent  - Optional parent context for budget + scope checks.
   * @returns GateResult with pass flag and list of violations.
   */
  evaluate(cycle: CycleSnapshot, parent?: ParentCycleContext): GateResult {
    // Validate input schema before running any rule
    const parsed = cycleSnapshotSchema.safeParse(cycle);
    if (!parsed.success) {
      return {
        pass: false,
        violations: [
          {
            axiom: "Robuste",
            severity: "block",
            rule: "schema_validation",
            rationale: `CycleSnapshot failed schema validation: ${parsed.error.message}`,
          },
        ],
      };
    }

    const violations: GateViolation[] = [];

    // Rule 1 — Child budget > parent budget
    if (parent !== undefined && cycle.budgetUsdMax > parent.budgetUsdMax) {
      violations.push({
        axiom: "Profitable",
        severity: "block",
        rule: "child_budget_exceeds_parent",
        rationale: `Child cycle budgetUsdMax=$${cycle.budgetUsdMax.toFixed(4)} exceeds parent budgetUsdMax=$${parent.budgetUsdMax.toFixed(4)} — walk-away discipline violated`,
      });
    }

    // Rule 2 — Secret in step output
    for (const step of cycle.steps) {
      const outputStr = safeStringify(step.output);
      if (outputStr && SECRET_PATTERN.test(outputStr)) {
        violations.push({
          axiom: "Robuste",
          severity: "block",
          rule: "secret_in_step_output",
          rationale: `Step index=${step.index} output matches secret/api_key/password/token= pattern — potential secret leak`,
        });
        break; // One violation sufficient — avoid duplicate entries per step
      }
    }

    // Rule 3 — Scope dépassé
    if (
      parent !== undefined &&
      cycle.scope_id !== undefined &&
      parent.allowed_scope_ids !== undefined &&
      parent.allowed_scope_ids.length > 0 &&
      !parent.allowed_scope_ids.includes(cycle.scope_id)
    ) {
      violations.push({
        axiom: "Robuste",
        severity: "block",
        rule: "scope_exceeded",
        rationale: `cycle.scope_id="${cycle.scope_id}" is not in parent.allowed_scope_ids=[${parent.allowed_scope_ids.join(", ")}]`,
      });
    }

    // Rule 4 — PII without redacted flag in cross-agent payload
    const piiPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b\+?[0-9]{7,15}\b/;
    if (cycle.metadata?.pii_redacted !== true) {
      for (const step of cycle.steps) {
        const payloads = [safeStringify(step.output), safeStringify(step.storedInput)].filter(
          Boolean,
        );
        for (const payload of payloads) {
          if (payload && piiPattern.test(payload)) {
            violations.push({
              axiom: "Institutionnel",
              severity: "block",
              rule: "pii_in_payload_without_redaction",
              rationale: `PII pattern (email or phone) detected in step index=${step.index} payload without metadata.pii_redacted=true — eIDAS/RGPD compliance risk`,
            });
            break;
          }
        }
        // Stop after first step-level PII violation to avoid duplicates
        if (violations.some((v) => v.rule === "pii_in_payload_without_redaction")) break;
      }
    }

    // Rule 5 — RSO veto
    if (cycle.metadata?.rso_veto === true) {
      violations.push({
        axiom: "Institutionnel",
        severity: "block",
        rule: "rso_veto",
        rationale:
          "cycle.metadata.rso_veto=true — Responsible Scaling Officer has vetoed this cycle",
      });
    }

    return {
      pass: violations.length === 0,
      violations,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton for convenience
// ---------------------------------------------------------------------------

/**
 * Default singleton HardGate instance.
 * @public
 */
export const hardGate = new HardGate();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeStringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
