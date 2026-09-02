/**
 * Escalation mapping helpers — Forge EscalationLevel → CC SDK pyramid levels.
 *
 * Promoted from Forge (Vague 1.B.1). Pure mapping, no external dependencies.
 *
 * @public @since 0.17.0
 */

import type { EscalationLevel } from "./agent.js";

/**
 * CC SDK EscalationPyramid level strings.
 *
 * - `L1_autonomous`: Fully autonomous execution (L0/L1 Forge).
 * - `L2_async_review`: Async human review before irreversible effects (L2 Forge).
 * - `L3_hitl_required`: Synchronous HITL approval required (L3 Forge).
 * @public
 */
export type SdkEscalationLevel = "L1_autonomous" | "L2_async_review" | "L3_hitl_required";

/**
 * Map a Forge `EscalationLevel` to the CC SDK `EscalationPyramid` level.
 *
 * Both L0 and L1 map to `L1_autonomous` because Forge uses L0 for truly
 * unchecked actions and L1 for audit-logged autonomous actions — both
 * are autonomous from the CC SDK pyramid perspective.
 *
 * @example
 * ```ts
 * const sdkLevel = toSdkEscalationLevel("L2"); // "L2_async_review"
 * ```
 * @public
 */
export function toSdkEscalationLevel(level: EscalationLevel): SdkEscalationLevel {
  switch (level) {
    case "L0":
      return "L1_autonomous";
    case "L1":
      return "L1_autonomous";
    case "L2":
      return "L2_async_review";
    case "L3":
      return "L3_hitl_required";
  }
}
