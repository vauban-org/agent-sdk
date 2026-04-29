/**
 * @vauban-org/agent-sdk — Public API v0.2.0
 *
 * MAX 8 top-level concepts. See CONTRACT.md for full signatures.
 */

// 1. AgentLoop (minimal-loop — multi-provider Anthropic+Groq cascade)
export { AgentLoop } from "./loop/minimal-loop.js";
export type { AgentLoopRunResult } from "./loop/minimal-loop.js";

// 2. SdkAgentLoop (sdk-loop — Anthropic-direct with permissions)
export { SdkAgentLoop } from "./loop/sdk-loop.js";
export type {
  SdkAgentLoopConfig,
  SdkAgentLoopRunResult,
  SdkToolRegistry,
} from "./loop/sdk-loop.js";

// Unified ToolRegistry contract (consumed by both loops + CC host).
export {
  ToolRegistryImpl,
  isValidToolName,
  zodToJsonSchema,
} from "./tools/index.js";
export type {
  AgentTool,
  MCPToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolRegistry,
  ToolResult,
} from "./tools/index.js";

// 3. AgentRegistry + AgentDescriptor
export { AgentRegistry, agentRegistry } from "./registry/agent-registry.js";
export type {
  AgentDescriptor,
  AgentHandler,
  AgentContext,
  AgentResult,
} from "./registry/agent-registry.js";

// 4. BudgetState + CoherenceDetector
export {
  createBudgetState,
  createCoherenceDetector,
  compactToolLog,
  emergencyContextSummary,
} from "./budget/budget-state.js";
export type {
  AgentBudgetState,
  CoherenceDetector,
  LogMessage,
} from "./budget/budget-state.js";

// 5. ProviderRouter
export {
  createProviderRouter,
  ProviderRouterError,
} from "./router/provider-router.js";
export type {
  ProviderRouter,
  ProviderRouterRequest,
  ProviderRouterResponse,
} from "./router/provider-router.js";

// 6. ApprovalChannel + InMemoryApprovalStore
export { InMemoryApprovalStore } from "./hitl/approval-channel.js";
export type {
  ApprovalChannel,
  ApprovalRequest,
  Approval,
  ApprovalStore,
  PendingApproval,
} from "./hitl/approval-channel.js";

// 7. Utility helpers
export {
  sanitizeExternalInput,
  keepSafeOnly,
  DEFAULT_INSTRUCTION_PATTERNS,
} from "./safety/sanitize.js";
export type { SanitizedItem } from "./safety/sanitize.js";
export {
  recordOutcome,
  getTracer,
  agentSpan,
  llmSpan,
  toolSpan,
  recordLlmUsage,
  recordToolResult,
} from "./tracking/gen-ai.js";
export { createAgentRunTracker } from "./tracking/agent-run-tracker.js";
export type {
  AgentRunTracker,
  AgentRunStartInput,
  AgentRunStepDelta,
  AgentRunFinish,
  DbClient,
} from "./tracking/agent-run-tracker.js";
export { createBullMQRunner, BullMQRunner } from "./durable/bullmq-runner.js";
export type {
  BullMQRunnerConfig,
  QueueArchetype,
  DlqJobPayload,
} from "./durable/bullmq-runner.js";
export {
  AGENT_IDS,
  AGENT_ID_NAMESPACE,
  getAgentId,
  agentFromId,
} from "./registry/agent-ids.js";
export type { AgentType } from "./registry/agent-ids.js";

// Permissions (consumed by SdkAgentLoop wiring)
export {
  mapScopesToSdkPermissions,
  permitsCapability,
  permitsMcpScopes,
} from "./permissions/sdk-permissions.js";
export type {
  SdkPermissions,
  SdkCapability,
  BashMode,
  FileIOMode,
} from "./permissions/sdk-permissions.js";
// Capability gate (Biscuit pre-dispatch hook)
export { ALLOW_ALL_GATE } from "./permissions/capability-gate.js";
export type {
  CapabilityGate,
  CapabilityGateCall,
  CapabilityGateVerdict,
} from "./permissions/capability-gate.js";
// Capability-token auto-renewal at 80% lifetime
export { RenewalManager } from "./permissions/renewal-manager.js";
export type {
  RenewalManagerOptions,
  RenewalRequest,
  RenewedToken,
} from "./permissions/renewal-manager.js";
// SDK permission mapping — pure projections (Biscuit ∩ cc:* scope)
export {
  scopeToSdkPermissions,
  capabilityToSdkPermissions,
} from "./sdk-permission-mapping.js";
export type {
  SdkPermissions as MappedSdkPermissions,
  BashMode as MappedBashMode,
  FileIoMode,
  CcScope,
} from "./sdk-permission-mapping.js";

// HITL extras
export type { ApprovalStatus } from "./hitl/approval-channel.js";

// 8. Ports — host-injected dependency contracts (SDK v0.2.0)
export type {
  LoggerPort,
  BrainPort,
  BrainEntry,
  BrainEntryInput,
  BrainQueryFilters,
  OutcomePort,
  AgentRunRef,
  DbPort,
} from "./ports/index.js";
export { noopLogger } from "./ports/index.js";

// 9. Deprecation helper (SDK v0.3.0 — Sprint-457)
export { deprecated } from "./deprecation.js";
export type { DeprecationOptions } from "./deprecation.js";

// 11. Traced port wrapper (SDK v0.3.0 — Sprint-460)
export { tracedPort } from "./tracing/traced-port.js";
export type { TracedPortOptions } from "./tracing/traced-port.js";

// 12. Resilience primitives (SDK v0.5.0 — Sprint-468)
export {
  circuitBreaker,
  CircuitOpenError,
  idempotent,
  hashKey,
  BoundedTtlCache,
  bulkhead,
  BulkheadFullError,
} from "./resilience/index.js";
export type {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitState,
  IdempotencyCache,
  IdempotentOptions,
  Bulkhead,
  BulkheadOptions,
  BulkheadStats,
} from "./resilience/index.js";

// 13. Outcomes module (SDK v0.5.1 — Sprint-522)
export * from "./outcomes/index.js";

// 14. Proof module (SDK v0.5.2 — Sprint-521 Bloc 1)
export * from "./proof/index.js";

// 15. Runs streaming + health (SDK v0.5.3 — sprint-523)
export * from "./runs/index.js";
export * from "./otel/index.js";

// 16. OODA orchestration primitive (SDK v0.7.0 — sprint-525 Bloc 5a)
export * from "./orchestration/ooda/index.js";

// 17. Skill Catalog — 13 builtin skills + record_outcome (SDK v0.7.0 — sprint-525 quick-5)
// 19. Skill Ledger types + resolveSkillsForAgent (SDK v0.8.0 — sprint-530:quick-4) — re-exported via skills/index.js
export * from "./skills/index.js";

// 18. Agent-specific types (SDK v0.7.1 — sprint-526 Bloc 5b)
export * from "./agents/index.js";

// 20. REST clients (SDK v0.8.2 — sprint-524:quick-9)
export * from "./clients/index.js";

// 10. Typed port errors (SDK v0.3.0 — Sprint-459)
export {
  PortError,
  BrainUnavailable,
  BrainRateLimit,
  BrainValidationError,
  BrainAuthError,
  DbConnectionLost,
  DbQueryError,
  OutcomeAttributionFailed,
  isPortError,
  isRetryablePortError,
} from "./errors.js";
