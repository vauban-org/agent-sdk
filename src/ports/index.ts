/**
 * Ports — host-injected dependency interfaces consumed by agent plugins.
 *
 * The contract: agent packages depend ONLY on @vauban-org/agent-sdk and
 * never on the host application. Host concrete wiring happens at boot
 * via each agent's setXxxDeps() setter.
 */
export type { LoggerPort } from "./logger.js";
export { noopLogger, LoggerFlushError } from "./logger.js";

export type {
  BrainPort,
  BrainEntry,
  BrainEntryInput,
  BrainQueryFilters,
  PostmortemInput,
  LessonInput,
  WorkingMemoryPort,
  WorkingMemorySlot,
  WorkingMemorySetOptions,
  EpisodicMemoryPort,
  EpisodicMemoryEntry,
  EpisodicEvent,
  EpisodicAppendOptions,
  EpisodicQueryFilter,
  SemanticMemoryPort,
  ProceduralMemoryPort,
  ProceduralSkill,
  ClaimPort,
  Claim,
  ClaimSource,
  ClaimStatus,
  ClaimAssertOptions,
  ClaimQueryFilter,
  MemoryScope,
} from "./brain.js";
export {
  InMemoryWorkingMemory,
  InMemoryEpisodicMemory,
  InMemorySemanticMemory,
  InMemoryProceduralMemory,
  InMemoryClaimPort,
  BrainUnavailableError,
  BrainRateLimitError,
  MemoryValidationError,
} from "./brain.js";

export type { OutcomePort, AgentRunRef } from "./outcome.js";
export { OutcomeWriteError } from "./outcome.js";

export type { CloudEvent, EventBusPort } from "./event-bus.js";
export { EventPublishError } from "./event-bus.js";

export type { DbPort, DbClient } from "./db.js";
export { DbConnectionLostError, DbQueryTimeoutError } from "./db.js";

export type { AgentDescriptor, AgentRegistryPort } from "./agent-registry.js";

export type { MessagingChannelPort, AlertLevel } from "./messaging.js";
export { InvalidTargetError } from "./messaging.js";

export type {
  LLMProviderPort,
  ChatRequest,
  ChatMessage,
  ChatUsage,
  ChatResponse,
  StreamDelta,
  MessageAttachment,
  ImageAttachment,
} from "./llm-provider.js";
export { LLMProviderError, LLMRateLimitError } from "./llm-provider.js";

export type { PricePort, PriceEntry } from "./price.js";

export type {
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
} from "./compliance-contract.js";
export {
  CompliancePolicyError,
  ComplianceEvaluationTimeoutError,
  SUPPORTED_JURISDICTIONS_V0,
} from "./compliance-contract.js";

export type {
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
} from "./workflow-runtime.js";
export {
  WorkflowNotFoundError,
  WorkflowNonDeterminismError,
  WorkflowSignalTimeoutError,
  WorkflowLeaseConflictError,
  WorkflowVersionMismatchError,
} from "./workflow-runtime.js";

// ─── Sprint-636 V2.1 — 9 new ports (manifest, tenant, federation, delegation, products, observability, privacy)

export type * from "./manifest-registry.js";
export {
  ManifestNotFoundError,
  ManifestSignatureInvalidError,
  ManifestVersionConflictError,
  ManifestComplianceConflictError,
  ManifestValidationError,
} from "./manifest-registry.js";

export type * from "./tenant-context.js";
export {
  TenantNotFoundError,
  DegradedModeExhaustedError,
  InvalidGlacisAttestationError,
} from "./tenant-context.js";

export type {
  FederationPort,
  FederationMessage,
  FederationMessageHeader,
  AgentRef,
  ContentClaim,
  TransportMeta,
  MessageId,
  ReceiveOpts,
  VerifyResult as FederationVerifyResult,
} from "./federation.js";
export {
  FederationSignatureInvalidError,
  FederationRoutingError,
  FederationDelegationChainError,
} from "./federation.js";

export type {
  DelegationPort,
  DelegationClaim,
  CapabilityScope,
  RootCapability,
  VerifyChainResult,
} from "./delegation.js";
export {
  DelegationNotNarrowingError,
  DelegationExpiredError,
  DelegationRevokedError,
  DelegationChainTooDeepError,
} from "./delegation.js";

export type {
  BastionActionPort,
  SwapParams,
  SwapResult,
  DepositParams,
  DepositResult,
  WithdrawParams,
  WithdrawResult,
  TransferParams,
  TransferResult,
  PolicyValidation,
  ClientPolicy,
  TokenAddress,
  VaultAddress,
  TenantId as BastionTenantId,
  ActionContext as BastionActionContext,
} from "./bastion-action.js";
export {
  BastionPolicyViolationError,
  BastionInsufficientFundsError,
  BastionSlippageExceededError,
  BastionContractError,
  BastionTransferUnauthorizedError,
} from "./bastion-action.js";

export type {
  VFinanceActionPort,
  MarketSignal,
  SolvencyClaim,
  TradeRecord,
  TradeClaim,
  StrategyRunInput,
  StrategyRunClaim,
  PortfolioId,
  ProofGrade,
  ActionContext as VFActionContext,
} from "./vauban-finance-action.js";
export {
  VFOracleQuorumError,
  VFProofGradeMismatchError,
  VFAnchoringForbiddenError,
  VFProofGenerationError,
} from "./vauban-finance-action.js";

export type {
  CitadelActionPort,
  AgentTier,
  SprintInput,
  SprintRef,
  TaskRef,
  TaskStatus,
  VerificationEvidence,
  SealedSprintClaim,
  DecisionInput,
  DecisionClaim,
  ActionContext as CitadelActionContext,
} from "./citadel-action.js";
export {
  CitadelTierViolationError,
  CitadelTaskRefNotFoundError,
  CitadelSprintNotActiveError,
  CitadelInvalidStateTransitionError,
} from "./citadel-action.js";

export type * from "./observability.js";
export { NoopObservabilityPort } from "./observability.js";

export type {
  RevelationMask,
  ZkProofInput,
  VerifyResult as PrivacyVerifyResult,
  Commitment,
  SmtResult,
  PrivacyContext,
  PrivacyPort,
} from "./privacy.js";
export { NoopPrivacyAdapter, PrivacyNoopWarning } from "./privacy.js";
