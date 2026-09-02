/**
 * @vauban-org/agent-sdk — Public API v0.2.0
 *
 * MAX 8 top-level concepts. See CONTRACT.md for full signatures.
 */

// 0. Agent — unified runtime with strategy plug-ins (SDK 2.0).
//    Replaces the legacy split between OODAAgent (full ceremony, OODA-only)
//    and the inline preste loops. Single class, four strategies (ooda /
//    react / plan / one-shot). All hooks (skillCapture, onStep) work
//    uniformly across strategies. Legacy OODAAgent + AgentLoop remain
//    unchanged for backward compat.
export { Agent, createAgent } from "./orchestration/agent.js";
export type { AgentConfig, AgentRunResult } from "./orchestration/agent.js";

// 0a. Strategy plug-ins
export {
  createOneShotStrategy,
  createReactStrategy,
  createPlanStrategy,
  createOODAStrategy,
  createUnconfiguredOODAInvoker,
  parseReactToolCall,
  tryParseJsonToolCallFallback,
  parsePlanFromText,
} from "./strategies/index.js";
export type {
  AgentStrategy,
  AgentStrategyName,
  AgentCycleResult,
  AgentHooks,
  OODACycleInvoker,
  StrategyMessage,
  StrategyToolCall,
  StrategyLLMResponse,
  StrategyLLMCompletionFn,
  StrategyStepEvent,
} from "./strategies/index.js";
// Re-export AgentContext under a strategy-specific name to avoid the
// collision with `AgentContext` already exported from registry/agent-registry.js.
export type { AgentContext as StrategyAgentContext } from "./strategies/index.js";

// 0b. ConversationContext — tiered memory for multi-turn agent sessions
export { ConversationContext } from "./conversation/index.js";
export type {
  Turn,
  CompactionSummary,
  CompactionReport,
  ConversationContextSnapshot,
  ConversationContextOpts,
  LLMMessage,
  CompactionLLMFn,
  CompactOpts,
} from "./conversation/index.js";
export {
  createBrainCompactionLlmFn,
  restoreSessionContext,
} from "./conversation/index.js";

// 1. AgentLoop (minimal-loop — multi-provider Anthropic+Groq cascade)
export { AgentLoop } from "./loop/minimal-loop.js";
export type { AgentLoopRunResult } from "./loop/minimal-loop.js";
export {
  WorldStateHashTracker,
  canonicalStateHash,
} from "./loop/world-state-hash.js";

// 2. SdkAgentLoop (sdk-loop — Anthropic-direct with permissions)
export { SdkAgentLoop } from "./loop/sdk-loop.js";
export type {
  SdkAgentLoopConfig,
  SdkAgentLoopRunResult,
  SdkToolRegistry,
} from "./loop/sdk-loop.js";

// 3. run-memory (grounded loop L1 — @experimental)
export {
  CompositeRunJournal,
  createCompactor,
  createRecallTool,
  FileRunJournal,
} from "./run-memory/index.js";
export type {
  CompactionOutcome,
  Compactor,
  CompactorConfig,
  JournalAppendMeta,
  JournalStep,
  RunJournalPort,
} from "./run-memory/index.js";

// Unified ToolRegistry contract (consumed by both loops + CC host).
export {
  ToolRegistryImpl,
  dangerousToRiskVector,
  isValidToolName,
  riskScore,
  zodToJsonSchema,
} from "./tools/index.js";
export type {
  AgentTool,
  MCPToolDefinition,
  RiskVector,
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
  compactToolLogDecay,
  emergencyContextSummary,
} from "./budget/budget-state.js";
export type {
  AgentBudgetState,
  CoherenceDetector,
  LogMessage,
  DecayCompactionConfig,
} from "./budget/budget-state.js";
export {
  defaultCoherenceModel,
  updateCoherenceModel,
  repairCoherenceModel,
} from "./budget/coherence-learner.js";
export type {
  CoherenceModel,
  CoherenceEpisode,
} from "./budget/coherence-learner.js";
export { SemanticCoherenceTracker } from "./budget/semantic-coherence.js";
export type {
  EmbedFn,
  SemanticCoherenceConfig,
  SemanticCoherenceVerdict,
} from "./budget/semantic-coherence.js";
export {
  gistToolResult,
  compactToolLogGist,
} from "./budget/gist-compression.js";
export type {
  GistLLMFn,
  GistCompressionConfig,
  GistedMessage,
} from "./budget/gist-compression.js";

// 5. ProviderRouter
export {
  createProviderRouter,
  ProviderRouterError,
} from "./router/provider-router.js";
export type {
  ProviderRouter,
  ProviderRouterRequest,
  ProviderRouterResponse,
  ProviderRouterCompleteOptions,
} from "./router/provider-router.js";

// 6. ApprovalChannel + InMemoryApprovalStore
export { InMemoryApprovalStore, toApprovalRisk } from "./hitl/approval-channel.js";
export type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalRisk,
  Approval,
  ApprovalStore,
  PendingApproval,
} from "./hitl/approval-channel.js";

// 6b. HITLPort — stateful HITL state machine (plan v6 §1.7)
export type { HITLPort, HITLRequest, HITLState } from "./ports/hitl.js";
export {
  InvalidStateTransitionError,
  HITLNotFoundError,
  validateTransition,
  runExpireJob,
} from "./ports/hitl.js";
export { MemoryHITLStateStore } from "./adapters/hitl/memory-state-store.js";
export { PostgresHITLStateStore } from "./adapters/hitl/postgres-state-store.js";

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
  AgentRunFinish,
  DbClient,
} from "./tracking/agent-run-tracker.js";

// ─── Telemetry — sovereign multi-sink observability (ADR-ECO-039) ────────────
export {
  NOOP_TELEMETRY_SINK,
  TelemetrySinkError,
  createTelemetryBus,
  stdoutTelemetrySink,
  localSqliteTelemetrySink,
  otlpTelemetrySink,
} from "./telemetry/index.js";
export type {
  TelemetrySink,
  TelemetryRunStart,
  TelemetryRunStep,
  TelemetryRunFinish,
  TelemetryRunStatus,
  TelemetryBusOptions,
  TelemetryCounters,
  TelemetryLogger,
  StdoutTelemetrySinkOptions,
  LocalSqliteTelemetrySinkOptions,
  OtlpTelemetrySinkOptions,
} from "./telemetry/index.js";

// Re-export legacy AgentRunStepDelta + AgentRunFinalStatus (kept for backward
// compat with `AgentRunTracker` consumers, e.g. command-center/src/tracking).
export type {
  AgentRunStepDelta,
  AgentRunFinalStatus,
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
  PostmortemInput,
  LessonInput,
  // Claims plane (sprint-895, ADR-ECO-114)
  ClaimPort,
  Claim,
  ClaimSource,
  ClaimStatus,
  ClaimAssertOptions,
  ClaimQueryFilter,
  MemoryScope,
  OutcomePort,
  AgentRunRef,
  DbPort,
  MessagingChannelPort,
  AlertLevel,
  // LLM BYOM contracts (plan v6 §3.2)
  LLMProviderPort,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ChatUsage,
  StreamDelta,
  // Multimodal message attachments (Beyond-Hermes)
  MessageAttachment,
  ImageAttachment,
  // Price feed port (plan v6 §3.4)
  PricePort,
  PriceEntry,
  // WorkflowRuntime port (A-4 DBOS-TS adapter, S3 spec)
  WorkflowRuntimePort,
  WorkflowContext,
  WorkflowRun,
  WorkflowHandler,
  WorkflowStatus,
  JournalEntry,
  StepKind,
  StepStatus,
  StepOpts,
  EventFilter,
  ChildWorkflowOpts,
  StartWorkflowOpts,
  ResumeWorkflowOpts,
  SendSignalOpts,
  JournalMigrator,
  MigrationResult,
  // Compliance Contract port (G-2 Cedar pivot, S5 spec)
  ComplianceContractPort,
  ComplianceContract,
  ComplianceRule,
  ComplianceGate,
  ComplianceAuditResult,
  ComplianceViolation,
  ManifestValidationResult,
  PolicyConflict,
  CapabilityInvocation,
  TenantContext,
  LegalBasisRef,
  LegalBasisDecl,
  LegalBasisDomain,
  Jurisdiction,
  DataClass,
  ComplianceMode,
  EnforcementLevel,
  RuleSource,
} from "./ports/index.js";
export {
  noopLogger,
  InvalidTargetError,
  BrainUnavailableError,
  BrainRateLimitError,
  MemoryValidationError,
  OutcomeWriteError,
  LoggerFlushError,
  DbConnectionLostError,
  DbQueryTimeoutError,
  EventPublishError,
  LLMProviderError,
  LLMRateLimitError,
  // WorkflowRuntime errors
  WorkflowNotFoundError,
  WorkflowNonDeterminismError,
  WorkflowSignalTimeoutError,
  WorkflowLeaseConflictError,
  WorkflowVersionMismatchError,
  // Compliance Contract errors + constants
  CompliancePolicyError,
  ComplianceEvaluationTimeoutError,
  SUPPORTED_JURISDICTIONS_V0,
} from "./ports/index.js";

