/**
 * Learning loop — shadow mode skill extraction from agent traces.
 *
 * Sprint-564: C2 — extractSkillFromTrace via LLM-as-optimizer.
 *
 * Trigger composite: toolCallCount >= 4 && roi > 0 && durationMs > 5000 && !wasReplay.
 * NEVER inject learned skills into prod without explicit feature flag + signal stat sig.
 * Golden fixtures snapshot tests detect drift in extraction quality.
 *
 * ANTI-AUDITABLE: learning loop is opt-in shadow mode only. Never active in production
 * without explicit founder approval (CH7 Audit safe).
 */

import type { CycleEvent, OODAContext } from "./types.js";

export interface SkillLedger {
  add?(
    name: string,
    skill: { description: string; chainOfThought: string; source: string; confidence: number },
  ): void;
}

/** @public */
export interface LearningTrigger {
  toolCallCount: number;
  roi: number;
  durationMs: number;
  wasReplay: boolean;
}

/** @public */
export interface ExtractedSkill {
  name: string;
  description: string;
  chainOfThought: string;
  confidence: number;
  /** Whether this skill passed the golden fixtures gate. */
  verified: boolean;
}

/** @public */
export interface LearnOptions {
  /** Feature flag — must be explicitly enabled. Default: false. */
  enabled: boolean;
  /** Minimum confidence to accept a learned skill (0-1). Default: 0.85. */
  minConfidence?: number;
  /** Skill ledger to inject learned skills into. */
  ledger?: SkillLedger;
  /** LLM call for skill extraction. */
  extractor?: (trace: string) => Promise<ExtractedSkill | null>;
}

/**
 * Determine if learning should trigger for a completed cycle.
 * @public
 */
export function shouldLearn(trigger: LearningTrigger): boolean {
  return (
    trigger.toolCallCount >= 4 && trigger.roi > 0 && trigger.durationMs > 5000 && !trigger.wasReplay
  );
}

/**
 * Extract a skill from a completed trace. Uses LLM-as-optimizer (Claude, not GEPA Python).
 * Returns null if extraction fails or confidence below threshold.
 * NEVER injects into SkillLedger without feature flag gate.
 * @public
 */
export async function extractSkillFromTrace(
  events: CycleEvent[],
  _ctx: OODAContext,
  opts: LearnOptions,
): Promise<ExtractedSkill | null> {
  if (!opts.enabled) return null;
  if (!opts.extractor) return null;

  const traceSummary = summarizeTrace(events);
  if (!traceSummary) return null;

  try {
    const skill = await opts.extractor(traceSummary);
    if (!skill) return null;

    const minConf = opts.minConfidence ?? 0.85;
    if (skill.confidence < minConf) return null;

    // Gate: inject into SkillLedger ONLY if feature flag enabled
    if (opts.ledger && skill.verified) {
      opts.ledger.add?.(skill.name, {
        description: skill.description,
        chainOfThought: skill.chainOfThought,
        source: "learning-loop",
        confidence: skill.confidence,
      });
    }

    return skill;
  } catch {
    return null;
  }
}

/**
 * Summarize a trace into a compact text representation for the LLM extractor.
 */
function summarizeTrace(events: CycleEvent[]): string | null {
  const phaseStarts = events.filter((e) => e.type === "phase_start");
  const phaseCompletes = events.filter((e) => e.type === "phase_complete");
  const cycleComplete = events.find((e) => e.type === "cycle_complete");

  if (phaseStarts.length === 0) return null;

  const lines: string[] = ["Trace summary:"];
  for (let i = 0; i < phaseStarts.length; i++) {
    const start = phaseStarts[i];
    const complete = phaseCompletes.find(
      (e) => "phase" in e && e.phase === ("phase" in start ? start.phase : ""),
    );
    lines.push(
      `  ${i + 1}. ${"phase" in start ? start.phase : "unknown"}${complete ? ` (${"durationMs" in complete ? complete.durationMs : "?"}ms)` : ""}`,
    );
  }

  if (cycleComplete && "status" in cycleComplete) {
    lines.push(`Status: ${cycleComplete.status}`);
    if ("durationMs" in cycleComplete) {
      lines.push(`Total duration: ${cycleComplete.durationMs}ms`);
    }
  }

  return lines.join("\n");
}

// ─── Golden fixtures ─────────────────────────────────────────────────────────

/** @public */
export const GOLDEN_FIXTURES: ReadonlyArray<{
  trace: string;
  expectedSkillName: string;
}> = [
  {
    trace: `Trace summary:
  1. observe (50ms)
  2. orient (200ms)
  3. decide (100ms)
  4. act (150ms)
  5. feedback (80ms)
Status: succeeded
Total duration: 580ms`,
    expectedSkillName: "expense_classification",
  },
];
