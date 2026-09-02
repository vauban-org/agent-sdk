/**
 * proactive/attention-gate ; the governed classifier (ADR-ECO-068). A matching
 * deterministic critical rule forces push (the ONLY interrupt path, fully
 * predictable). Otherwise recall strength splits digest vs silent. Learned
 * salience is NOT here yet (phase 2+); recallStrength is the phase-1 stand-in.
 *
 * The audit fold mirrors turn-verifier.ts's `foldTurnVerificationStep`
 * (uplift-B): `classify` stays pure ; the no-audit path is byte-identical to a
 * plain classifier. A SEPARATE governed `foldAttentionStep` routes the verdict
 * through the SAME `runVerifierBattery` every Vauban gate uses and folds ONE
 * guard/guard_check step (policy hash-only, whose outputHash binds the verdict)
 * into a caller-owned trace sink. Zero SDK->CLI coupling: the sink is a
 * structural {@link TraceStepSink} (declared, not imported), which the preste
 * `TraceAccumulator` (spawn-child-agent.ts) satisfies by shape.
 * @public @experimental
 */
import { runVerifierBattery } from "../compute/battery/battery.js";
import type { BatteryLens, BatteryTraceStep } from "../compute/battery/types.js";
import type { ClockPort } from "../replay/clock.js";
import type { TraceStep } from "../trace/schema.js";
import type { AttentionGate } from "./ports.js";
import type { AttentionVerdict, CriticalRule, ProactiveCandidate } from "./types.js";

/** The governing decision record for the attention gate's audit step. */
const ATTENTION_GATE_ADR = "ADR-ECO-068";

/** The guard name stamped on every attention-gate audit step. */
const ATTENTION_GATE_GUARD = "attention-gate";

/** @public @experimental */
export interface AttentionGateOptions {
  readonly rules: readonly CriticalRule[];
  /** recallStrength at or above this is digest; below is silent. */
  readonly digestMinStrength: number;
}

/**
 * Build the pure deterministic gate. `classify` performs NO I/O and reads no
 * clock ; a session that never folds an audit step behaves byte-identically to
 * having no gate at all. The governed audit is opt-in via {@link foldAttentionStep}.
 * @public
 */
export function createAttentionGate(opts: AttentionGateOptions): AttentionGate {
  return {
    classify(c: ProactiveCandidate): AttentionVerdict {
      for (const rule of opts.rules) {
        if (rule.when(c)) {
          return { class: "push", reason: rule.id, ruleId: rule.id };
        }
      }
      const strength = c.recallStrength ?? 0;
      if (strength >= opts.digestMinStrength) {
        return { class: "digest", reason: `recall_strength=${strength.toFixed(2)}` };
      }
      return { class: "silent", reason: `recall_strength=${strength.toFixed(2)}` };
    },
  };
}

/**
 * Structural subset of the preste `TraceAccumulator` (spawn-child-agent.ts);
 * declared locally (not imported) so this SDK module stays decoupled from the
 * CLI. Any object with a matching `feed` ; the real accumulator included ;
 * satisfies it.
 * @public
 */
export interface TraceStepSink {
  feed(step: BatteryTraceStep): Promise<TraceStep>;
}

/**
 * The deterministic non-llm-judge anchor the governed-primitives 4-properties
 * invariant mandates (rules/architecture/governed-primitives.md): the
 * classification already happened deterministically upstream, so this lens
 * simply affirms the verdict and records its class + rule id into the audit
 * rationale. Rule engine, no model call. Mirrors turn-verifier's
 * `turnVerifiedLens` shape exactly.
 * @public
 */
export const attentionClassifiedLens: BatteryLens<AttentionVerdict> = {
  verifier: {
    name: "attention-gate-classified",
    evaluate: (v) => ({
      score: 1,
      rationale: v.ruleId ? `class=${v.class} rule=${v.ruleId}` : `class=${v.class}`,
    }),
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

/**
 * Run one classification verdict through the SAME governed VerifierBattery
 * every Vauban gate uses (`runVerifierBattery`, ADR-ECO-068) and fold its ONE
 * audit step (phase "guard", type "guard_check", policy "hash-only") into
 * `sink` ; the caller-owned per-run trace accumulator. The step's outputHash
 * binds the verdict, so every interrupt-or-not decision is provable. Never
 * touches proof/chain.ts ; the battery + accumulator pair IS the fold seam.
 *
 * Determinism + replay: the only environmental read is `clock.now()` (called
 * exactly twice inside `runVerifierBattery`), so an injected `RecordedClock`
 * reproduces a byte-identical audit step.
 * @public
 */
export async function foldAttentionStep(
  sink: TraceStepSink,
  runId: string,
  verdict: AttentionVerdict,
  clock: ClockPort,
): Promise<TraceStep> {
  const decision = await runVerifierBattery<AttentionVerdict>(
    { gate: ATTENTION_GATE_GUARD, subjectClass: verdict.class },
    [verdict],
    [attentionClassifiedLens],
    { runId, adrEco: ATTENTION_GATE_ADR, clock },
  );
  return sink.feed({ ...decision.auditStep, guardName: ATTENTION_GATE_GUARD });
}