// 8g. Sprint-636 V2.1 — 9 new ports (manifest, tenant, federation, delegation, products, observability, privacy)
export type {
  ManifestRegistryPort,
  Manifest,
  RegistrationResult,
  TenantContextPort,
  DegradedMetrics,
  FederationPort,
  FederationMessage,
  ContentClaim,
  FederationMessageHeader,
  AgentRef,
  TransportMeta,
  MessageId as FederationMessageId,
  ReceiveOpts as FederationReceiveOpts,
  FederationVerifyResult,
  DelegationPort,
  DelegationClaim,
  CapabilityScope,
  BastionActionPort,
  BastionActionContext,
  BastionTenantId,
  ClientPolicy,
  SwapParams,
  SwapResult,
  DepositParams,
  DepositResult,
  WithdrawParams,
  WithdrawResult,
  TransferParams,
  TransferResult,
  PolicyValidation,
  VFinanceActionPort,
  VFActionContext,
  MarketSignal,
  SolvencyClaim,
  TradeRecord,
  TradeClaim,
  StrategyRunInput,
  StrategyRunClaim,
  PortfolioId,
  ProofGrade,
  CitadelActionPort,
  CitadelActionContext,
  AgentTier,
  TaskStatus,
  TaskRef,
  SprintInput,
  SprintRef,
  VerificationEvidence,
  SealedSprintClaim,
  DecisionInput,
  DecisionClaim,
  ObservabilityPort,
  PrivacyPort,
} from "./ports/index.js";
export {
  ManifestNotFoundError,
  ManifestSignatureInvalidError,
  ManifestVersionConflictError,
  ManifestComplianceConflictError,
  ManifestValidationError,
  TenantNotFoundError,
  DegradedModeExhaustedError,
  InvalidGlacisAttestationError,
  FederationSignatureInvalidError,
  FederationRoutingError,
  FederationDelegationChainError,
  DelegationNotNarrowingError,
  DelegationExpiredError,
  DelegationRevokedError,
  DelegationChainTooDeepError,
  BastionPolicyViolationError,
  BastionInsufficientFundsError,
  BastionSlippageExceededError,
  BastionContractError,
  BastionTransferUnauthorizedError,
  VFOracleQuorumError,
  VFProofGradeMismatchError,
  VFAnchoringForbiddenError,
  VFProofGenerationError,
  CitadelTierViolationError,
  CitadelTaskRefNotFoundError,
  CitadelSprintNotActiveError,
  CitadelInvalidStateTransitionError,
  NoopObservabilityPort,
  NoopPrivacyAdapter,
  PrivacyNoopWarning,
} from "./ports/index.js";
export * from "./ports/citadel-campaign.js";

// 8f. EventBusPort + CloudEvent (plan v6 §3.3 — sprint-618)
export type { EventBusPort, CloudEvent } from "./ports/event-bus.js";

// 8a. Brain HTTP adapter — concrete BrainPort backed by Brain REST API (Phase 9)
export { createBrainPortFromEnv, createHttpBrainAdapter } from "./adapters/brain-http.js";
export type { HttpBrainAdapterOptions } from "./adapters/brain-http.js";
// 8a-ter. MultiBrainPort — one BrainPort over several Brains (2026-08-29).
// Reads fan out and carry their origin; writes have ONE default destination
// and refuse an unknown name. See adapters/multi-brain.ts for why.
export {
  BRAIN_ORIGIN_METADATA_KEY,
  brainOriginOf,
  createMultiBrainPort,
  createMultiBrainPortFromEnv,
} from "./adapters/multi-brain.js";
export type {
  MultiBrainDelegate,
  MultiBrainFromEnvOptions,
  MultiBrainPort,
  MultiBrainPortOptions,
  MultiBrainQueryReport,
  UnreachedBrain,
} from "./adapters/multi-brain.js";
export { primaryTarget, resolveBrainRoster, resolveWriteTarget } from "./adapters/brain-roster.js";
export type {
  BrainRoster,
  BrainRosterOptions,
  BrainTarget,
  WriteTargetResolution,
} from "./adapters/brain-roster.js";
// 8a-bis. Env-driven auto-wiring of V12 memory planes into every OODA agent (ADR-ECO-114)
export { applyEnvMemory } from "./orchestration/ooda/factory.js";

export { createCitadelCampaignMcpAdapter } from "./adapters/citadel-campaign-mcp.js";
export type { CitadelCampaignMcpClient } from "./adapters/citadel-campaign-mcp.js";

// 8b. LLM adapters — BYOM concrete implementations
export { LiteLLMAdapter } from "./adapters/llm/litellm.js";
export type { LiteLLMAdapterConfig } from "./adapters/llm/litellm.js";
export { AnthropicDirectAdapter } from "./adapters/llm/anthropic-direct.js";
export type { AnthropicDirectAdapterConfig } from "./adapters/llm/anthropic-direct.js";
export { CascadeAdapter } from "./adapters/llm/cascade.js";
export type { CascadeAdapterConfig } from "./adapters/llm/cascade.js";

// 8c. AgentRegistryPort — port interface + adapters (sprint-615:quick-5)
export type {
  AgentDescriptor as AgentRegistryDescriptor,
  AgentRegistryPort,
} from "./ports/agent-registry.js";
export { MemoryAgentRegistry } from "./adapters/registry/memory.js";
export { PostgresAgentRegistry } from "./adapters/registry/postgres.js";

// 8d. Messaging channel adapters (sprint-615:quick-2)
export { ConsoleChannel } from "./adapters/messaging/console.js";
export type { ConsoleChannelConfig } from "./adapters/messaging/console.js";
export {
  TelegramChannel,
  TelegramRateLimitError,
} from "./adapters/messaging/telegram.js";
export type { TelegramChannelConfig } from "./adapters/messaging/telegram.js";
export { SlackChannel } from "./adapters/messaging/slack.js";
export type { SlackChannelConfig } from "./adapters/messaging/slack.js";
export { DiscordChannel } from "./adapters/messaging/discord.js";
export type { DiscordChannelConfig } from "./adapters/messaging/discord.js";
export { MCPChannel, tracedMcpClient } from "./adapters/messaging/mcp.js";
export type {
  MCPChannelConfig,
  MCPClientLike,
} from "./adapters/messaging/mcp.js";

// 8e. OODA deps injection (sprint-615:quick-3 — plan v6 §3.7)
export type { OODAAgentDeps } from "./orchestration/ooda/types.js";

// 8f. OODA onStep callback (sprint-727:stream-capture-onstep)
export type { StepEvent } from "./orchestration/ooda/types.js";
export {
  MissingDependencyError,
  DepsValidationError,
} from "./orchestration/ooda/errors.js";

// 9. Deprecation helper (SDK v0.3.0 — Sprint-457)
export { deprecated } from "./deprecation.js";
export type { DeprecationOptions } from "./deprecation.js";

// 11. Traced port wrapper (SDK v0.3.0 — Sprint-460)
export { tracedPort } from "./tracing/traced-port.js";
export type { TracedPortOptions } from "./tracing/traced-port.js";

// ── Vague 1.B promotions (sprint-616) ────────────────────────────────────────

// 1.B.1 — Shared types (re-exported at bottom of file as §39)

