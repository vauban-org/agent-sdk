import type { OODAContext } from "../../orchestration/ooda/types.js";
/**
 * Pattern C: Escalation Pyramid — types.
 *
 * Declares action autonomy levels and validates before execution.
 * Confidence-based escalation: insufficient confidence escalates the level.
 * Unknown action types default to L3 (fail-safe).
 * dry-run always resolves to L1 (no real effects).
 *
 * NOTE: `confidence` must be provided by the agent's DECIDE phase.
 * The SDK does not infer it automatically from the LLM.
 *
 * @public
 */
import type { BrainPort } from "../../ports/brain.js";
import type { LoggerPort } from "../../ports/logger.js";

export type EscalationLevel = "L1_autonomous" | "L2_async_review" | "L3_hitl_required";

export interface ActionDeclaration {
  readonly actionType: string;
  readonly level: EscalationLevel;
}

export interface EscalationDecision {
  readonly proceed: boolean;
  readonly effectiveLevel: EscalationLevel;
  readonly reason: string;
}

export interface EscalationPyramidConfig {
  readonly name: string;
  readonly declarations: ReadonlyArray<ActionDeclaration>;
  /** Min confidence for L1 without escalating to L2. Default: 0.85 */
  readonly l1ConfidenceThreshold?: number;
  /** Min confidence for L2 without escalating to L3. Default: 0.60 */
  readonly l2ConfidenceThreshold?: number;
  readonly brain?: BrainPort;
  readonly logger?: LoggerPort;
  /** Called when effectiveLevel = L3. Must not throw. */
  readonly onHitlRequired?: (
    actionType: string,
    confidence: number,
    decision: EscalationDecision,
    ctx: OODAContext,
  ) => void;
}

export interface EscalationPyramid {
  canProceed(actionType: string, confidence: number, ctx: OODAContext): Promise<EscalationDecision>;
  /** Runtime override without redeployment. */
  override(actionType: string, level: EscalationLevel): void;
  /** Remove override — restores declared level (or L3 default). */
  clearOverride(actionType: string): void;
}
