/**
 * Strategy plug-ins for the unified `Agent` runtime.
 *
 * Public barrel — exports the 4 canonical strategies and their factory
 * functions. Strategies are pure data-flow plug-ins ; the parent `Agent`
 * class fires hooks (skillCapture, onStep, attestation, HITL) around
 * `strategy.run(ctx)`.
 *
 * @public @experimental @since 2.0.0
 */

export type {
  AgentContext,
  AgentCycleResult,
  AgentHooks,
  AgentStrategy,
  AgentStrategyName,
  StrategyLLMCompletionFn,
  StrategyLLMResponse,
  StrategyMessage,
  StrategyStepEvent,
  StrategyToolCall,
} from "./types.js";

export { createOneShotStrategy } from "./one-shot.js";
export {
  createReactStrategy,
  parseReactToolCall,
  tryParseJsonToolCallFallback,
} from "./react.js";
export { createPlanStrategy, parsePlanFromText } from "./plan.js";
export { createOODAStrategy, createUnconfiguredOODAInvoker } from "./ooda.js";
export type { OODACycleInvoker } from "./ooda.js";