// 1.B.2 — AgentFactory + boot patterns
export { createAgentFromConfig } from "./factory/agent-factory.js";
export type {
  AgentFactoryConfig,
  AgentFactoryDeps,
} from "./factory/agent-factory.js";
export { loadAgentContext } from "./boot/load-agent-context.js";
export type {
  AgentContext as AgentBootContext,
  LoadAgentContextOptions,
} from "./boot/load-agent-context.js";
export {
  loadRecentMemory,
  buildT0MemoryBlock,
} from "./boot/load-recent-memory.js";
export type {
  LoadRecentMemoryOptions,
  T0StableMemoryBlock,
  T0StableMemoryBlockOptions,
} from "./boot/load-recent-memory.js";

// 1.B.3 — SkillRegistryBuilder
export {
  buildSkills,
  buildSkillRegistry,
} from "./skills/skill-registry-builder.js";
export type {
  BuildSkillsOptions,
  SkillBuilderDeps,
  SkillRegistryBundle,
  DomainSkillEntry,
} from "./skills/skill-registry-builder.js";
export { BASE_SKILL_NAMES } from "./skills/base-skills.js";
export type { BaseSkillName } from "./skills/base-skills.js";

// 1.B.4 — Metrics
export { createAgentMetrics } from "./metrics/create-agent-metrics.js";
export type {
  AgentMetrics,
  CreateAgentMetricsOptions,
} from "./metrics/create-agent-metrics.js";

// 1.B.5 — Prompt + parser helpers
export { buildOrientPrompt } from "./prompts/build-orient-prompt.js";
export type { BuildOrientPromptOpts } from "./prompts/build-orient-prompt.js";
export {
  parseStructuredOutput,
  ParseStructuredOutputError,
} from "./llm/parse-structured-output.js";
export type { ParseStructuredOutputOpts } from "./llm/parse-structured-output.js";

// 1.B.6 — HITL infra (Slack + Telegram + API)
export { sendHITLApprovalRequestSlack, buildBlockKit } from "./hitl/slack.js";
export type { SendHITLSlackOpts, SlackApprovalResult } from "./hitl/slack.js";
export {
  sendHITLApprovalRequestTelegram,
  buildTelegramText,
} from "./hitl/telegram.js";
export type {
  SendHITLTelegramOpts,
  TelegramApprovalResult,
} from "./hitl/telegram.js";
export { createNodeSlackCallbackHandler } from "./hitl/callback-handlers.js";
export type { HITLHandlerResult, HITLCallbackData } from "./hitl/api.js";

// Remote-control — observe + steer a running agent from a remote client.
// Also available as the `@vauban-org/agent-sdk/remote` subpath.
export {
  SessionEventSchema,
  makeEvent,
  looksLikeSessionEvent,
  POD_START_STAGES,
  PodStartProgressPayloadSchema,
  type PodStartProgressStage,
  type PodStartProgressPayload,
  ALL_KNOWN_EVENT_TYPES,
  isKnownEventType,
  toCanonicalEventType,
  NOOP_SESSION_SINK,
  teeSink,
  InMemoryInstructionInbox,
  createRemoteControlHub,
  createRemoteApprovalChannel,
  createRemoteControlServer,
  encodePairingPayload,
  decodePairingPayload,
  connectRelay,
  createEd25519Signer,
  createEd25519Verifier,
  type SessionEvent,
  type SessionEventType,
  type SessionEventSink,
  type Instruction,
  type InstructionInbox,
  type RemoteControlPort,
  type SessionState,
  type SessionStatus,
  type LinkStatus,
  ALL_LINK_STATUSES,
  isLinkStatus,
  // SP-C.1 — the session-origin seam (types + guard + error; no substrate).
  ALL_SESSION_ORIGIN_KINDS,
  isSessionOriginKind,
  SessionOriginError,
  type AttachedSession,
  type SessionOrigin,
  type SessionOriginKind,
  type SessionRef,
  type SessionStartGrant,
  type SessionStartRequest,
  type SessionStartWork,
  type StartedSession,
  type RemoteApprovalChannel,
  type RemoteControlServerHandle,
  type RemoteControlServerOptions,
  type TeammateSendOutcome,
  type TeammateSendPort,
  type TeammateTargetInfo,
  type TeammateInfoPort,
  type TeammateInfoPeer,
  type TeammateInfoSession,
  type TeammateInfoSnapshot,
  type TeammateEventPushOutcome,
  type TeammateEventSinkPort,
  type PairingPayload,
  type RelayConnection,
  type SignFn,
  type VerifyFn,
} from "./remote/index.js";

// Beyond-Hermes W3-T2 — signed skill registry index (TUF-style Ed25519 over a
// SHA-256 Merkle root of skill targets). Imported from the module directly
// (not the skill-manifest barrel) to avoid the `SkillManifest` name collision
// with the markdown skill manifest re-exported via the skills barrel.
export {
  SIGNED_INDEX_SPEC_VERSION,
  UntrustedIndexError,
  assertTarballMatchesIndex,
  buildSignedIndex,
  computeKeyId,
  entryLeafHash,
  findIndexEntry,
  proveEntryInclusion,
  verifyEntryAgainstRoot,
  verifySignedIndex,
} from "./skill-manifest/signed-index.js";

// Beyond-Hermes W2 (skill-manifest core + skill-loop) top-level re-exports were
// reverted: re-exporting them here EVALUATES skill-manifest/verifier -> proof ->
// @vauban-org/proof-core, whose wasm init uses a top-level await that never
// settles in the bundled Node startup, hanging EVERY SDK consumer at boot (Vera
// crash-looped on 'unsettled top-level await init_cmd_agent'). Unit tests passed
// (they import targeted modules, not the bundled bootstrap). Do NOT re-add these
// index re-exports until the proof-core wasm init is made lazy / non-top-level.
// The modules remain available via their package.json subpath exports.
export type {
  BuildSignedIndexOptions,
  EntryInclusion,
  IndexVerifyResult,
  SignedSkillIndex,
  SkillIndexEntry,
  UntrustedIndexCode,
} from "./skill-manifest/signed-index.js";

export type {
  SkillCandidate,
  VerifierExample,
  EvalResult,
  ABConfig,
  ABSlot,
  SignOffDecision,
  SignOffRecord,
  PendingRequest,
  AdoptionStatus,
  AdoptionRecord,
  SkillVersion,
  UsageEvent,
  SkillValueResult,
} from "./skill-loop/index.js";

// Beyond-Hermes W3-T5 — memory write provenance (Ed25519 attestation over
// episodic memory writes ; AgentPoison / MINJA defense).
export {
  attestMemoryWrite,
  memoryEntryContentHash,
  ProvenancedEpisodicMemory,
  verifyMemoryProvenance,
} from "./memory-provenance.js";
export type {
  AttestMemoryOptions,
  MemoryAttestation,
  MemoryContent,
  MemoryProvenanceReason,
  MemoryProvenanceResult,
} from "./memory-provenance.js";

// T6a — pre-tool-call veto window.
export {
  InMemoryVetoChannel,
  type VetoChannel,
  type VetoSignal,
} from "./remote/index.js";

// T6e — attested proof claim (compact shareable run summary).
// P10 — payment receipt embedding (zkpay Sepolia POC).
export {
  exportProofClaim,
  verifyProofClaim,
  withPaymentReceipt,
  type ExportProofClaimOptions,
  type PaymentAuthorization,
  type ProofClaim,
  type ProofClaimVerification,
  type SettlementReceipt,
} from "./remote/index.js";

// T6f — capability-scoped sub-tokens (HMAC-attenuated handoff).
// P1b-2 — `rebindSubToken` upgrades a bearer sub-token to device-bound.
export {
  mintSubToken,
  rebindSubToken,
  verifySubToken,
  resolveAuthScope,
  scopeCovers,
  type MintSubTokenOptions,
  type RebindSubTokenOptions,
  type RebindSubTokenResult,
  type SubTokenClaims,
  type SubTokenScope,
  type VerifySubTokenResult,
} from "./remote/index.js";

// P7 — durable backing store (revocations survive process restart).
export {
  InMemoryPersistencePort,
  loadHubFromPersistence,
  SqlitePersistencePort,
  sqlitePathForSession,
  tryPersistEvent,
  type PersistencePort,
  type SqlitePersistenceOptions,
} from "./remote/index.js";

// P11 — sub-token OTEL instrumentation.
export {
  classifyReason,
  hashJti,
  mintSubTokenInstrumented,
  recordRevocation,
  resolveAuthScopeInstrumented,
  verifySubTokenInstrumented,
} from "./remote/index.js";

