/**
 * Agent tier templates — SDK-distributable factory helpers.
 *
 * Three tiers promoted from Forge (Vague 1.B.7):
 * - Tier 1 — SimpleAgent: rule-based, no LLM debate
 * - Tier 2 — ReasoningAgent: LLM + Reflexion + Inner Monologue
 * - Tier 3 — ComplexAgent: Supervisor-Worker + Debate + HITL gate
 *
 * @public @since 0.20.0
 */

export { createSimpleAgent } from "./simple-agent.js";
export type {
  SimpleAgentOptions,
  SimpleAction,
  SimpleDecision,
  SimpleExecutionResult,
} from "./simple-agent.js";

export { createComplexAgent } from "./complex-agent.js";
export type { ComplexAgentOptions } from "./complex-agent.js";

export { createReasoningAgent } from "./reasoning-agent.js";
export type {
  ReasoningAgentOptions,
  ReasoningAgentConfig,
} from "./reasoning-agent.js";
