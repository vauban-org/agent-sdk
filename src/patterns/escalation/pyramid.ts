import type { OODAContext } from "../../orchestration/ooda/types.js";
/**
 * Pattern C: Escalation Pyramid — factory implementation.
 * @public
 */
import { logToBrain } from "../_shared/brain-logger.js";
import type {
  EscalationDecision,
  EscalationLevel,
  EscalationPyramid,
  EscalationPyramidConfig,
} from "./types.js";

const NOOP = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const UNKNOWN_DEFAULT: EscalationLevel = "L3_hitl_required";

export function createEscalationPyramid(config: EscalationPyramidConfig): EscalationPyramid {
  const l1 = config.l1ConfidenceThreshold ?? 0.85;
  const l2 = config.l2ConfidenceThreshold ?? 0.6;
  if (l2 >= l1) {
    throw new Error(
      `[escalation:${config.name}] l2ConfidenceThreshold(${l2}) must be < l1ConfidenceThreshold(${l1})`,
    );
  }
  const logger = config.logger ?? NOOP;

  const declared = new Map<string, EscalationLevel>(
    config.declarations.map((d) => [d.actionType, d.level]),
  );
  const overrides = new Map<string, EscalationLevel>();

  function getNominal(actionType: string): EscalationLevel {
    return overrides.get(actionType) ?? declared.get(actionType) ?? UNKNOWN_DEFAULT;
  }

  function escalate(
    nominal: EscalationLevel,
    confidence: number,
    isDryRun: boolean,
  ): EscalationLevel {
    if (isDryRun) return "L1_autonomous";
    switch (nominal) {
      case "L1_autonomous":
        return confidence < l1 ? "L2_async_review" : "L1_autonomous";
      case "L2_async_review":
        return confidence < l2 ? "L3_hitl_required" : "L2_async_review";
      case "L3_hitl_required":
        return "L3_hitl_required";
    }
  }

  return {
    async canProceed(
      actionType: string,
      confidence: number,
      ctx: OODAContext,
    ): Promise<EscalationDecision> {
      const nominal = getNominal(actionType);
      const isDryRun = ctx.executionMode === "dry-run";
      const effectiveLevel = escalate(nominal, confidence, isDryRun);
      const proceed = effectiveLevel !== "L3_hitl_required";

      const reason = isDryRun
        ? "dry-run → L1_autonomous"
        : nominal === effectiveLevel
          ? `'${actionType}' at ${nominal} (confidence=${confidence.toFixed(3)})`
          : `'${actionType}' escalated ${nominal} → ${effectiveLevel} (confidence=${confidence.toFixed(3)})`;

      const decision: EscalationDecision = { proceed, effectiveLevel, reason };

      logger.info(
        { pyramid: config.name, actionType, confidence, effectiveLevel, proceed },
        `[escalation:${config.name}] ${reason}`,
      );

      logToBrain(config.brain, {
        content: `Escalation '${config.name}': ${reason}`,
        content_type: "decision",
        author: `escalation:${config.name}`,
        category: "decision",
        tags: ["escalation-pyramid", config.name, effectiveLevel, actionType],
        confidence,
        metadata: {
          actionType,
          confidence,
          nominal,
          effectiveLevel,
          proceed,
          agentId: ctx.agentId,
          runId: ctx.runId,
        },
      });

      if (!proceed) {
        logger.warn(
          { pyramid: config.name, actionType },
          `[escalation:${config.name}] L3 block on '${actionType}'`,
        );
        try {
          config.onHitlRequired?.(actionType, confidence, decision, ctx);
        } catch {
          /* suppress */
        }
      }

      return decision;
    },

    override(actionType: string, level: EscalationLevel): void {
      overrides.set(actionType, level);
    },

    clearOverride(actionType: string): void {
      overrides.delete(actionType);
    },
  };
}