// P1b — DPoP device-binding (RFC 9449 + RFC 7800 cnf claim).
export {
  computeJwkThumbprint,
  DpopReplayStore,
  validateDpopProof,
  type DpopClaims,
  type DpopValidationFailure,
  type DpopValidationResult,
  type EcP256Jwk,
  type ValidateDpopOptions,
  type ValidatedDpop,
} from "./remote/index.js";

// T4 — multi-platform gateway: one agent session reachable from Telegram,
// Discord and Slack at once. Also on the `@vauban-org/agent-sdk/remote` subpath.
export {
  createGateway,
  renderEventForChat,
  createTelegramAdapter,
  createDiscordAdapter,
  createSlackAdapter,
  type GatewayHandle,
  type GatewayOptions,
  type GatewayAdapter,
  type InboundMessage,
  type ApprovalPrompt,
  type ApprovalCallback,
} from "./remote/index.js";

// 1.B.7 — Tier templates
export {
  createSimpleAgent,
  createComplexAgent,
  createReasoningAgent,
} from "./templates/index.js";
export type { ComplexAgentOptions } from "./templates/complex-agent.js";

// 1.B.8 — EconomyRouter (new EconomyRouter from sprint-616 — existing re-exported at §37)
export type {
  EconomyRouterOpts,
  ProviderTier,
  CostEntry,
} from "./economy/economy-router.js";

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

// 12b. Retry primitives — RetryConfig, retry(), RetryContext + 4 presets (SDK v1.2.0 — sprint-680)
export {
  retry,
  RetryContext,
  RetryExhaustedError,
  calculateDelay,
  shouldRetry,
  RETRY_TRANSIENT,
  RETRY_AGGRESSIVE,
  RETRY_PATIENT,
  NO_RETRY,
} from "./retry/index.js";
export type { RetryConfig, RetryOptions, SleepFn } from "./retry/index.js";

// 12d. SkillContext extensions — secrets audit, progress, time tracking (SDK v1.2.0 — sprint-685)
export {
  InMemorySecretsAccessor,
  NOOP_SECRETS,
  SecretNotFoundError,
  createSkillContext,
} from "./orchestration/ooda/skills.js";
export type {
  SecretsAccessor,
  ProgressCallback,
  CreateSkillContextOptions,
} from "./orchestration/ooda/skills.js";

// 12c. Container execution protocol — uniform contract for binary/container automations (SDK v1.2.0 — sprint-684)
export {
  PROTOCOL_ENV,
  DEFAULT_PROTOCOL_MODE,
  ProtocolParseError,
  buildProtocolEnv,
  parseProtocolOutput,
  parseStderrLogs,
} from "./container/protocol.js";
export type {
  ProtocolStatus,
  ProtocolResult,
  ExecutionResult,
} from "./container/protocol.js";
export { ContainerRuntime } from "./container/runtime.js";
export type {
  ContainerRuntimeOptions,
  ContainerExecutionOptions,
  BinaryExecutionOptions,
  SandboxExecutor,
  SandboxJob,
  SandboxResult,
  SpawnFn as ContainerSpawnFn,
} from "./container/runtime.js";

// 13. Outcomes module (SDK v0.5.1 — Sprint-522)
export * from "./outcomes/index.js";

// 13b. Quality scoring helper (SDK 1.8.0 — promoted from forge 2026-05-17)
// SDK 2.25 ; Productive Cycle Evidence pattern (ADR-052 candidate) adds
// computeQualityOrNull + isIdleCycle + ProductiveQualityInputs.
export {
  computeQuality,
  computeQualityOrNull,
  computeQualityWithBreakdown,
  isIdleCycle,
} from "./quality/index.js";
export type {
  ProductiveQualityInputs,
  QualityInputs,
  QualityBreakdown,
  QualityContribution,
} from "./quality/index.js";

// 13c. Alert digest helper (SDK 1.9.0 — promoted from forge 2026-05-17)
export { buildAlertDigest } from "./alerts/index.js";
export type { AlertItem, AlertDigestOptions } from "./alerts/index.js";

// 14. Proof module (SDK v0.5.2 — Sprint-521 Bloc 1)
// Note: proof/index.js re-exports from @vauban-org/proof-core (optional peerDep).
// Import via subpath @vauban-org/agent-sdk/proof — do NOT wildcard here.

// 15. Runs streaming + health (SDK v0.5.3 — sprint-523)
export * from "./runs/index.js";
export {
  initVaubanSDK,
  getSDKProvider,
  getSDKProvider as getSDKConfig,
  reportRunStart,
  reportRunFinish,
  createOtelClient,
} from "./otel/ingest.js";
export type {
  VaubanSDKOptions,
  IngestSpansResult,
  OtelClient,
} from "./otel/ingest.js";
export type {
  OtlpSpan,
  OtlpAttribute,
  OtlpAttributeValue,
} from "./otel/types.js";
// W3C Trace Context propagation primitives.
// injectTraceContext is the send-side (consumed by tracedMcpClient);
// extractTraceContext is the receive-side primitive an MCP server uses to
// continue an incoming trace. The per-server context.with wiring lives in the
// separate MCP server deployments (CC, brain, citadel), out of agent-sdk scope.
export {
  registerW3CPropagator,
  injectTraceContext,
  extractTraceContext,
  withDelegationAttribute,
} from "./otel/trace-context.js";

// 16. OODA orchestration primitive (SDK v0.7.0 — sprint-525 Bloc 5a)
//     + idempotency keys + bulkhead worker pool (SDK v0.8.3 — sprint-468)
//     + withStructuredOutput Zod retry (SDK v0.11.0 — sprint-562:A5)
export * from "./orchestration/index.js";
export {
  withStructuredOutput,
  StructuredOutputError,
} from "./orchestration/ooda/structured-output.js";
export type {
  StructuredOutputOptions,
  StructuredOutputResult,
} from "./orchestration/ooda/structured-output.js";

// 25. Guardrails — pre/post phase enforcement + Poseidon proof hash (SDK v0.11.0 — sprint-563:B1)
export {
  runPreGuards,
  runPostGuards,
  guardrailViolationToEvent,
  PII_GUARD,
  createMaxInputLengthGuard,
} from "./orchestration/ooda/guardrails.js";
export type {
  GuardrailDef,
  GuardrailTiming,
  GuardrailResult,
  GuardrailViolation,
} from "./orchestration/ooda/guardrails.js";

// 26. Multi-agent handoff (SDK v0.11.0 — sprint-563:B2)
export {
  handoff,
  HandoffCycleError,
  handoffToEvent,
  asAgentTool,
} from "./orchestration/ooda/handoff.js";
export type {
  HandoffOptions,
  HandoffResult,
  AgentHandoffClient,
} from "./orchestration/ooda/handoff.js";

// 27. Phase-level model routing (SDK v0.11.0 — sprint-563:B4)
export {
  resolveForPhase,
  getFallbackChain,
} from "./orchestration/ooda/phase-routing.js";
export type {
  ModelSpec,
  PhaseModelConfig,
} from "./orchestration/ooda/phase-routing.js";

// 17. Skill Catalog — 13 builtin skills + record_outcome (SDK v0.7.0 — sprint-525 quick-5)
// 19. Skill Ledger types + resolveSkillsForAgent (SDK v0.8.0 — sprint-530:quick-4) — re-exported via skills/index.js
export * from "./skills/index.js";

// 18. Agent-specific types (SDK v0.7.1 — sprint-526 Bloc 5b)
export * from "./agents/index.js";

// 20. REST clients (SDK v0.8.2 — sprint-524:quick-9)
export * from "./clients/index.js";

// 21. Chaos testing helpers — type exports only (SDK v0.8.4 — sprint-477)
// Runtime functions (Proxy-based) available via subpath:
//   import { injectBrainFailure, networkJitter, wholeCircuit, exhaustResources }
//     from "@vauban-org/agent-sdk/testing/chaos";
export type {
  InjectBrainFailureOptions,
  ExhaustResourcesOptions,
} from "./testing/chaos.js";

// 10. Typed port errors (SDK v0.3.0 — Sprint-459) + OODA audit errors (A1 — sprint-561)
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
  MissingDryRunFlagError,
} from "./errors.js";

