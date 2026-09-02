/**
 * @vauban-org/agent-sdk/marketing ; marketing-grade content primitives.
 *
 * Reusable building blocks for any Vauban agent that emits public marketing,
 * outreach, or article content. Persona-driven by design ; the gate consumes
 * the agent persona as its single source of content-policy rules.
 *
 * @public
 */

export { evaluateQualityGate } from "./quality-gate.js";
export type {
  MarketingGateInput,
  MarketingGateResult,
} from "./quality-gate.js";
