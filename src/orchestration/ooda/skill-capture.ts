/**
 * Skill capture — Hermes Procedural Learning Loop equivalent.
 *
 * Wires the orphan helpers `learn.shouldLearn` + `skill-loop.extractCandidate`
 * into the OODA feedback phase. Activates only when
 * `OODAAgentConfig.skillCapture.enabled === true`.
 *
 * Fail-soft: errors during persistence or markdown rendering are logged but
 * never thrown ; the OODA cycle status is unaffected.
 *
 * Tier classification: every captured skill is tagged
 * `metadata.vauban.tier: unverified` (per EU AI Act Art. 14 ; no auto-injection
 * into prod execution before audit gate).
 *
 * @module orchestration/ooda/skill-capture
 * @public @experimental @since 1.13.0
 */

import type { ProceduralMemoryPort } from "../../ports/brain.js";
import type { LoggerPort } from "../../ports/logger.js";
import { type SkillCandidate, extractCandidate } from "../../skill-loop/candidate.js";
import { type LearningTrigger, shouldLearn } from "./learn.js";
import type { OutcomeRecord } from "./types.js";

/**
 * Configuration for skill capture in the OODA feedback phase.
 *
 * @public @experimental @since 1.13.0
 */
export interface SkillCaptureOptions {
  /** Master switch. When false, capture is a no-op. */
  readonly enabled: boolean;
  /** Min outcome quality to trigger capture. Default: 0.8. */
  readonly minQuality?: number;
  /** Procedural memory port for persistence (typically `BrainPort.procedural`). */
  readonly procedural?: ProceduralMemoryPort;
  /** Optional sink for SKILL.md markdown rendering (test/dev). */
  readonly markdownSink?: (path: string, content: string) => Promise<void>;
  /** Domain key — usually derived from agentId. */
  readonly domain: string;
  /** Optional override of the instruction synthesizer. */
  readonly synthesize?: (traceSummary: string) => string;
}

/**
 * Result returned by `captureSkillFromCycle`. Never throws ; always returns.
 *
 * @public @experimental @since 1.13.0
 */
export interface CaptureResult {
  readonly captured: boolean;
  readonly candidateId?: string;
  readonly reason?: string;
}

/**
 * Capture a skill candidate from a completed OODA cycle.
 *
 * Gating sequence:
 *  1. `opts.enabled` must be true.
 *  2. `shouldLearn(trigger)` must return true.
 *  3. `outcome.quality` must be >= `opts.minQuality` (default 0.8).
 *
 * On success, persists to `opts.procedural` (best-effort) and optionally
 * renders to `opts.markdownSink`. Never throws.
 * @public
 */
export async function captureSkillFromCycle(
  agentId: string,
  runId: string,
  trigger: LearningTrigger,
  outcome: OutcomeRecord | null,
  traceSummary: string,
  opts: SkillCaptureOptions,
  logger: LoggerPort,
): Promise<CaptureResult> {
  if (!opts.enabled) {
    return { captured: false, reason: "disabled" };
  }

  if (!shouldLearn(trigger)) {
    return { captured: false, reason: "trigger_below_threshold" };
  }

  const quality = outcome?.quality ?? 0;
  const minQ = opts.minQuality ?? 0.8;
  if (quality < minQ) {
    return {
      captured: false,
      reason: `quality ${quality.toFixed(2)} < ${minQ.toFixed(2)}`,
    };
  }

  const instructions = opts.synthesize ? opts.synthesize(traceSummary) : traceSummary;

  let candidate: SkillCandidate;
  try {
    candidate = await extractCandidate(runId, instructions, opts.domain, {
      constitutional: outcome?.confidence ?? 1.0,
      outcome: quality,
    });
  } catch (err) {
    logger.warn?.(
      { runId, agentId, err: (err as Error).message },
      "ooda.skill_capture.extract_failed",
    );
    return { captured: false, reason: "extract_failed" };
  }

  const skillName = `${opts.domain}-${candidate.id.slice(0, 8)}`;

  if (opts.procedural) {
    try {
      await opts.procedural.registerSkill(agentId, {
        name: skillName,
        description: `Captured from run ${runId} (quality=${quality.toFixed(2)})`,
        source: "learning-loop",
        confidence: quality,
        chainOfThought: instructions,
      });
    } catch (err) {
      logger.warn?.(
        { runId, agentId, err: (err as Error).message },
        "ooda.skill_capture.persist_failed",
      );
      return { captured: false, reason: "persist_failed" };
    }
  }

  if (opts.markdownSink) {
    try {
      const md = renderSkillMarkdown(candidate, agentId, opts.domain);
      await opts.markdownSink(`${skillName}.SKILL.md`, md);
    } catch (err) {
      // Markdown rendering failure does NOT block capture — log and continue.
      logger.warn?.(
        { runId, agentId, err: (err as Error).message },
        "ooda.skill_capture.markdown_failed",
      );
    }
  }

  logger.info?.(
    { runId, agentId, candidateId: candidate.id, skillName },
    "ooda.skill_capture.captured",
  );

  return { captured: true, candidateId: candidate.id };
}

/**
 * Render an agentskills.io-compatible SKILL.md with Vauban tier metadata.
 * Frontmatter follows the agentskills.io spec plus `metadata.vauban.*` extensions
 * (per IETF draft `draft-vauban-skill-attestation-00`).
 */
function renderSkillMarkdown(c: SkillCandidate, agentId: string, domain: string): string {
  const lines = [
    "---",
    `id: ${c.id}`,
    `name: ${domain}-${c.id.slice(0, 8)}`,
    `version: ${c.version}`,
    `domain: ${domain}`,
    "source: learning-loop",
    `agent_id: ${agentId}`,
    `extracted_from: ${c.extractedFrom}`,
    `replay_root: ${c.replayRoot}`,
    "scores:",
    `  constitutional: ${c.constitutionalScore.toFixed(4)}`,
    `  outcome: ${c.outcomeScore.toFixed(4)}`,
    "metadata:",
    "  vauban:",
    "    tier: unverified",
    "    audit_status: review",
    "---",
    "",
    `# Skill ${domain}-${c.id.slice(0, 8)}`,
    "",
    "## Instructions",
    "",
    c.instructions,
    "",
  ];
  return lines.join("\n");
}