// 23. Replay module — ClockPort + RandomPort + LLMResponseCache + replayFrom (SDK v0.10.0 — sprint-561:a3)
export {
  RealClock,
  RecordedClock,
  ClockExhaustedError,
  RealRandom,
  RecordedRandom,
  CryptoRandomDuringReplayError,
  InMemoryLLMResponseCache,
  hashLLMCacheKey,
  replayFrom,
  NonDeterministicReplayError,
} from "./replay/index.js";
export type {
  ClockPort,
  RandomPort,
  LLMCacheKey,
  LLMCacheEntry,
  LLMResponseCache,
  ReplayMode,
  ReplayContext,
  ReplayResult,
  ReplayLoader,
  ReplayRunner,
} from "./replay/index.js";

// 22. TRACE_V1 schema + canonical + PayloadPolicy + KeyProvider (SDK v0.10.0 — sprint-561:a2)
export { TRACE_SCHEMA_VERSION } from "./trace/schema.js";
export type {
  Trace,
  TraceStep,
  SignedReceipt,
  ReceiptStatus,
} from "./trace/schema.js";
export {
  canonicalize,
  NonSerializablePayloadError,
} from "./trace/canonical.js";
export { defaultPolicy, payloadHash } from "./trace/policy.js";
export type {
  PayloadPolicy,
  PIIDetector,
  PayloadHashResult,
} from "./trace/policy.js";
export { STRICT_PII_DETECTOR } from "./trace/strict-pii-detector.js";
export {
  reconstructInitialMessages,
  TraceReplayError,
} from "./trace/rewind.js";
export type { ReplayMessage, ReconstructOptions } from "./trace/rewind.js";
// L0 execution-state ; RunStatePort + trace projections (ADR-ECO-101 W2 GATE)
export {
  inMemoryRunState,
  traceToMermaid,
  findBreakpoint,
  injectAt,
} from "./trace/run-state.js";
export type { RunStatePort } from "./trace/run-state.js";
export {
  EnvKeyProvider,
  ExternalKMSKeyProvider,
} from "./ports/key-provider.js";
export type {
  KeyProvider,
  ExternalKMSKeyProviderOptions,
} from "./ports/key-provider.js";

// 24. ProofChain SHA-256 + verifyChain + TimestampPort + ReceiptQueue (SDK v0.10.0 — sprint-561:a4)
export { sha256, hmacSha256 } from "./proof/sha256.js";
export type {
  ProofChain,
  ProofChainEntry,
  VerifyChainResult,
} from "./proof/chain.js";
export {
  buildChain,
  computeStepHash,
  verifyChain,
  GENESIS_PREV_HASH,
} from "./proof/chain.js";
export { NullTimestampPort } from "./ports/timestamp.js";
export type { TimestampPort } from "./ports/timestamp.js";
export {
  FallbackAdapter,
  AllAdaptersFailedError,
} from "./proof/fallback-adapter.js";
export type { ReceiptQueue, ReceiptQueueEntry } from "./proof/receipt-queue.js";
export {
  InMemoryReceiptQueue,
  DEFAULT_BACKOFF_MS,
  HmacInvalidError,
} from "./proof/receipt-queue.js";

// 28. Learning loop shadow mode (SDK v0.13.0 — sprint-564:C2)
export {
  shouldLearn,
  extractSkillFromTrace,
  GOLDEN_FIXTURES,
} from "./orchestration/ooda/learn.js";
export type {
  LearningTrigger,
  ExtractedSkill,
  LearnOptions,
} from "./orchestration/ooda/learn.js";

// 28.1 Skill capture (SDK v1.13.0 — sprint-727:skill-capture)
// Wires shouldLearn + extractCandidate into OODA feedback phase.
export { captureSkillFromCycle } from "./orchestration/ooda/skill-capture.js";
export type {
  SkillCaptureOptions,
  CaptureResult,
} from "./orchestration/ooda/skill-capture.js";

// 29. Immune detection MAAG (SDK v0.13.0 — sprint-564:C3)
export {
  cosineSimilarity,
  StressLedger,
  validateGoldenFixtures,
  GOLDEN_ATTACK_EMBEDDINGS,
} from "./safety/immune.js";
export type { ImmuneMemoryEntry, ImmuneMatch } from "./safety/immune.js";

// 30. Trajectory export (SDK v0.13.0 — sprint-563:B3)
export {
  exportTrajectory,
  serializeTrajectory,
} from "./outcomes/trajectory.js";
export type {
  TrajectoryFormat,
  TrajectoryOptions,
  TrajectoryStep,
  TrajectoryExport,
} from "./outcomes/trajectory.js";

// 31. AgentMeter + OutcomeGate (SDK v0.13.0 — sprint-563:B7)
export { AgentMeter, validateOutcome } from "./outcomes/meter.js";
export type {
  MeterEntry,
  MeterBalance,
  MeterVerifyResult,
  OutcomeGateResult,
  OutcomeGateOptions,
} from "./outcomes/meter.js";

// 32. HTTP VCR cassettes (SDK v0.13.0 — sprint-563:B9)
export { HttpVCR, UndeterministicSideEffectError } from "./replay/http-vcr.js";
export type { VCRMode, VCRCassette, VCRStats } from "./replay/http-vcr.js";

