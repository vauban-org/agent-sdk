/**
 * OODA orchestration primitive — public barrel.
 *
 * @public
 */

export type {
  OODAPhaseKind,
  ExecutionMode,
  OODAContext,
  PhaseDef,
  SessionGuard,
  RiskGuard,
  OutcomeRecord,
  ResourceLimits,
  OODAAgentConfig,
  OODAAgent,
  CycleStatus,
} from "./types.js";
export { DEFAULT_RESOURCE_LIMITS } from "./types.js";

export type { Skill, SkillContext, SkillRegistry } from "./skills.js";
export { EMPTY_SKILL_REGISTRY } from "./skills.js";

export { OODAAgentImpl } from "./agent.js";
export { createOODAAgent } from "./factory.js";

// Brain context auto-injection for ORIENT (sprint-525:quick-4)
export type {
  BrainCallResult,
  BrainChunk,
  BrainContextOptions,
  OrientInputWithBrain,
} from "./brain-context.js";
export {
  BrainSkillNotConfiguredError,
  withBrainContext,
} from "./brain-context.js";

// Hot-reload config loader (sprint-525:quick-7)
export type { AgentConfigLoader } from "./agent-config-loader.js";
export { createAgentConfigLoader } from "./agent-config-loader.js";

// Persistence + HITL gate + EXECUTION_MODE guard + resource runner (sprint-525:quick-2)
export {
  insertRunStep,
  completeRunStep,
  errorRunStep,
} from "./run-step-persistence.js";
export type { InsertRunStepInput } from "./run-step-persistence.js";

export { waitForHITLApproval } from "./hitl-gate.js";
export type {
  HITLGateOptions,
  HITLGateArgs,
  HITLGateVerdict,
  HITLOnTimeoutPolicy,
} from "./hitl-gate.js";

export {
  assertExecutionMode,
  readExecutionModeFromEnv,
} from "./execution-mode-guard.js";

export {
  ResourceLimitsRunner,
  StepCountExceededError,
} from "./resource-limits.js";
export type { ResourceLimitsOpts } from "./resource-limits.js";

export { recordHITLDecision } from "./audit-log.js";
export type { HITLDecision } from "./audit-log.js";

// Redis circuit breaker guards (sprint-525:quick-3 + sprint-526:quick-3)
export {
  redisCircuitBreaker,
  tripCircuitBreaker,
  resetCircuitBreaker,
} from "./guards/redis-circuit-breaker.js";
export type {
  CircuitBreakerResetMode,
  RedisCircuitBreakerOptions,
  MinimalRedisClient,
} from "./guards/redis-circuit-breaker.js";

// Session guards (sprint-525:quick-3 + sprint-526:quick-2)
export { rthSession } from "./guards/rth-session.js";
export type { RTHSessionOptions } from "./guards/rth-session.js";
export { businessHours } from "./guards/business-hours.js";
export type { BusinessHoursOptions } from "./guards/business-hours.js";
export { alwaysOn } from "./guards/always-on.js";

// MultiModal observation — sprint-525:quick-6
export type {
  ImageMediaType,
  AudioMediaType,
  MultiModalObservation,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicContentBlock,
} from "./multimodal.js";
export { isMultiModal, multiModalToAnthropicContent } from "./multimodal.js";
