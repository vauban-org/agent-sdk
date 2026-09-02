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
  CycleEvent,
  CycleEventV010,
  CycleEventV011,
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
  DegradedResponse,
  OrientInputWithBrain,
} from "./brain-context.js";
export {
  BrainSkillNotConfiguredError,
  isDegradedResponse,
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

// ChildAgentPort — sprint-565:2
export type {
  ChildAgentPort,
  ChildAgentOptions,
  ChildAgentResult,
} from "./child-agent.js";

// ReactLoop — sprint-565:3 (+ 1.7.0 onStep telemetry)
export type {
  ToolCall,
  ReactStep,
  ReactResult,
  LLMCompletionFn,
  ReactMessage,
  LLMReactResponse,
  ReactLoopOptions,
  ReactStepMeta,
  ReactLoopLogger,
} from "./react-loop.js";
export { reactLoop } from "./react-loop.js";

// Plan-and-Execute — sprint-565:8a
export type {
  PlanStep,
  Plan,
  StepResult,
  PlanExecutionResult,
} from "./plan-execute.js";
export { decomposeTask, executeStep } from "./plan-execute.js";

// Reflexion Memory — sprint-565:8a
export type { ReflexionEntry, ReflexionQuery } from "./reflexion.js";
export { storeReflexion, queryReflexionMemory } from "./reflexion.js";

// Multi-Agent Debate — sprint-565:8b
export type {
  DebateStance,
  DebateSynthesis,
  DebateResult,
  DebateConfig,
} from "./debate.js";
export { runDebate } from "./debate.js";

// Inner Monologue — sprint-565:8b
export type {
  InnerMonologueInput,
  InnerMonologueOutput,
} from "./inner-monologue.js";
export { SensitiveValue, innerMonologue } from "./inner-monologue.js";

// CronExpression scheduling — sprint-565:5
export { cronSessionGuard } from "./cron-schedule.js";

// EconomicObserver — sprint-565:9
export type { EconomicObserver } from "./economic-observer.js";
export { economicObserverGuard } from "./economic-observer.js";