// 33. Compute primitive — withCompute + strategies (SDK v0.16.0 — sprint-580 Sprint A)
export { withCompute } from "./compute/with-compute.js";
export {
  BudgetExhaustedError,
  DeadlineExceededError,
  InvalidStrategyError,
} from "./compute/with-compute.js";
export type {
  WithComputeOptions,
  WithComputeResult,
} from "./compute/with-compute.js";
export type {
  ComputeContext,
  Strategy,
  StrategyResult,
} from "./compute/types.js";
export { singleShotStrategy } from "./compute/strategies/single-shot.js";
export { bestOfNStrategy } from "./compute/strategies/best-of-n.js";
export type {
  BestOfNRewardModel,
  BestOfNOptions,
} from "./compute/strategies/best-of-n.js";
export { bonMavStrategy } from "./compute/strategies/bon-mav.js";
export type {
  MAVAggregation,
  BonMavOptions,
} from "./compute/strategies/bon-mav.js";
export { treeOfThoughtsStrategy } from "./compute/strategies/tree-of-thoughts.js";
export type {
  ToTConfig,
  ToTSearchPolicy,
} from "./compute/strategies/tree-of-thoughts.js";
export { mixtureOfAgentsStrategy } from "./compute/strategies/mixture-of-agents.js";
export type { MoAConfig } from "./compute/strategies/mixture-of-agents.js";
export {
  estimateDifficulty,
  extractFeatures,
  recommendStrategy,
} from "./compute/difficulty-estimator.js";
export type {
  DifficultyClass,
  TaskFeatures,
} from "./compute/difficulty-estimator.js";
export { assertVerifierResult } from "./compute/verifier.js";
export type { Verifier, VerifierResult } from "./compute/verifier.js";
// Bounded fan-out + deterministic fan-in combinators (ADR-ECO-101 W3 / I4 GATE)
export { fanOut, fanInArgmin } from "./compute/fan.js";
export type { FanInResult } from "./compute/fan.js";
// AdvisoryClaim type boundary ; keep predictions out of the gate / A3 domain (ADR-ECO-101 I2 GATE)
export {
  advisoryClaim,
  isAdvisory,
  assertNotAdvisory,
} from "./compute/advisory.js";
export type { AdvisoryClaim, AdvisoryProvenance } from "./compute/advisory.js";
// VerifierBattery ; governed rejection-sampling primitive (Atropos technique re-expressed as a provable control)
export {
  runVerifierBattery,
  BatteryGovernanceError,
  VERIFIER_BATTERY_GUARD,
} from "./compute/battery/battery.js";
export type {
  BatteryLens,
  BatteryDecision,
  BatteryTraceStep,
  CandidateVerdict,
  LensVerdict,
  RejectedCandidate,
  LensEngine,
  VerifierCtx,
  RunVerifierBatteryOptions,
} from "./compute/battery/types.js";
// StructuredOutputGuard ; schema-validation lens for batteries gating LLM structured output
export {
  guardStructuredOutput,
  structuredOutputGuard,
} from "./verify/structured-output-guard.js";
export type { StructuredOutputVerdict } from "./verify/structured-output-guard.js";
// noveltyLens ; diversity gate (refute lens) + tokenJaccard similarity
export { noveltyLens, tokenJaccard } from "./verify/verifiers/novelty.js";
// skillSafetyLens ; write-time skill verifier (Wave 2, syntactic gate)
export {
  skillSafetyLens,
  skillSafetyDeny,
  skillSafetyAllow,
  MIN_SKILL_BODY_TOKENS,
} from "./verify/verifiers/skill-safety.js";
// cost-gate ; ADR-ECO-045 session cost gate as a battery lens (faithful port of cost-gate.rego)
export {
  costGateLens,
  costGateDeny,
  costGateAllow,
  BUDGET_CAP,
  FORBIDDEN_MODEL_FAMILIES_PER_TIER,
  // deprecated 2026-09-01, kept for the 24-month public-stable window ; no longer
  // drives the verdict (see cost-gate.ts).
  FORBIDDEN_MODELS_PER_TIER,
  COST_GATE_ADR,
} from "./verify/verifiers/cost-gate.js";
export type {
  AgentRunDeclaration,
  Tier,
} from "./verify/verifiers/cost-gate.js";
// ActionGate ; pre-action runtime gate (Phase 3: VerifierBattery as a loop control)
export type {
  ActionGate,
  ActionGateCall,
  ActionGateVerdict,
} from "./permissions/action-gate.js";
// Fail-closed AND-composition of ActionGates (ADR-ECO-092 preste seam consumer #2).
export { composeActionGates } from "./permissions/action-gate.js";
export { batteryActionGate } from "./compute/battery/action-gate.js";
export type { BatteryActionGateOptions } from "./compute/battery/action-gate.js";
// Signed gate-verdict envelope ; Delivery Control Plane keystone (tamper-evident,
// replay-resistant, verifier-signed; the control plane verifies it in-transaction)
export {
  GATE_DECISION_KIND,
  reconstructDecisionCore,
  recomputeOutputHash,
  canonicalEnvelopeString,
  buildGateEnvelope,
  signGateEnvelope,
  verifyGateEnvelope,
  checkRequiredAnchors,
} from "./compute/battery/gate-envelope.js";
export type {
  GateDecisionCore,
  GateVerdictEnvelope,
  BuildGateEnvelopeParams,
  EnvelopeVerification,
} from "./compute/battery/gate-envelope.js";
// Delivery gate machinery ; the PRODUCER side of the envelope above. Deterministic
// anchor lenses (ANCHOR_CHECKS), the B3 commit binding, config validation, the
// drift twin, and the zero-trust test-command allowlist. See src/delivery/index.ts
// for the module frontier (node:child_process / node:fs live in ONE file there).
export {
  ADVERSARY_ANGLES,
  ANCHOR_CHECKS,
  buildAdversaryLenses,
  buildAnchorLens,
  buildDriftLens,
  buildFileReader,
  buildGitExec,
  buildRealExec,
  CONFIG_GROUNDED_ANCHORS,
  DRIFT_ANCHOR_ID,
  ENGINE_GROUNDED_ANCHORS,
  EXECUTION_GROUNDED_ANCHORS,
  extractTestFailureDetail,
  POST_CHAR_LIMIT,
  runConfigValidation,
  runDriftGate,
  runGate,
  runGateUnsigned,
  runGroundedTests,
  validateTestCommand,
} from "./delivery/index.js";
export type {
  AdversaryConfigInput,
  AdversaryIntensity,
  AnchorCheck,
  AnchorSpecInput,
  ConfigValidationResult,
  DriftArtifact,
  EngineVerdict,
  ExecFn,
  ExecResult,
  FileReader,
  FrozenIntent,
  GroundedTestResult,
  ParsedTestCommand,
  RefuteFn,
  RunDriftGateInput,
  RunGateAdversaryInput,
  RunGateInput,
  RunGateResult,
  RunGateUnsignedInput,
  RunGateUnsignedResult,
  UnsignedGateVerdictEnvelope,
} from "./delivery/index.js";

// 32c. delegate() ; governed sub-agent delegation primitive (ADR-ECO-076):
// strict-subset capability attenuation + fail-closed per-call ActionGate +
// one audit step into the parent rootHash. spawnChildAgent is its adapter.
export {
  delegate,
  attenuationLens,
  baseToolName,
  CHILD_SYSTEM_PROMPT,
  DELEGATION_ADR,
  DEFAULT_CHILD_MAX_STEPS,
  NON_DELEGABLE_TOOLS,
  ORIENTATION_TOOLS,
} from "./delegation/delegate.js";
export type {
  DelegateInput,
  DelegationGrant,
  DelegationPlan,
} from "./delegation/delegate.js";

// 32d. teammate-message ; governed inter-agent messaging envelope (TM1 of the
// governed-teammates SHAPE v2 slice, packages/cli/docs/teammates-plan.md).
// Thin layer over delegate.ts: reuses baseToolName() + runVerifierBattery() so
// a message-claim audit step folds into the SAME per-run TraceAccumulator
// (spawn-child-agent.ts, TM0) as a delegation-grant audit step.
export {
  buildTeammateEnvelope,
  buildTeammateEnvelopeV2,
  canonicalTeammateEnvelopeString,
  CONTROL_VERB_REQUIRED_SCOPE,
  CONTROL_VERBS,
  CONTROLLER_CONTROL_ADR,
  controllerControlScopeLens,
  isControlClaimKind,
  isControlVerb,
  isHitlGatableClaimKind,
  isRecognizedClaimKind,
  isTeamActionVerb,
  MAX_TEAMMATE_BODY_BYTES,
  messageClaimScopeLens,
  parseTeamActionBody,
  parseTeamCoordinateBody,
  parseTeamDelegateBody,
  parseTeamListBody,
  parseTeamSendBody,
  parseTeamStartBody,
  RECOGNIZED_CLAIM_KINDS,
  requiredScopeForControlVerb,
  TEAM_ACTION_VERBS,
  TeamActionBodyError,
  TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2,
  TeammateBodyTooLargeError,
  TeammateEnvelopeInputError,
  verifyControlClaim,
  verifyMessageClaim,
  verifyTeammateEnvelopeSignature,
} from "./delegation/teammate-message.js";
export type {
  BuildTeammateEnvelopeInput,
  BuildTeammateEnvelopeV2Input,
  ControlClaimVerdict,
  ControlScope,
  ControlVerb,
  MessageClaimVerdict,
  TeamActionRequest,
  TeamActionVerb,
  TeamCoordinateRequest,
  TeamDelegateRequest,
  TeamListRequest,
  TeamSendRequest,
  TeamStartRequest,
  TeammateEnvelope,
  TeammateEnvelopePorts,
  TeammateEnvelopeV1,
  TeammateEnvelopeV2,
  TeammateEnvelopeVerification,
  TeammateMessageClaim,
  VerifyControlClaimOptions,
  VerifyMessageClaimOptions,
} from "./delegation/teammate-message.js";
// 32e. capability-tier-registry ; C1 of the HITL tier-gate slice
// (packages/cli/docs/teammates-l2-plan.md Sprint L2-C): the source-of-truth
// mapping capability -> AI-agent tier (T1-T4)/HITL requirement. Consumed via
// capabilityRegistryFromConfig by the CLI's teammate-mailbox.ts,
// spawn-child-agent.ts, daemon/daemon-server.ts and cmd-chat.ts to gate
// teammate asks; permissive default so classify() is safe to call
// speculatively when no config overrides are supplied.
export {
  createCapabilityTierRegistry,
  DEFAULT_CAPABILITY_TIER_CLASSIFICATION,
} from "./delegation/capability-tier-registry.js";
export type {
  CapabilityTier,
  CapabilityTierClassification,
  CapabilityTierOverrides,
  CapabilityTierRegistry,
  CapabilityTierRegistryOptions,
} from "./delegation/capability-tier-registry.js";

export {
  runTwoPhaseOrient,
  TwoPhaseOrientError,
} from "./compute/strategies/two-phase-orient.js";
export type {
  TwoPhaseOrientConfig,
  TwoPhaseOrientResult,
} from "./compute/strategies/two-phase-orient.js";

