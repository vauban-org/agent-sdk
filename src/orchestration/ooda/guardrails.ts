/**
 * LLM Guardrails — pre/post phase enforcement with Poseidon-provable violations.
 *
 * Sprint-563: B1 — LLM Guardrails pre/post + violations Vauban Proof Stack.
 *
 * Guards run before (pre-phase) or after (post-phase) each OODA phase.
 * Pre-guards are BLOCKING — phase.fn does NOT execute if guard trips.
 * Post-guards inspect output — reject phase result if violation detected.
 *
 * Violations produce a Poseidon hash via proofPort → anchorable on L3.
 * CycleEventV011 'guardrail_violated' is emitted with proofHash + timing.
 */

import type { CycleEventV011, OODAContext } from "./types.js";

/** @public */
export type GuardrailTiming = "pre-phase" | "post-phase";

/** @public */
export interface GuardrailDef<TInput = unknown, TOutput = unknown> {
  /** Guard name (e.g. "no-pii-in-output"). */
  readonly name: string;
  /** When the guard executes. */
  readonly timing: GuardrailTiming;
  /**
   * Check function. Returns { pass: false, reason, proofHash? } on violation.
   * `input` is the phase input (pre-phase) or output (post-phase).
   */
  check(input: TInput | TOutput, ctx: OODAContext): Promise<GuardrailResult>;
}

/** @public */
export interface GuardrailResult {
  pass: boolean;
  reason?: string;
  /** Poseidon hash of the violation payload for L3 anchoring. */
  proofHash?: string;
}

/** @public */
export interface GuardrailViolation {
  name: string;
  timing: GuardrailTiming;
  phase: string;
  reason: string;
  proofHash?: string;
}

/**
 * Run pre-guards. Returns the first violation, or null if all pass.
 * Pre-guard violations are BLOCKING — the phase does not execute.
 * @public
 */
export async function runPreGuards<TInput>(
  guards: readonly GuardrailDef<TInput, unknown>[],
  input: TInput,
  ctx: OODAContext,
): Promise<GuardrailViolation | null> {
  for (const guard of guards) {
    if (guard.timing !== "pre-phase") continue;
    const result = await guard.check(input, ctx);
    if (!result.pass) {
      return {
        name: guard.name,
        timing: guard.timing,
        phase: "(pre-phase)",
        reason: result.reason ?? "Guard tripped",
        proofHash: result.proofHash,
      };
    }
  }
  return null;
}

/**
 * Run post-guards. Returns the first violation, or null if all pass.
 * Post-guard violations REJECT the phase output.
 * @public
 */
export async function runPostGuards<TOutput>(
  guards: readonly GuardrailDef<unknown, TOutput>[],
  output: TOutput,
  ctx: OODAContext,
): Promise<GuardrailViolation | null> {
  for (const guard of guards) {
    if (guard.timing !== "post-phase") continue;
    const result = await guard.check(output, ctx);
    if (!result.pass) {
      return {
        name: guard.name,
        timing: guard.timing,
        phase: "(post-phase)",
        reason: result.reason ?? "Guard tripped",
        proofHash: result.proofHash,
      };
    }
  }
  return null;
}

/**
 * Build a CycleEventV011 'guardrail_violated' event from a violation.
 * @public
 */
export function guardrailViolationToEvent(
  violation: GuardrailViolation,
  runId: string,
  cycleIndex: number,
): Extract<CycleEventV011, { type: "guardrail_violated" }> {
  return {
    type: "guardrail_violated",
    runId,
    cycleIndex,
    phase: violation.phase,
    timing: violation.timing,
    proofHash: violation.proofHash ?? "",
    reason: violation.reason,
    ts: Date.now(),
  };
}

// ─── Built-in guardrails ─────────────────────────────────────────────────────

/**
 * PII guard — detects credit card numbers in output.
 * Post-phase only, runs after LLM calls.
 * @public
 */
export const PII_GUARD: GuardrailDef<string> = {
  name: "no-pii-in-output",
  timing: "post-phase",
  async check(output: string) {
    // Luhn-like detection: 13-19 digit sequences (credit card PAN range)
    const ccPattern = /\b[0-9]{13,19}\b/g;
    const matches = output.match(ccPattern);
    if (matches) {
      const hasLuhn = matches.some((m) => {
        let sum = 0;
        let alt = false;
        for (let i = m.length - 1; i >= 0; i--) {
          let n = Number.parseInt(m[i], 10);
          if (alt) {
            n *= 2;
            if (n > 9) n -= 9;
          }
          sum += n;
          alt = !alt;
        }
        return sum % 10 === 0;
      });
      if (hasLuhn) {
        return {
          pass: false,
          reason: "Potential credit card number detected in LLM output",
        };
      }
    }
    return { pass: true };
  },
};

/**
 * Max output length guard — prevents runaway LLM responses.
 * Pre-phase only (applied to input size before LLM call).
 * @public
 */
export function createMaxInputLengthGuard(maxChars: number): GuardrailDef<string> {
  return {
    name: `max-input-${maxChars}`,
    timing: "pre-phase",
    async check(input: string) {
      if (input.length > maxChars) {
        return {
          pass: false,
          reason: `Input length ${input.length} exceeds maximum ${maxChars} characters`,
        };
      }
      return { pass: true };
    },
  };
}