// 33b. mesh.delegate() — intent-based dispatch + capability attenuation (sprint-585)
// DEPRECATED (sprint-877 reconciliation, 2026-07-05): zero callers in this
// monorepo outside src/mesh/** and its own tests. Canonical governed
// sub-agent delegation is `delegate()` from ./delegation/delegate.js
// (ADR-ECO-076). Not removed here: live un-namespaced npm export at v3.3.0;
// removal requires a major bump + changeset (see api-contract.yml). See the
// STATUS note atop src/mesh/delegate.ts.
export {
  meshDelegate,
  createMeshDelegate,
  DelegateAttenuationError,
} from "./mesh/delegate.js";
export type {
  DelegateOptions,
  DelegateResult,
  DelegateChunk,
} from "./mesh/delegate.js";
export {
  DefaultMeshDispatcher,
  MeshDispatchError,
  DeadlineExceededError as MeshDeadlineExceededError,
  defaultClassifier as meshDefaultClassifier,
} from "./mesh/dispatcher.js";
export type {
  MeshDispatcher,
  DispatchIntent,
  DispatchResult,
  DispatcherConfig,
} from "./mesh/dispatcher.js";
export {
  attenuateScope,
  buildToken as buildAttenuatedToken,
  parseToken as parseAttenuatedToken,
  scopeAllows,
} from "./mesh/attenuation.js";
export type {
  AttenuatedToken,
  MeshCapabilityScope,
} from "./mesh/attenuation.js";
export type {
  MeshAgentKind,
  DelegationLink as MeshDelegationLink,
} from "./mesh/types.js";

// 34. BrainPort eviction policies (sprint-580 Sprint A)
export {
  lruPolicy,
  importanceWeightedPolicy,
  agentControlledPolicy,
} from "./ports/eviction-policy.js";
export type {
  WorkingMemoryEntry,
  EvictionPolicy,
} from "./ports/eviction-policy.js";

// 35. AgentRegistry multi-kind capability cards (sprint-580 Sprint A)
export { AGENT_KINDS } from "./registry/agent-capability.js";
export type {
  AgentKind,
  CostTier,
  LatencyTier,
  AgentCapabilityCard,
} from "./registry/agent-capability.js";

// 35b. ERC-8004-style agent identity (off-chain half) — `registration.json`
//      builder + validator: a spec-shaped document any ERC-8004 reader can
//      ingest, carrying the Vauban `run-certificate` trust mechanism and the
//      payment-receipt-chain `agentWallet` binding.
export {
  buildErc8004Registration,
  validateErc8004Registration,
  toRegistrationJson,
  canonicalAgentId,
} from "./registry/erc8004-registration.js";
export type {
  Erc8004Registration,
  Erc8004RegistrationInput,
  Erc8004Service,
  Erc8004Trust,
  Erc8004X402Support,
} from "./registry/erc8004-registration.js";

// 37. Economy module — TierPolicy + OutcomeTracker + FleetCircuitBreaker + EconomyRouter (sprint-584 Sprint D)
export type {
  ModelTier,
  TierPolicy,
  OutcomeHook,
  CycleCost,
  EconomyMode,
  EconomyRouterConfig,
  RouteDecision,
  CircuitBreakerConfig,
  CostRecord,
  CostAccountingSnapshot,
  CostAccountingPort,
  CostAccountingOptions,
} from "./economy/index.js";
export {
  DefaultTierPolicy,
  lookupTier,
  OutcomeTracker,
  EconomyRouter,
  FleetCircuitBreaker,
  createCostAccountingPort,
} from "./economy/index.js";

// 38. Event auth helpers — HMAC signing + verification (ADR-ECO-017 — sprint-615:quick-7)
export { signEvent, canonicalEventString } from "./auth/sign-event.js";
export { verifyEvent } from "./auth/verify-event.js";
export type { VerifyEventOptions } from "./auth/verify-event.js";
export { InMemoryNonceStore, RedisNonceStore } from "./auth/nonce-store.js";
export type { NonceStore, RedisClientLike } from "./auth/nonce-store.js";
export {
  InvalidSignatureError,
  ClockSkewError,
  ReplayDetectedError,
  UnknownSourceError,
  CertChainInvalidError,
  CertExpiredError,
  InstallRevokedError,
} from "./auth/errors.js";

// Updated EventBus types (DomainEvent + EventSource + Subscription)
export type {
  DomainEvent,
  EventSource,
  Subscription,
} from "./ports/event-bus.js";

// 36. Constitution module — 5-axiom scorer + hard gate (sprint-581 Sprint B)
export type {
  AxiomId,
  GateSeverity,
  GateViolation,
  SignalPoint,
  CycleStep,
  CycleMetadata,
  CycleSnapshot,
  ScoringResult,
  ScoringFunction,
  RegisteredScorer,
  ParentCycleContext,
  GateResult,
  SignalBrainPort,
  AxiomScoreEntry,
} from "./constitution/index.js";
export {
  cycleSnapshotSchema,
  INSTITUTIONNEL,
  SOTA,
  ROBUSTE,
  ANTI_FRAGILE,
  PROFITABLE,
  BUILT_IN_AXIOMS,
  SECRET_PATTERN,
  institutionnelScorer,
  sotaScorer,
  robusteScorer,
  antiFragileScorer,
  profitableScorer,
  ScorerRegistry,
  defaultScorerRegistry,
  HardGate,
  hardGate,
  publishSignal,
  publishAllSignals,
} from "./constitution/index.js";

// 40. Events catalogue — 19 versioned Zod schemas (sprint-619:quick-4, plan v6 §4.2-4.3)
export {
  EventSchemas,
  resolveSchema,
  validateEvent,
} from "./events/catalogue.js";
export type { EventType, EventTypeName } from "./events/catalogue.js";

// 39. Shared agent types — promoted from Forge (Vague 1.B.1)
export type {
  EscalationLevel,
  AgentAction,
  AgentDependencies,
} from "./types/agent.js";
export { toSdkEscalationLevel } from "./types/escalation-mapping.js";
export type { SdkEscalationLevel } from "./types/escalation-mapping.js";

// 41. Formal verification (sprint-587) — Z3 4-state SAFE/UNSAFE/UNKNOWN/SKIPPED
export {
  formalVerify,
  DEFAULT_POLICIES,
  applyPolicy,
  AXIOM_SPECS,
  compileToSmt,
} from "./verify/formal/index.js";
export type {
  ConsumerMode,
  FormalVerifyResult,
  FormalVerifyState,
  AxiomPolicy,
  AxiomSpec,
  PolicyAction,
  PolicyDecision,
  VerifyContext,
  OnUnknown,
  OnUnsafe,
  Condition,
  FormalSolver,
  FormalVerifyDecision,
} from "./verify/formal/index.js";

// AgentPersona (CC v3.1 — Livrable E)
export {
  DEFAULT_PERSONA,
  mergePersona,
  PersonaSchema,
  validatePersona,
} from "./identity/persona-schema.js";
export type {
  AgentPersona,
  PersonaTone,
  PersonaFormality,
  PersonaExplainReasoning,
  PersonaAcknowledgmentStyle,
} from "./identity/persona-schema.js";
export {
  PERSONA_BRAIN_CATEGORY,
  personaTags,
  savePersonaToBrain,
  loadPersonaFromBrain,
  loadPersonaFromFile,
  savePersonaToFile,
  resolvePersona,
} from "./identity/agent-persona.js";
export type {
  ResolvePersonaOptions,
  ResolvedPersona,
} from "./identity/agent-persona.js";

// Persona prompt builder (CC v3.1 — Livrable E)
export { buildPersonaPromptBlock } from "./identity/persona-prompt.js";

// EpisodicMemory RRF (CC v3.1 — Livrable F)
// cosineSimilarity already exported via sprint-564:C3 above
export type {
  EpisodicMemoryEntry,
  SemanticMemoryPort,
  WorkingMemoryPort,
  WorkingMemorySlot,
  WorkingMemorySetOptions,
  EpisodicMemoryPort,
  EpisodicEvent,
  EpisodicAppendOptions,
  EpisodicQueryFilter,
  ProceduralMemoryPort,
  ProceduralSkill,
} from "./ports/brain.js";
export {
  recencyScore,
  scoreEntries,
  recallEpisodicRrf,
  DEFAULT_RRF_WEIGHTS,
  DEFAULT_RECENCY_HALFLIFE_MS,
} from "./memory/episodic-rrf.js";
export type {
  RrfWeights,
  RrfOptions,
  ScoreComponents,
  ScoredEntry,
  RrfScorers,
  EpisodicCosineFn,
  RecallRrfOptions,
} from "./memory/episodic-rrf.js";

// 42. Marketing primitives (SDK 1.15.0) ; persona-driven content quality gate
export { evaluateQualityGate } from "./marketing/quality-gate.js";
export type {
  MarketingGateInput,
  MarketingGateResult,
} from "./marketing/quality-gate.js";

// 43. Publishers (SDK 1.15.0) ; PublisherPort + 5 concrete adapters
// Port (canonical location since 1.16.x)
export type {
  PublisherPort,
  PublishInput,
  PublishResult,
  PublishStatus,
  PublishContext,
  PublisherChannel,
} from "./ports/publisher.js";
// Adapters (canonical location since 1.16.x)
export { XPublisher } from "./adapters/publishers/x.js";
export type {
  XPublisherConfig,
  XPublisherOptions,
} from "./adapters/publishers/x.js";
export { EmailPublisher } from "./adapters/publishers/email.js";
export type { EmailPublisherConfig } from "./adapters/publishers/email.js";
export { DiscordPublisher } from "./adapters/publishers/discord.js";
export type { DiscordPublisherConfig } from "./adapters/publishers/discord.js";
export { GitHubPublisher } from "./adapters/publishers/github.js";
export type { GitHubPublisherConfig } from "./adapters/publishers/github.js";
export { RempartPublisher } from "./adapters/publishers/rempart.js";
export type {
  RempartPublisherConfig,
  RempartMcpCaller,
} from "./adapters/publishers/rempart.js";
// Registry stays in publishers/ (orchestration concept, not a port or adapter)
export { createPublisherRegistry } from "./publishers/registry.js";
export type {
  PublisherRegistry,
  PublisherRegistryInput,
} from "./publishers/registry.js";

// 44. CRITIC pattern — tool-grounded self-correction loop (Gou et al., ICLR 2024 arXiv:2305.11738)
export { criticLoop } from "./loop/critic.js";
export type {
  CriticVerifier,
  CriticResult,
  CriticHistoryEntry,
} from "./loop/critic.js";
// NOTE: the in-SDK structured-output consumer of the CRITIC pattern is the
// @public `withStructuredOutput` (orchestration/ooda/structured-output.ts).
// A dedicated `correctStructuredOutput` wrapper was removed as a redundant
// duplicate (it reimplemented the same JSON.parse+Zod oracle loop). `criticLoop`
// stays as the general @alpha primitive for non-structured-output use cases.

// 45. Trajectory confidence tracker — EWMA-based session confidence (ACC, arXiv:2601.15778)
export { TrajectoryConfidenceTracker } from "./loop/trajectory-confidence.js";
export type {
  TrajectoryConfidenceConfig,
  TrajectoryConfidenceState,
} from "./loop/trajectory-confidence.js";

// 46. Promise/Progress signal — AgentPRM goal-proximity tracker (arXiv:2511.08325)
// EmbedFn already exported via semantic-coherence.js (section 4 above).
export { PromiseProgressTracker } from "./budget/promise-progress.js";
export type {
  PromiseProgressConfig,
  PromiseProgressSnapshot,
} from "./budget/promise-progress.js";

// 48. BrainRecallPort — agentic RAG recall module (ADR-ECO-065, sprint-805).
//     RecallChunk is distinct from the domain BrainChunk (orchestration/ooda/brain-context.ts).
//     RecallChunk mirrors the Brain HTTP SearchResult DTO; domain BrainChunk has entry_id.
export type {
  RecallChunk,
  BrainRecallPort,
  FreshnessMarker,
  RecallOptions,
  RecallResult,
  BrainRecallConfig,
} from "./recall/index.js";
export {
  brainRecall,
  brainRecallImpl,
  createBrainRecallImpl,
  selectTier,
  parseRecallChunk,
  parseBrainChunk,
  parseFreshnessMarker,
  parseRecallOptions,
  parseRecallResult,
  renderMemoryContext,
  assertCacheSafe,
  CacheSafetyViolationError,
} from "./recall/index.js";

// 47. PayPort — chain-agnostic payment abstraction (POC: Starknet Sepolia STRK).
//     Per ADR-ECO-031 (VPSF Chain-Agnostic Invariant) the port is open over
//     `network` + `token` strings ; adapters narrow the accepted set.
//     Self-hosted RPC (vauban-infrastructure) ; no SaaS RPC.
export type { PayPort, PayRequest, PayResult } from "./pay/port.js";
export {
  StarknetSepoliaPayAdapter,
  DEFAULT_SEPOLIA_RPC_URL,
  STRK_SEPOLIA_CONTRACT,
  SEPOLIA_EXPLORER_BASE,
  classifyReceipt,
  readBlockNumber,
} from "./pay/starknet-adapter.js";
export type { StarknetSepoliaPayAdapterOptions } from "./pay/starknet-adapter.js";

// 47b. PaymentAuthorizationPolicy v1 — deterministic pre-payment authorization
//      (the Veridex-shaped front half of the payment-receipt-chain): a policy
//      decides from facts alone whether a payment may move, and yields a JCS
//      canonical commitment (same grammar as the Run Certificate pipeline).
export {
  evaluatePaymentAuthorization,
  computePaymentAuthorizationCommitment,
} from "./pay/authorization-policy.js";
export type {
  PaymentPolicy,
  PaymentFacts,
  PaymentPurpose,
  PaymentAuthorizationVerdict,
  PolicyCheckName,
  PolicyCheckResult,
} from "./pay/authorization-policy.js";

// ─── provable-planner primitive (ADR-ECO-092) ────────────────────────────────
// Reusable provable WM-planner: a deterministic policy + decideProvably yields a
// re-executable, A3-gradable decision (the 4 governed-primitive properties of
// ADR-ECO-068). Canonical import path for the full surface (incl. the DecisionClaim
// type, whose name is already taken at top level by ./ports): the subpath
// "@vauban-org/agent-sdk/provable-planner".
export {
  GovernanceError,
  decisionAnchorPreimage,
  verifyDecisionReexecution,
  gradeDecision,
  emitAuditStep,
  assertReplay,
  decideProvably,
  provableActionGate,
} from "./provable-planner/index.js";
export type {
  DeterministicPolicy,
  DecisionGrade,
  ReexecVerdict,
  AuditStep,
  GovernedDecision,
} from "./provable-planner/index.js";
// NB: GateDecisionCore is intentionally NOT re-exported at top level (name already taken);
// import it from the subpath "@vauban-org/agent-sdk/provable-planner".

// ─── rigor-score (wave-2 MOVE#9) ──────────────────────────────────────────────
// RigorBench-inspired (arXiv:2606.22678) process-discipline scoring, deterministic
// and zero-LLM. Scores 3 of RigorBench's published 5 pillars (Verification Coverage,
// Recovery Efficiency, Atomic Transition Integrity) from a turn's own already-observed
// tool calls ; Planning Fidelity and Abstention Quality are deliberately NOT scored (no
// honest proxy in a plain CLI turn). Canonical import path for the full surface:
// "@vauban-org/agent-sdk/rigor-score".
export {
  RIGOR_PILLAR_WEIGHTS,
  RIGORBENCH_PILLARS_SCORED,
  RIGORBENCH_PILLARS_TOTAL,
  atomicTransitionIntegrity,
  recoveryEfficiency,
  scoreRigor,
  verificationCoverage,
} from "./rigor-score/index.js";
export type {
  PillarScores,
  RigorScoreInput,
  RigorScoreResult,
  RigorWeights,
  ScoredToolCall,
} from "./rigor-score/index.js";

// ─── Proactive Cognition Engine (uplift wave 2, sub-project 1) ────────────────
// Governed idle-time proactive cognition: domain types + the injected ports
// (gate/trigger/recall/queue) + the deterministic governed AttentionGate. The
// SDK holds the CONTRACTS + the pure gate logic (zero infra) ; preste supplies
// the SQLite queue / Brain recall / gateway delivery. foldAttentionStep folds
// the gate's audit step through runVerifierBattery (ADR-ECO-068) into a
// structural TraceStepSink the preste TraceAccumulator satisfies by shape.
export type {
  ProactiveCandidate,
  AttentionClass,
  AttentionVerdict,
  CriticalRule,
} from "./proactive/types.js";
export type {
  AttentionGate,
  ProactiveTriggerPort,
  AssociativeRecallPort,
  RecalledPrior,
  ProactiveQueuePort,
} from "./proactive/ports.js";
export {
  createAttentionGate,
  foldAttentionStep,
  type AttentionGateOptions,
  type TraceStepSink,
} from "./proactive/attention-gate.js";
