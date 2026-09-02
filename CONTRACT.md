# @vauban-org/agent-sdk — Public API Contract

**Version:** 0.8.2 | **Status:** public-experimental | **Generated:** 2026-09-01

> Vauban agent primitives: loop, budget, routing, HITL, permissions, tracking, durable execution

> Breaking changes (removed exports, changed signatures, narrowed types) require a **major** semver bump
> and must be gated by `api-extractor run` baseline diff in CI (see `.github/workflows/api-contract.yml`).

> This file is auto-generated from `etc/<pkg>.api.md`. Do not edit manually.
> Regenerate with: `tsx scripts/regen-contract.ts agent-sdk`

---

## Exported Surface

### `ABConfig`

```typescript
export interface ABConfig {
    maxCandidates: number;
    rollbackThresholdPct: number;
    trafficPct: number;
}
```

### `ABSlot`

```typescript
export interface ABSlot {
    candidateId: string;
    outcomes: number[];
    rollbackTriggered: boolean;
    trafficFraction: number;
}
```

### `ActionCompletion`

```typescript
export interface ActionCompletion {
    readonly action_id: string;
    readonly error?: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
    readonly outcome: "success" | "failure" | "skipped";
    readonly worker_agent_id: string;
}
```

### `ActionFilter`

```typescript
export interface ActionFilter {
    readonly action_type?: CampaignActionType;
    readonly campaign_slug?: string;
    readonly due_before?: string;
    readonly limit?: number;
    readonly offset?: number;
    readonly scheduled_before?: Date | string;
    readonly status?: CampaignActionStatus;
}
```

### `ActionGate`

```typescript
export interface ActionGate {
    verify(call: ActionGateCall): Promise<ActionGateVerdict> | ActionGateVerdict;
}
```

### `ActionGateCall`

```typescript
export interface ActionGateCall {
    readonly args: unknown;
    readonly budgetUsed: number;
    readonly toolName: string;
}
```

### `ActionGateVerdict`

```typescript
export interface ActionGateVerdict {
    readonly allowed: boolean;
    readonly auditStep?: unknown;
    readonly kind?: string;
    readonly reason: string;
}
```

### `AdaptiveBestOfNPolicy`

```typescript
export interface AdaptiveBestOfNPolicy {
    readonly earlyAcceptThreshold?: number;
    readonly initialBatch?: number;
}
```

### `addIdempotencyHeader`

```typescript
export function addIdempotencyHeader(headers: Record<string, string>, key: string): Record<string, string>;
```

### `AdoptionRecord`

```typescript
export interface AdoptionRecord {
    candidateId: string;
    deprecatedAt: Date | null;
    evalResult: EvalResult;
    promotedAt: Date | null;
    reason: string;
    signOff: SignOffRecord | null;
    status: AdoptionStatus;
}
```

### `AdoptionStatus`

```typescript
export type AdoptionStatus = "promoted" | "rejected" | "deprecated" | "pending_signoff" | "insufficient_signal";

// Warning: (ae-missing-release-tag) "ADVERSARY_ANGLES" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ADVERSARY_ANGLES`

```typescript
export const ADVERSARY_ANGLES: readonly string[];

// Warning: (ae-missing-release-tag) "AdversaryConfigInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AdversaryConfigInput`

```typescript
export interface AdversaryConfigInput {
    readonly intensity: AdversaryIntensity;
    readonly lenses?: number;
}

// Warning: (ae-missing-release-tag) "AdversaryIntensity" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AdversaryIntensity`

```typescript
export type AdversaryIntensity = "none" | "judge" | "refute-quorum";

// Warning: (ae-missing-release-tag) "AdvisoryClaim" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AdvisoryClaim`

```typescript
export interface AdvisoryClaim<T> {
    readonly kind: "advisory";
    readonly provenance: AdvisoryProvenance;
    readonly value: T;
}

// Warning: (ae-missing-release-tag) "advisoryClaim" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `advisoryClaim`

```typescript
export function advisoryClaim<T>(value: T, provenance: AdvisoryProvenance): AdvisoryClaim<T>;

// Warning: (ae-missing-release-tag) "AdvisoryProvenance" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AdvisoryProvenance`

```typescript
export interface AdvisoryProvenance {
    readonly confidence: number;
    readonly model?: string;
    readonly source: string;
    readonly version?: string;
}
```

### `Agent`

```typescript
export class Agent {
    constructor(cfg: AgentConfig);
    run(task: string): Promise<AgentRunResult>;
    get strategyKind(): AgentStrategyName;
}
```

### `AGENT_ID_NAMESPACE`

```typescript
export const AGENT_ID_NAMESPACE = "a6f9c2e4-8b5d-4e3f-a1c7-9d2b6e8f1a3c";
```

### `AGENT_IDS`

```typescript
export const AGENT_IDS: Readonly<Record<AgentType, string>>;
```

### `AGENT_KINDS`

```typescript
export const AGENT_KINDS: readonly ["ARCHITECT", "BUILDER", "SCRIBE", "TESTER", "SYNERGY", "OODA", "LLM_ROUTER", "PLUGIN", "MCP"];
```

### `AgentAction`

```typescript
export interface AgentAction {
    readonly escalationLevel: EscalationLevel;
    readonly estimatedCostCents?: number;
    readonly payload: Record<string, unknown>;
    readonly reversible: boolean;
    readonly type: string;
}
```

### `AgentBootContext`

```typescript
export interface AgentBootContext {
    domainContext: Array<{
        content: string;
        created_at?: string;
    }>;
    projectMdContent: string | null;
    recentDecisions: Array<{
        content: string;
        created_at?: string;
    }>;
}
```

### `AgentBudgetState`

```typescript
export interface AgentBudgetState {
    coherenceScore: number;
    compactionTrigger: number;
    contextWindow: {
        maxTokens: number;
        currentTokens: number;
    };
    maxSteps: number;
    stepCount: number;
    tokensBudget: {
        input: number;
        output: number;
        usedInput: number;
        usedOutput: number;
    };
}
```

### `AgentCapabilityCard`

```typescript
export interface AgentCapabilityCard {
    agentId: string;
    costTier: CostTier;
    createdAt: number;
    embeddingVector?: readonly number[];
    kind: AgentKind;
    latencyTier: LatencyTier;
    skills: readonly string[];
}
```

### `AgentConfig`

```typescript
export interface AgentConfig {
    readonly agentId: string;
    readonly agentVersion?: string;
    readonly allowedTools?: readonly string[];
    readonly hooks?: AgentHooks;
    readonly llm?: LLMProviderPort;
    readonly llmFn?: StrategyLLMCompletionFn;
    readonly logger?: LoggerPort;
    readonly maxSteps?: number;
    readonly onOutputDenied?: (event: {
        runId: string;
        reason: string;
        auditStep?: unknown;
    }) => void;
    readonly oodaInvoker?: OODACycleInvoker;
    readonly outcomeMapping?: (result: AgentCycleResult) => OutcomeRecord | null;
    readonly outputGate?: ActionGate;
    readonly signal?: AbortSignal;
    readonly skillCapture?: SkillCaptureOptions;
    readonly strategy?: AgentStrategyName | AgentStrategy;
    readonly systemPrompt: string;
    readonly tools: ToolRegistry;
}
```

### `AgentConfigLoader`

```typescript
export interface AgentConfigLoader<T = Record<string, unknown>> {
    get(agentId: string): Promise<T>;
    invalidate(agentId: string): void;
}
```

### `AgentContext`

```typescript
export interface AgentContext {
    runId: string;
    traceId?: string;
}
```

### `agentControlledPolicy`

```typescript
export function agentControlledPolicy(priorities: ReadonlyMap<string, number>): EvictionPolicy;
```

### `AgentCycleResult`

```typescript
export interface AgentCycleResult {
    readonly finalMessage: string;
    readonly model?: string;
    readonly outcome?: OutcomeRecord;
    readonly provider?: string;
    readonly stepCount: number;
    readonly stepsTrace?: readonly unknown[];
    readonly stopReason: "complete" | "max_steps" | "error" | "user_cancelled" | "skipped" | "blocked";
    readonly tokensUsed: {
        in: number;
        out: number;
    };
}
```

### `AgentDependencies`

```typescript
export interface AgentDependencies {
    readonly brain: BrainPort;
    readonly databaseUrl?: string;
    readonly db: DbClient;
    readonly eventBus?: EventBusPort;
    readonly executionMode: ExecutionMode;
    readonly litellmUrl?: string;
    readonly logger: LoggerPort;
    readonly redis: unknown;
    readonly skills: SkillRegistry;
}
```

### `AgentDescriptor`

```typescript
export interface AgentDescriptor {
    budget_monthly_usd: number;
    description: string;
    featureFlag?: string;
    handler: AgentHandler;
    id: string;
    loop: "minimal" | "sdk";
    schedule?: string;
    version: string;
}
```

### `AgentExecuteInput`

```typescript
export interface AgentExecuteInput {
    agentId: string;
    archiveToBrain?: boolean;
    description: string;
    taskType: string;
}
```

### `AgentExecuteResult`

```typescript
export interface AgentExecuteResult {
    runId: string;
    runUrl: string;
    status: string;
}
```

### `AgentFactoryConfig`

```typescript
export interface AgentFactoryConfig<TConfig = unknown, TObs = unknown, TOrient = unknown, TDecision = unknown, TAction = unknown, TFeedback = unknown> {
    agentId: string;
    agentVersion: string;
    defaults?: TConfig;
    hitlEscalationLevel?: "L1" | "L2" | "L3";
    intervalMs: number;
    outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
    phases: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>["phases"];
    registryDescriptor?: Omit<AgentRegistryDescriptor, "id"> & {
        product: string;
    };
    riskGuards?: RiskGuard[];
    sessionGuards?: SessionGuard[];
}
```

### `AgentFactoryDeps`

```typescript
export interface AgentFactoryDeps extends AgentDependencies {
    readonly messaging?: MessagingChannelPort;
    readonly registry?: AgentRegistryPort;
}
```

### `agentFromId`

```typescript
export function agentFromId(id: string): AgentType | undefined;
```

### `AgentHandler`

```typescript
export type AgentHandler = (ctx: AgentContext, input: string) => Promise<AgentResult>;
```

### `AgentHandoffClient`

```typescript
export interface AgentHandoffClient {
    execute(agentId: string, input: {
        messages: Array<{
            role: string;
            content: string;
        }>;
        handoffChain: string[];
    }): Promise<{
        runId: string;
    }>;
}
```

### `AgentHealth`

```typescript
export interface AgentHealth {
    agent_id: string;
    error_rate: number;
    last_run_at: string | null;
    last_status: string | null;
    p50_latency_ms: number;
    p99_latency_ms: number;
    run_count: number;
    uptime_pct: number;
    window: "24h" | "7d" | "30d";
}
```

### `AgentHooks`

```typescript
export interface AgentHooks {
    readonly onPhaseComplete?: (phase: string, output: unknown) => void;
    readonly onStep?: (event: StrategyStepEvent) => void | Promise<void>;
}
```

### `AgentKind`

```typescript
export type AgentKind = (typeof AGENT_KINDS)[number];
```

### `AgentLoop`

```typescript
export class AgentLoop {
    // Warning: (ae-forgotten-export) The symbol "AgentLoopConfig" needs to be exported by the entry point index.d.ts
    constructor(config: AgentLoopConfig);
    run(userMessage: string, opts?: {
        displayTask?: string;
        origin?: "local" | "remote";
        steerId?: string;
    }): Promise<AgentLoopRunResult>;
}
```

### `AgentLoopRunResult`

```typescript
export interface AgentLoopRunResult {
    budgetFinal: AgentBudgetState;
    costUsd?: number;
    errorMessage?: string;
    finalMessage: string;
    loopDetail?: {
        toolName: string;
        hash: string;
        firstStep: number;
        repeatStep: number;
        reason?: "max_steps" | "max_time" | "max_cost" | "hash_collision" | "progress_plateau";
    };
    stopReason: "complete" | "budget_exhausted" | "incoherent" | "loop_definitive" | "tool_denied" | "user_cancelled" | "approval_denied" | "approval_timeout" | "error" | "aborted";
    traceId: string;
}
```

### `AgentMeter`

```typescript
export class AgentMeter {
    export(): MeterEntry[];
    getBalance(agentId: string, since?: number): MeterBalance;
    import(entries: MeterEntry[]): void;
    recordRun(runId: string, agentId: string, valueCents: number): MeterEntry;
    verifyChain(agentId?: string, since?: number): MeterVerifyResult;
}
```

### `AgentMetrics`

```typescript
export interface AgentMetrics {
    cycleCompleted: Counter<"agent_id" | "outcome">;
    // Warning: (ae-forgotten-export) The symbol "Histogram" needs to be exported by the entry point index.d.ts
    cycleDuration: Histogram<"agent_id" | "phase">;
    // Warning: (ae-forgotten-export) The symbol "Counter" needs to be exported by the entry point index.d.ts
    cycleStarted: Counter<"agent_id">;
    hitlRequested: Counter<"agent_id">;
    hitlResolved: Counter<"agent_id" | "decision">;
    llmCallCount: Counter<"agent_id" | "provider">;
    llmCostUsd: Counter<"agent_id" | "provider">;
    llmTokensUsed: Counter<"agent_id" | "provider" | "direction">;
}
```

### `AgentPersona`

```typescript
export type AgentPersona = z.infer<typeof PersonaSchema>;
```

### `AgentRef`

```typescript
export interface AgentRef {
    readonly agent_card_url?: string;
    readonly agent_id: string;
    readonly tenant_id: string;
}
```

### `AgentRegistry`

```typescript
export class AgentRegistry {
    discover(workspaceRoot: string): Promise<AgentDescriptor[]>;
    discoverByKind(kind: AgentKind): AgentCapabilityCard[];
    discoverBySkills(skills: readonly string[], opts?: {
        kind?: AgentKind;
        matchAll?: boolean;
    }): AgentCapabilityCard[];
    get(id: string): AgentDescriptor | undefined;
    list(): AgentDescriptor[];
    register(desc: AgentDescriptor): void;
    registerCapability(card: AgentCapabilityCard): void;
    get size(): number;
    unregister(id: string): boolean;
}
```

### `agentRegistry`

```typescript
export const agentRegistry: AgentRegistry;
```

### `AgentRegistryDescriptor`

```typescript
export interface AgentRegistryDescriptor {
    capabilities: string[];
    id: string;
    inputSchema: object;
    llmRequirements?: {
        minContextWindow?: number;
        toolUse?: boolean;
    };
    product: string;
    tenantId?: string;
    trigger: "event" | "cron" | "hitl" | "webhook";
}
```

### `AgentRegistryEntry`

```typescript
export interface AgentRegistryEntry {
    agentId: string;
    status: string;
    type: string;
}
```

### `AgentRegistryPort`

```typescript
export interface AgentRegistryPort {
    list(filter?: Partial<AgentRegistryDescriptor>): Promise<AgentRegistryDescriptor[]>;
    register(descriptor: AgentRegistryDescriptor): Promise<void>;
    resolve(capability: string, opts?: {
        tenantId?: string;
    }): Promise<AgentRegistryDescriptor[]>;
    unregister(id: string): Promise<void>;
}
```

### `AgentResult`

```typescript
export interface AgentResult {
    inputTokens: number;
    output: string;
    outputTokens: number;
    stopReason: "complete" | "budget_exhausted" | "error" | string;
}
```

### `AgentRunDeclaration`

```typescript
export interface AgentRunDeclaration {
    readonly approved_by: string;
    readonly extends_session?: string | boolean;
    readonly intention: string;
    readonly max_iterations: number;
    readonly max_iterations_justification?: string;
    readonly model: string;
    readonly rollback_plan?: string;
    readonly session_id: string;
    readonly started_at?: string;
    readonly tier: string;
    readonly token_budget_max: number;
    readonly tools_required?: readonly string[];
}
```

### `AgentRunFinalStatus`

```typescript
export type AgentRunFinalStatus = "success" | "failed" | "timeout" | "incoherent";
```

### `AgentRunFinish`

```typescript
export interface AgentRunFinish {
    errorMessage?: string;
    status: AgentRunFinalStatus;
    stopReason?: string;
}
```

### `AgentRunRef`

```typescript
export interface AgentRunRef {
    agent_id: string;
    id: string;
    outcome_id?: string | null;
    run_id?: string;
}
```

### `AgentRunResult`

```typescript
export interface AgentRunResult {
    readonly agentId: string;
    readonly durationMs: number;
    readonly finalMessage: string;
    readonly model?: string;
    readonly outcome?: OutcomeRecord;
    readonly provider?: string;
    readonly runId: string;
    readonly skillCaptured?: boolean;
    readonly stepCount: number;
    readonly stepsTrace?: readonly unknown[];
    readonly stopReason: AgentCycleResult["stopReason"];
    readonly strategy: AgentStrategyName;
    readonly tokensUsed: {
        in: number;
        out: number;
    };
}
```

### `AgentRunStartInput`

```typescript
export interface AgentRunStartInput {
    agentId: string;
    agentVersion: string;
    model: string;
    provider: string;
    runId: string;
    tenantId?: string;
    traceId?: string;
}
```

### `AgentRunStepDelta`

```typescript
export interface AgentRunStepDelta {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls?: number;
}
```

### `AgentRunTracker`

```typescript
export interface AgentRunTracker {
    finish(uuid: string, result: AgentRunFinish): Promise<void>;
    recordStep(uuid: string, delta: AgentRunStepDelta): Promise<void>;
    start(input: AgentRunStartInput): Promise<string>;
}
```

### `AgentsClient`

```typescript
export interface AgentsClient {
    execute(input: AgentExecuteInput): Promise<AgentExecuteResult>;
    listRegistry(): Promise<{
        agents: AgentRegistryEntry[];
    }>;
}
```

### `AgentsClientOptions`

```typescript
export interface AgentsClientOptions {
    baseUrl: string;
    getToken: () => Promise<string>;
}
```

### `agentSpan`

```typescript
export function agentSpan(tracer: Tracer, opts: {
    agentId: string;
    agentVersion: string;
    runId: string;
}): Span;
```

### `AgentStrategy`

```typescript
export interface AgentStrategy {
    readonly name: AgentStrategyName;
    run(ctx: StrategyAgentContext): Promise<AgentCycleResult>;
}
```

### `AgentStrategyName`

```typescript
export type AgentStrategyName = "ooda" | "react" | "plan" | "one-shot";
```

### `AgentTier`

```typescript
export type AgentTier = "T1" | "T2" | "T3" | "T4";
```

### `AgentTool`

```typescript
export interface AgentTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
    readonly capability?: SdkCapability;
    readonly dangerous?: boolean;
    readonly description: string;
    readonly execute: (params: z.infer<TParams>) => Promise<unknown>;
    readonly mcpScopes?: readonly string[];
    readonly name: string;
    readonly parameters: TParams;
    readonly risk?: RiskVector;
}
```

### `AgentType`

```typescript
export type AgentType = "ARCHITECT" | "BUILDER" | "TESTER" | "SCRIBE" | "SYNERGY";
```

### `AlertDigestOptions`

```typescript
export interface AlertDigestOptions {
    readonly detailsPointer?: string;
    readonly emojiMap?: Readonly<Record<string, string>>;
    readonly label?: string;
    readonly maxChars?: number;
    readonly severityOrder?: readonly string[];
    readonly threshold?: number;
}
```

### `AlertItem`

```typescript
export interface AlertItem {
    readonly component?: string;
    readonly ref?: string;
    readonly remediation?: string;
    readonly severity: "critical" | "high" | "medium" | "low" | (string & Record<never, never>);
    readonly title: string;
    readonly url?: string;
}
```

### `AlertLevel`

```typescript
export type AlertLevel = "info" | "warn" | "error" | "critical";
```

### `ALL_KNOWN_EVENT_TYPES`

```typescript
export const ALL_KNOWN_EVENT_TYPES: ReadonlySet<string>;
```

### `ALL_LINK_STATUSES`

```typescript
export const ALL_LINK_STATUSES: readonly LinkStatus[];
```

### `ALL_SESSION_ORIGIN_KINDS`

```typescript
export const ALL_SESSION_ORIGIN_KINDS: readonly SessionOriginKind[];
```

### `AllAdaptersFailedError`

```typescript
export class AllAdaptersFailedError extends AggregateError {
    constructor(errors: Error[], message?: string);
}
```

### `ALLOW_ALL_GATE`

```typescript
export const ALLOW_ALL_GATE: CapabilityGate;

// Warning: (ae-forgotten-export) The symbol "AlpacaQuoteInput" needs to be exported by the entry point index.d.ts
//
```

### `alpacaQuote`

```typescript
export const alpacaQuote: Skill<AlpacaQuoteInput, AlpacaQuoteOutput>;
```

### `AlpacaQuoteOutput`

```typescript
export interface AlpacaQuoteOutput {
    ask: number;
    bid: number;
    mode: "paper" | "live" | "replay";
    symbol: string;
    timestamp: string;
}
```

### `alwaysOn`

```typescript
export function alwaysOn(): SessionGuard;

// Warning: (ae-missing-release-tag) "ANCHOR_CHECKS" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ANCHOR_CHECKS`

```typescript
export const ANCHOR_CHECKS: Readonly<Record<string, AnchorCheck>>;

// Warning: (ae-missing-release-tag) "AnchorCheck" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AnchorCheck`

```typescript
export type AnchorCheck = (artifact: string) => {
    pass: boolean;
    rationale: string;
};

// Warning: (ae-missing-release-tag) "AnchorSpecInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AnchorSpecInput`

```typescript
export interface AnchorSpecInput {
    readonly id: string;
    readonly kind: "pure" | "ci";
}
```

### `Anomaly`

```typescript
export interface Anomaly {
    agent_id: string;
    baseline_mean: number;
    baseline_stddev: number;
    cost_dimension: string;
    detected_at: string;
    observed: number;
    run_id: string | null;
    severity: "low" | "medium" | "high";
    z_score: number;
}
```

### `AnthropicContentBlock`

```typescript
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock;
```

### `AnthropicDirectAdapter`

```typescript
export class AnthropicDirectAdapter implements LLMProviderPort {
    constructor(config: AnthropicDirectAdapterConfig);
    complete(req: ChatRequest): Promise<ChatResponse>;
    estimateCost(req: ChatRequest): {
        usd: number;
    };
    stream(req: ChatRequest): AsyncIterable<StreamDelta>;
}
```

### `AnthropicDirectAdapterConfig`

```typescript
export interface AnthropicDirectAdapterConfig {
    apiKey: string;
    _clientOverride?: Anthropic;
    defaultModel?: string;
}
```

### `AnthropicDocumentBlock`

```typescript
export interface AnthropicDocumentBlock {
    source: {
        type: "url";
        url: string;
    };
    type: "document";
}
```

### `AnthropicImageBlock`

```typescript
export interface AnthropicImageBlock {
    source: {
        type: "base64";
        media_type: ImageMediaType;
        data: string;
    };
    type: "image";
}
```

### `AnthropicTextBlock`

```typescript
export interface AnthropicTextBlock {
    text: string;
    type: "text";
}

// Warning: (ae-forgotten-export) The symbol "Axiom" needs to be exported by the entry point index.d.ts
//
```

### `ANTI_FRAGILE`

```typescript
export const ANTI_FRAGILE: Axiom;
```

### `antiFragileScorer`

```typescript
export const antiFragileScorer: ScoringFunction;
```

### `applyEnvMemory`

```typescript
export function applyEnvMemory<C extends {
    agentId: string;
    deps?: Partial<OODAAgentDeps>;
}>(config: C): C;
```

### `applyPolicy`

```typescript
export function applyPolicy(result: FormalVerifyResult, policy: AxiomPolicy, mode: ConsumerMode, context: VerifyContext): PolicyDecision;
```

### `Approval`

```typescript
export interface Approval {
    approved: boolean;
    at: string;
    by: string;
    rationale?: string;
    scope?: "session" | "always";
    timedOut?: boolean;
}
```

### `ApprovalCallback`

```typescript
export interface ApprovalCallback {
    approvalId: string;
    approved: boolean;
    chatId: string;
    platform: string;
    ts: string;
    userId: string;
}
```

### `ApprovalChannel`

```typescript
export interface ApprovalChannel {
    cancel(id: string): Promise<void>;
    poll(id: string): Promise<Approval | null>;
    send(req: ApprovalRequest): Promise<string>;
}
```

### `ApprovalPrompt`

```typescript
export interface ApprovalPrompt {
    action: string;
    context: string;
    id: string;
    text: string;
}
```

### `ApprovalRequest`

```typescript
export interface ApprovalRequest {
    action: string;
    agentId: string;
    context: string;
    risk?: ApprovalRisk;
    timeoutMs: number;
}
```

### `ApprovalRisk`

```typescript
export interface ApprovalRisk extends Pick<RiskVector, "reversibility" | "blastRadius" | "dataSensitivity" | "externalSideEffect"> {
    score: number;
}
```

### `ApprovalStatus`

```typescript
export type ApprovalStatus = "pending" | "resolved" | "cancelled" | "timedout";
```

### `ApprovalStore`

```typescript
export interface ApprovalStore {
    cancel(id: string): Promise<boolean>;
    create(entry: PendingApproval): Promise<void>;
    expireOverdue(now?: number): Promise<number>;
    get(id: string): Promise<PendingApproval | null>;
    resolve(id: string, verdict: Approval): Promise<boolean>;
}

// Warning: (ae-forgotten-export) The symbol "AgentDescriptor_2" needs to be exported by the entry point index.d.ts
//
```

### `asAgentTool`

```typescript
export function asAgentTool(descriptor: AgentDescriptor_2, client: AgentHandoffClient): Promise<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (input: {
        messages: Array<{
            role: string;
            content: string;
        }>;
        handoffChain?: string[];
    }) => Promise<{
        runId: string;
    }>;
}>;
```

### `assertCacheSafe`

```typescript
export function assertCacheSafe(prefixBefore: string, prefixAfter: string): void;
```

### `assertExecutionMode`

```typescript
export function assertExecutionMode(mode: unknown): asserts mode is ExecutionMode;

// Warning: (ae-missing-release-tag) "assertNotAdvisory" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `assertNotAdvisory`

```typescript
export function assertNotAdvisory(x: unknown, where: string): void;

// Warning: (ae-forgotten-export) The symbol "DecisionClaim_2" needs to be exported by the entry point index.d.ts
// Warning: (ae-missing-release-tag) "assertReplay" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `assertReplay`

```typescript
export function assertReplay<I, O>(claim: DecisionClaim_2<I, O>, policy: DeterministicPolicy<I, O>): O;
```

### `assertTarballMatchesIndex`

```typescript
export function assertTarballMatchesIndex(index: SignedSkillIndex, target: {
    skillId: string;
    version?: string;
    tarballSha256: string;
}, verify: VerifyFn, opts?: {
    now?: Date;
    expectedKeyId?: string;
}): SkillIndexEntry;
```

### `assertVerifierResult`

```typescript
export function assertVerifierResult(r: VerifierResult): void;
```

### `AssociativeRecallPort`

```typescript
export interface AssociativeRecallPort {
    related(subject: string, topK?: number): Promise<RecalledPrior[]>;
}
```

### `atomicTransitionIntegrity`

```typescript
export function atomicTransitionIntegrity(toolCalls: readonly ScoredToolCall[]): number;
```

### `AttachedSession`

```typescript
export interface AttachedSession {
    readonly announced: boolean;
    readonly kind: SessionOriginKind;
    readonly name?: string;
    readonly runId: string;
}
```

### `AttentionClass`

```typescript
export type AttentionClass = "push" | "digest" | "silent";
```

### `AttentionGate`

```typescript
export interface AttentionGate {
    classify(candidate: ProactiveCandidate): AttentionVerdict | Promise<AttentionVerdict>;
}
```

### `AttentionGateOptions`

```typescript
export interface AttentionGateOptions {
    readonly digestMinStrength: number;
    readonly rules: readonly CriticalRule[];
}
```

### `AttentionVerdict`

```typescript
export interface AttentionVerdict {
    readonly class: AttentionClass;
    readonly reason: string;
    readonly ruleId?: string;
}
```

### `AttenuatedToken`

```typescript
export interface AttenuatedToken {
    readonly budgetEur: number;
    readonly expiresAt?: string;
    readonly parentId: string;
    readonly scope: ReadonlyArray<string>;
}
```

### `attenuateScope`

```typescript
export function attenuateScope(parent: MeshCapabilityScope, requested: MeshCapabilityScope): MeshCapabilityScope;

// Warning: (ae-forgotten-export) The symbol "GrantCandidate" needs to be exported by the entry point index.d.ts
//
```

### `attenuationLens`

```typescript
export const attenuationLens: BatteryLens<GrantCandidate>;
```

### `AttestMemoryOptions`

```typescript
export interface AttestMemoryOptions {
    clock?: {
        now(): number;
    };
}
```

### `attestMemoryWrite`

```typescript
export function attestMemoryWrite(entry: MemoryContent, sign: SignFn, pubkeyHex: string, opts?: AttestMemoryOptions): MemoryAttestation;
```

### `AudioMediaType`

```typescript
export type AudioMediaType = "audio/ogg" | "audio/wav" | "audio/mp3" | "audio/mpeg" | "audio/webm";

// Warning: (ae-missing-release-tag) "AuditStep" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `AuditStep`

```typescript
export interface AuditStep {
    readonly adrEco: string;
    readonly outputHash: string;
    readonly phase: "guard";
    readonly policy: "hash-only";
    readonly type: "guard_check";
}
```

### `AXIOM_SPECS`

```typescript
export const AXIOM_SPECS: Record<string, AxiomSpec>;
```

### `AxiomId`

```typescript
export type AxiomId = "Institutionnel" | "SOTA" | "Robuste" | "AntiFragile" | "Profitable";
```

### `AxiomPolicy`

```typescript
export interface AxiomPolicy {
    onSafe: "proceed";
    onUnknown: OnUnknown;
    onUnsafe: OnUnsafe;
    skillLoopStrict: boolean;
    timeout_ms: number;
}
```

### `AxiomScoreEntry`

```typescript
export interface AxiomScoreEntry {
    axiomId: AxiomId;
    rationale: string;
    score: number;
}
```

### `AxiomSpec`

```typescript
export interface AxiomSpec {
    axiom: string;
    postconditions: Condition[];
    preconditions: Condition[];
    timeout_ms?: number;
}
```

### `BASE_SKILL_NAMES`

```typescript
export const BASE_SKILL_NAMES: readonly ["brain-query", "brain-store", "slack-notify", "llm-complete"];
```

### `BaseSkillName`

```typescript
export type BaseSkillName = (typeof BASE_SKILL_NAMES)[number];
```

### `baseToolName`

```typescript
export function baseToolName(name: string): string;
```

### `BashMode`

```typescript
export type BashMode = false | "restricted";
```

### `BastionActionContext`

```typescript
export interface BastionActionContext {
    readonly jurisdictionsContext?: string[];
    readonly legalBasis?: string;
    readonly manifestHash: string;
    readonly runId: string;
    readonly tenantId: BastionTenantId;
}
```

### `BastionActionPort`

```typescript
export interface BastionActionPort {
    deposit(params: DepositParams, ctx: BastionActionContext): Promise<DepositResult>;
    swap(params: SwapParams, ctx: BastionActionContext): Promise<SwapResult>;
    transfer(params: TransferParams, ctx: BastionActionContext): Promise<TransferResult>;
    validateAgainstClientPolicies(action: "swap" | "deposit" | "withdraw" | "transfer", tenantId: BastionTenantId, params?: Partial<SwapParams & DepositParams>): Promise<PolicyValidation>;
    withdraw(params: WithdrawParams, ctx: BastionActionContext): Promise<WithdrawResult>;
}
```

### `BastionContractError`

```typescript
export class BastionContractError extends Error {
    constructor(contract_call: string, contract_error: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly contract_call: string;
    readonly contract_error: string;
}
```

### `BastionInsufficientFundsError`

```typescript
export class BastionInsufficientFundsError extends Error {
    constructor(required: string, available: string, cause?: unknown | undefined);
    readonly available: string;
    readonly cause?: unknown | undefined;
    readonly required: string;
}
```

### `BastionPolicyViolationError`

```typescript
export class BastionPolicyViolationError extends Error {
    constructor(message: string, action: string, tenantId: BastionTenantId, cause?: unknown | undefined);
    readonly action: string;
    readonly cause?: unknown | undefined;
    readonly tenantId: BastionTenantId;
}
```

### `BastionSlippageExceededError`

```typescript
export class BastionSlippageExceededError extends Error {
    constructor(max_slippage_bps: number, actual_slippage_bps: number, cause?: unknown | undefined);
    readonly actual_slippage_bps: number;
    readonly cause?: unknown | undefined;
    readonly max_slippage_bps: number;
}
```

### `BastionTenantId`

```typescript
export type BastionTenantId = string;
```

### `BastionTransferUnauthorizedError`

```typescript
export class BastionTransferUnauthorizedError extends Error {
    constructor(message: string, reason: "missing_legal_basis" | "jurisdiction_blocked", cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly reason: "missing_legal_basis" | "jurisdiction_blocked";
}
```

### `batteryActionGate`

```typescript
export function batteryActionGate<TCandidate = ActionGateCall>(opts: BatteryActionGateOptions<TCandidate>): ActionGate;
```

### `BatteryActionGateOptions`

```typescript
export interface BatteryActionGateOptions<TCandidate> {
    readonly adrEco: string;
    readonly clock: ClockPort;
    readonly lenses: readonly BatteryLens<TCandidate>[];
    readonly project?: (call: ActionGateCall) => TCandidate;
    readonly runId?: string;
    readonly voteThreshold?: number;
}
```

### `BatteryDecision`

```typescript
export interface BatteryDecision<TOutput = unknown> {
    readonly accepted: TOutput | null;
    readonly acceptedHash: string | null;
    readonly acceptedIndex: number | null;
    readonly acceptedScore: number | null;
    readonly adrEco: string;
    readonly auditStep: BatteryTraceStep;
    readonly rejected: readonly RejectedCandidate[];
    readonly verdicts: readonly CandidateVerdict[];
    readonly voteThreshold: number;
}
```

### `BatteryGovernanceError`

```typescript
export class BatteryGovernanceError extends Error {
    constructor(reason: string);
}
```

### `BatteryLens`

```typescript
export interface BatteryLens<TOutput = unknown> {
    readonly criticality: "hard" | "soft" | "advisory";
    readonly polarity: "affirm" | "refute";
    readonly signature: {
        readonly engine: LensEngine;
        readonly model?: string;
    };
    readonly verifier: Verifier<TOutput>;
}
```

### `BatteryTraceStep`

```typescript
export type BatteryTraceStep = Omit<TraceStep, "index" | "prevStepHash" | "stepHash">;

// Warning: (ae-forgotten-export) The symbol "Verifier_2" needs to be exported by the entry point index.d.ts
//
```

### `batteryVerifier`

```typescript
export function batteryVerifier<TOutput>(opts: BatteryVerifierOptions<TOutput>): Verifier_2<TOutput>;

// Warning: (ae-missing-release-tag) "BatteryVerifierOptions" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `BatteryVerifierOptions`

```typescript
export interface BatteryVerifierOptions<TOutput> {
    readonly adrEco: string;
    readonly clock: ClockPort;
    readonly lenses: readonly BatteryLens<TOutput>[];
    readonly runId?: string;
    readonly selection?: SelectionPolicy;
    readonly voteThreshold?: number;
}
```

### `bestOfN`

```typescript
export function bestOfN<TOutput>(opts: {
    readonly candidates: readonly TOutput[];
    readonly verifier: Verifier_2<TOutput>;
    readonly node: DagNodeSpec;
    readonly inputs: NodeInputs;
}): Promise<VerifierVerdict<TOutput>>;
```

### `BestOfNOptions`

```typescript
export interface BestOfNOptions<_TInput, TOutput> {
    n: number;
    parallel?: boolean;
    rewardModel?: BestOfNRewardModel<TOutput>;
    verifier?: Verifier<TOutput>;
}
```

### `BestOfNRewardModel`

```typescript
export interface BestOfNRewardModel<TOutput> {
    score(output: TOutput): Promise<number> | number;
}
```

### `bestOfNStrategy`

```typescript
export function bestOfNStrategy<TInput, TOutput>(opts: BestOfNOptions<TInput, TOutput>): Strategy<TInput, TOutput>;
```

### `BinaryExecutionOptions`

```typescript
export interface BinaryExecutionOptions {
    cwd?: string;
    executionId?: string;
    extraEnv?: Record<string, string>;
    mode?: string;
    timeoutSeconds?: number;
}
```

### `BonMavOptions`

```typescript
export interface BonMavOptions<TOutput> {
    aggregation?: MAVAggregation;
    n: number;
    parallel?: boolean;
    verifiers: readonly Verifier<TOutput>[];
    voteThreshold?: number;
}
```

### `bonMavStrategy`

```typescript
export function bonMavStrategy<TInput, TOutput>(opts: BonMavOptions<TOutput>): Strategy<TInput, TOutput>;
```

### `BoundedTtlCache`

```typescript
export class BoundedTtlCache<T> implements IdempotencyCache<T> {
    constructor(maxEntries: number, ttlMs: number, now?: () => number);
    delete(key: string): void;
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    get size(): number;
}
```

### `BRAIN_ORIGIN_METADATA_KEY`

```typescript
export const BRAIN_ORIGIN_METADATA_KEY = "_brain";
```

### `BrainAuthError`

```typescript
export class BrainAuthError extends PortError {
    constructor(message?: string, cause?: unknown);
    readonly port = "brain";
}
```

### `BrainCallResult`

```typescript
export interface BrainCallResult<T> {
    readonly mcp_call_hash: string;
    readonly result: T;
    readonly retrieval_proof_hash: string;
}
```

### `BrainChunk`

```typescript
export interface BrainChunk {
    readonly content: string;
    readonly entry_id: string;
    readonly metadata?: Record<string, unknown>;
    readonly similarity: number;
}
```

### `BrainContextOptions`

```typescript
export interface BrainContextOptions<TInput> {
    readonly builtinRecall?: boolean;
    readonly enabled: boolean;
    readonly episodicWindowSize?: number;
    readonly fetchBrainContext?: (query: string, topK: number) => Promise<BrainCallResult<BrainChunk[]> | DegradedResponse>;
    readonly goalSlotKey?: string;
    readonly memory?: Pick<BrainPort, "working" | "episodic">;
    readonly minSimilarity?: number;
    readonly query: (input: TInput) => string;
    readonly replayChunks?: BrainChunk[];
    readonly topK?: number;
}
```

### `BrainEntry`

```typescript
export interface BrainEntry {
    category?: string;
    content: string;
    created_at?: string;
    id: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
}
```

### `BrainEntryInput`

```typescript
export interface BrainEntryInput {
    author?: string;
    brain?: string;
    brain_id?: string;
    category?: string;
    confidence?: number;
    content: string;
    content_type?: string;
    metadata?: Record<string, unknown>;
    source_agent_id?: string;
    tags?: string[];
}
```

### `brainOriginOf`

```typescript
export function brainOriginOf(entry: BrainEntry): string | undefined;
```

### `BrainPort`

```typescript
export interface BrainPort {
    archiveKnowledge(entry: BrainEntryInput): Promise<BrainEntry | null>;
    archiveLesson?(input: LessonInput): Promise<void>;
    archivePostmortem?(input: PostmortemInput): Promise<void>;
    claims?: ClaimPort;
    episodic?: EpisodicMemoryPort;
    procedural?: ProceduralMemoryPort;
    queryKnowledge?(query: string, filters?: BrainQueryFilters): Promise<BrainEntry[]>;
    semantic?: SemanticMemoryPort;
    working?: WorkingMemoryPort;
}

// Warning: (ae-forgotten-export) The symbol "BrainQueryInput" needs to be exported by the entry point index.d.ts
//
```

### `brainQuery`

```typescript
export const brainQuery: Skill<BrainQueryInput, BrainQueryOutput>;
```

### `BrainQueryFilters`

```typescript
export interface BrainQueryFilters {
    [key: string]: unknown;
    category?: string;
    limit?: number;
    tags?: string[];
}
```

### `BrainQueryOutput`

```typescript
export interface BrainQueryOutput {
    entries: BrainEntry[];
}
```

### `BrainRateLimit`

```typescript
export class BrainRateLimit extends PortError {
    constructor(opts?: {
        message?: string;
        retryAfterMs?: number;
        cause?: unknown;
    });
    readonly port = "brain";
    readonly retryAfterMs?: number;
}
```

### `BrainRateLimitError`

```typescript
export class BrainRateLimitError extends Error {
    constructor(message: string, retryAfterMs: number, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly retryAfterMs: number;
}
```

### `brainRecall`

```typescript
export function brainRecall(query: string, opts: RecallOptions, logger?: LoggerPort, config?: BrainRecallConfig): Promise<RecallResult>;
```

### `BrainRecallConfig`

```typescript
export interface BrainRecallConfig {
    readonly baseUrl?: string;
}

// Warning: (ae-internal-missing-underscore) The name "brainRecallImpl" should be prefixed with an underscore because the declaration is marked as @internal
//
```

### `BrainRecallPort`

```typescript
export interface BrainRecallPort {
    recall(query: string, opts: RecallOptions): Promise<RecallResult>;
}
```

### `BrainRoster`

```typescript
export interface BrainRoster {
    readonly skipped: readonly string[];
    readonly targets: readonly BrainTarget[];
}
```

### `BrainRosterOptions`

```typescript
export interface BrainRosterOptions {
    readonly defaultBaseUrl?: string;
    readonly envPrefixes?: readonly string[];
    readonly primaryFallback?: {
        readonly brainId?: string | undefined;
        readonly apiKey?: string | undefined;
        readonly token?: string | undefined;
        readonly baseUrl?: string | undefined;
    };
    readonly primaryName?: string;
}
```

### `BrainSkillNotConfiguredError`

```typescript
export class BrainSkillNotConfiguredError extends Error {
    constructor();
}

// Warning: (ae-forgotten-export) The symbol "BrainStoreInput" needs to be exported by the entry point index.d.ts
//
```

### `brainStore`

```typescript
export const brainStore: Skill<BrainStoreInput, BrainStoreOutput>;
```

### `BrainStoreOutput`

```typescript
export interface BrainStoreOutput {
    archived: boolean;
    id: string | null;
}

// Warning: (ae-missing-release-tag) "BrainTarget" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `BrainTarget`

```typescript
export interface BrainTarget {
    readonly apiKey?: string;
    readonly baseUrl: string;
    readonly brainId: string;
    readonly isPrimary: boolean;
    readonly name: string;
    readonly token?: string;
}
```

### `BrainUnavailable`

```typescript
export class BrainUnavailable extends PortError {
    constructor(message?: string, cause?: unknown);
    readonly port = "brain";
}
```

### `BrainUnavailableError`

```typescript
export class BrainUnavailableError extends Error {
    constructor(message: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
}
```

### `BrainValidationError`

```typescript
export class BrainValidationError extends PortError {
    constructor(message: string, cause?: unknown);
    readonly port = "brain";
}
```

### `BUDGET_CAP`

```typescript
export const BUDGET_CAP: Record<Tier, number>;
```

### `BudgetExhaustedError`

```typescript
export class BudgetExhaustedError extends Error {
    constructor(message?: string);
    readonly name = "BudgetExhaustedError";
}

// Warning: (ae-missing-release-tag) "buildAdversaryLenses" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `buildAdversaryLenses`

```typescript
export function buildAdversaryLenses(opts: {
    readonly stageId: string;
    readonly artifact: string;
    readonly config: AdversaryConfigInput;
    readonly refute: RefuteFn;
}): BatteryLens<string>[];
```

### `buildAlertDigest`

```typescript
export function buildAlertDigest(items: readonly AlertItem[], opts?: AlertDigestOptions): string[];

// Warning: (ae-missing-release-tag) "buildAnchorLens" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `buildAnchorLens`

```typescript
export function buildAnchorLens(spec: AnchorSpecInput, grounded?: GroundedTestResult, configResult?: ConfigValidationResult, engineVerdicts?: ReadonlyMap<string, EngineVerdict>): BatteryLens<string>;
```

### `buildAttenuatedToken`

```typescript
export function buildAttenuatedToken(scope: MeshCapabilityScope, parentId: string): AttenuatedToken;

// Warning: (ae-forgotten-export) The symbol "BlockKitOpts" needs to be exported by the entry point index.d.ts
//
```

### `buildBlockKit`

```typescript
export function buildBlockKit(opts: BlockKitOpts): unknown[];
```

### `buildChain`

```typescript
export function buildChain(trace: Trace): Promise<ProofChain>;

// Warning: (ae-missing-release-tag) "buildDriftLens" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `buildDriftLens`

```typescript
export function buildDriftLens(intent: FrozenIntent | null | undefined, artifact: DriftArtifact | null | undefined, exec: ExecFn | undefined, expectedHead?: string): BatteryLens<string>;
```

### `buildErc8004Registration`

```typescript
export function buildErc8004Registration(input: Erc8004RegistrationInput): Erc8004Registration;

// Warning: (ae-missing-release-tag) "buildFileReader" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `buildFileReader`

```typescript
export function buildFileReader(): FileReader_2;
```

### `buildGateEnvelope`

```typescript
export function buildGateEnvelope(p: BuildGateEnvelopeParams, decision: BatteryDecision): GateVerdictEnvelope;
```

### `BuildGateEnvelopeParams`

```typescript
export interface BuildGateEnvelopeParams {
    readonly attempt: number;
    readonly commit: string;
    readonly keyid: string;
    readonly producerId: string;
    readonly runId: string;
    readonly stageId: string;
}

// Warning: (ae-missing-release-tag) "buildGitExec" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `buildGitExec`

```typescript
export function buildGitExec(): ExecFn;
```

### `buildOrientPrompt`

```typescript
export function buildOrientPrompt(opts: BuildOrientPromptOpts): {
    system: string;
    user: string;
};
```

### `BuildOrientPromptOpts`

```typescript
export interface BuildOrientPromptOpts {
    jsonSchema?: object;
    maxContextChars?: number;
    recentMemory?: string[];
    systemPrompt: string;
    userContext: string;
}
```

### `buildPersonaPromptBlock`

```typescript
export function buildPersonaPromptBlock(persona: AgentPersona): string;
```

### `buildProtocolEnv`

```typescript
export function buildProtocolEnv(args: {
    executionId: string;
    automationName: string;
    input: unknown;
    timeoutSeconds: number;
    mode?: string;
    extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string>;

// Warning: (ae-missing-release-tag) "buildRealExec" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `buildRealExec`

```typescript
export function buildRealExec(): ExecFn;
```

### `buildSignedIndex`

```typescript
export function buildSignedIndex(entries: SkillIndexEntry[], opts: BuildSignedIndexOptions): SignedSkillIndex;
```

### `BuildSignedIndexOptions`

```typescript
export interface BuildSignedIndexOptions {
    expires: string;
    keyId: string;
    signer: SignFn;
    version: number;
}
```

### `buildSkillRegistry`

```typescript
export function buildSkillRegistry(opts: BuildSkillsOptions): SkillRegistry;
```

### `buildSkills`

```typescript
export function buildSkills(opts: BuildSkillsOptions): SkillRegistryBundle;
```

### `BuildSkillsOptions`

```typescript
export interface BuildSkillsOptions {
    readonly agentId: string;
    readonly deps: SkillBuilderDeps;
    readonly domain: string;
    readonly extras?: DomainSkillEntry[];
}
```

### `buildT0MemoryBlock`

```typescript
export function buildT0MemoryBlock(brain: BrainPort, agentId: string, opts?: T0StableMemoryBlockOptions): Promise<T0StableMemoryBlock>;
```

### `buildTeammateEnvelope`

```typescript
export function buildTeammateEnvelope(input: BuildTeammateEnvelopeInput, ports: TeammateEnvelopePorts): TeammateEnvelopeV1;
```

### `BuildTeammateEnvelopeInput`

```typescript
export interface BuildTeammateEnvelopeInput {
    readonly body: string;
    readonly claim: TeammateMessageClaim;
    readonly fromRunId: string;
    readonly id: string;
    readonly replyTo?: string;
    readonly toRunId: string;
}
```

### `buildTeammateEnvelopeV2`

```typescript
export function buildTeammateEnvelopeV2(input: BuildTeammateEnvelopeV2Input, ports: TeammateEnvelopePorts): TeammateEnvelopeV2;
```

### `BuildTeammateEnvelopeV2Input`

```typescript
export interface BuildTeammateEnvelopeV2Input {
    readonly body: string;
    readonly claim: TeammateMessageClaim;
    readonly correlationId: string;
    readonly fromInstallId?: string;
    readonly fromRunId: string;
    readonly id: string;
    readonly replyTo?: string;
    readonly steerId?: string;
    readonly toInstallId?: string;
    readonly toRunId: string;
    readonly toSessionId?: string;
}

// Warning: (ae-forgotten-export) The symbol "TelegramTextOpts" needs to be exported by the entry point index.d.ts
//
```

### `buildTelegramText`

```typescript
export function buildTelegramText(opts: TelegramTextOpts): string;
```

### `BUILT_IN_AXIOMS`

```typescript
export const BUILT_IN_AXIOMS: ReadonlyArray<Axiom>;
```

### `Bulkhead`

```typescript
export interface Bulkhead<TArgs extends unknown[], TResult> {
    (...args: TArgs): Promise<TResult>;
    readonly stats: BulkheadStats;
}
```

### `bulkhead`

```typescript
export function bulkhead<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: BulkheadOptions): Bulkhead<TArgs, TResult>;
```

### `BulkheadFullError`

```typescript
export class BulkheadFullError extends Error {
    constructor(bulkheadName: string, queueDepth: number);
    readonly bulkheadName: string;
}
```

### `BulkheadMetrics`

```typescript
export interface BulkheadMetrics {
    active: number;
    completed: number;
    queued: number;
    rejected: number;
}
```

### `BulkheadOptions`

```typescript
export interface BulkheadOptions {
    maxConcurrent?: number;
    maxQueued?: number;
    name: string;
}
```

### `BulkheadPool`

```typescript
export interface BulkheadPool<T> {
    metrics(): BulkheadMetrics;
    run(fn: () => Promise<T>): Promise<T>;
}
```

### `BulkheadQueueFullError`

```typescript
export class BulkheadQueueFullError extends Error {
    constructor(active: number, queued: number, maxConcurrent: number, maxQueue: number);
}
```

### `BulkheadStats`

```typescript
export interface BulkheadStats {
    active: number;
    queued: number;
}
```

### `BullMQRunner`

```typescript
export class BullMQRunner {
    constructor(config: BullMQRunnerConfig);
    close(): Promise<void>;
    createQueue(name: string, archetype: QueueArchetype): Queue;
    createWorker<T = unknown, R = unknown>(queueName: string, processor: (job: Job<T, R>) => Promise<R>, opts?: Partial<WorkerOptions_2>): Worker_2<T, R>;
    dlqQueue(): Queue<DlqJobPayload>;
    flowProducer(): FlowProducer;
    queueRetryFn<T>(queueName: string): (payload: T) => Promise<string>;
    runFlowReliable<Parent = unknown>(parent: {
        name: string;
        queueName: string;
        data?: Parent;
        opts?: JobsOptions;
    }, children: Array<{
        name: string;
        queueName: string;
        data?: unknown;
        opts?: JobsOptions;
    }>, waitOpts?: {
        pollIntervalMs?: number;
        maxWaitMs?: number;
    }): Promise<{
        parentStatus: "completed" | "failed";
        failedChildren: string[];
        parentJobId: string | undefined;
    }>;
}
```

### `BullMQRunnerConfig`

```typescript
export interface BullMQRunnerConfig {
    defaultAttempts?: number;
    defaultBackoff?: {
        type: "exponential" | "fixed";
        delay: number;
    };
    dlqName?: string;
    jobTimeoutMs?: number;
    redisDb?: number;
    // Warning: (ae-forgotten-export) The symbol "IORedisLike" needs to be exported by the entry point index.d.ts
    redisFactory?: (url: string, db: number) => IORedisLike;
    redisUrl: string;
}
```

### `businessHours`

```typescript
export function businessHours(opts: BusinessHoursOptions): SessionGuard;
```

### `BusinessHoursOptions`

```typescript
export interface BusinessHoursOptions {
    daysOfWeek: number[];
    tz?: string;
    windowEnd: string;
    windowStart: string;
}
```

### `CacheSafetyViolationError`

```typescript
export class CacheSafetyViolationError extends Error {
    constructor(message: string, divergenceIndex: number);
    readonly divergenceIndex: number;
}
```

### `calculateDelay`

```typescript
export function calculateDelay(config: RetryConfig, attempt: number, randomFn?: () => number): number;

// Warning: (ae-forgotten-export) The symbol "CalendarCheckInput" needs to be exported by the entry point index.d.ts
//
```

### `calendarCheck`

```typescript
export const calendarCheck: Skill<CalendarCheckInput, CalendarCheckOutput>;
```

### `CalendarCheckOutput`

```typescript
export interface CalendarCheckOutput {
    date: string;
    holiday_name: string | null;
    is_holiday: boolean;
    is_rth: boolean;
    is_weekend: boolean;
    market: "NYSE" | "CME" | "NASDAQ";
}
```

### `CampaignActionInput`

```typescript
export interface CampaignActionInput {
    readonly action_type: CampaignActionType;
    readonly campaign_slug: string;
    readonly contact_id?: string;
    readonly due_date?: string;
    readonly idempotency_key: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly priority?: number;
    readonly title: string;
}
```

### `CampaignActionPatch`

```typescript
export interface CampaignActionPatch {
    readonly notes?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly phase?: string;
    readonly publish_evidence?: Readonly<Record<string, unknown>>;
    readonly scheduled_at?: string;
    readonly status?: CampaignActionStatus;
}
```

### `CampaignActionRef`

```typescript
export interface CampaignActionRef {
    readonly action_id: string;
    readonly action_type: CampaignActionType;
    readonly campaign_slug: string;
    readonly contact_id?: string;
    readonly name?: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly priority: number;
    readonly status: CampaignActionStatus;
}
```

### `CampaignActionStatus`

```typescript
export type CampaignActionStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";
```

### `CampaignActionType`

```typescript
export type CampaignActionType = "publish_article" | "publish_social_post" | "send_cold_mail" | "send_follow_up_mail" | "engage_target" | "manual_review";
```

### `CampaignInput`

```typescript
export interface CampaignInput {
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly name: string;
    readonly objective: string;
    readonly product: string;
    readonly slug: string;
    readonly tags?: readonly string[];
}
```

### `CampaignPatch`

```typescript
export interface CampaignPatch {
    readonly cadence_plan?: Readonly<Record<string, unknown>>;
    readonly description?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly name?: string;
    readonly status?: CampaignStatus;
    readonly tags?: readonly string[];
}
```

### `CampaignRef`

```typescript
export interface CampaignRef {
    readonly campaign_id: string;
    readonly created_at: Date;
    readonly slug: string;
    readonly status: CampaignStatus;
}
```

### `CampaignStatus`

```typescript
export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";
```

### `canAutoOverwrite`

```typescript
export function canAutoOverwrite(existing: SkillMetrics | null | undefined): boolean;
```

### `CandidateVerdict`

```typescript
export interface CandidateVerdict {
    readonly candidateHash: string;
    readonly candidateIndex: number;
    readonly compositeScore: number;
    readonly killed: boolean;
    readonly killReason: string | null;
    readonly lensVerdicts: readonly LensVerdict[];
}
```

### `canonicalAgentId`

```typescript
export function canonicalAgentId(chainId: string, identityRegistryAddress: string): string;
```

### `canonicalEnvelopeString`

```typescript
export function canonicalEnvelopeString(env: GateVerdictEnvelope): string;
```

### `canonicalEventString`

```typescript
export function canonicalEventString(event: Omit<DomainEvent, "signature">, payloadHash: string): string;
```

### `canonicalize`

```typescript
export function canonicalize(value: unknown): string;
```

### `canonicalStateHash`

```typescript
export function canonicalStateHash(toolName: string, args: unknown, outputSummary: string): string;
```

### `canonicalTeammateEnvelopeString`

```typescript
export function canonicalTeammateEnvelopeString(env: TeammateEnvelope): string;
```

### `CapabilityGate`

```typescript
export interface CapabilityGate {
    getExpiresAt?(): number;
    getIssuedAt?(): number;
    rotateToken?(newTokenB64: string, newExpiresAt: number): void;
    verify(call: CapabilityGateCall): CapabilityGateVerdict | Promise<CapabilityGateVerdict>;
}
```

### `CapabilityGateCall`

```typescript
export interface CapabilityGateCall {
    readonly budgetUsed: number;
    readonly mcpScopes?: readonly string[];
    readonly toolName: string;
}
```

### `CapabilityGateVerdict`

```typescript
export type CapabilityGateVerdict = {
    readonly allowed: true;
} | {
    readonly allowed: false;
    readonly reason: string;
};
```

### `CapabilityInvocation`

```typescript
export interface CapabilityInvocation {
    readonly action: string;
    readonly dataClass: DataClass;
    readonly jurisdiction?: Jurisdiction;
    readonly legalBasis?: LegalBasisRef;
    readonly requiresConsent?: boolean;
    readonly requiresVerifiedHuman?: boolean;
    readonly stepIndex?: number;
    readonly tenantId: string;
    readonly workflowRunId?: string;
}
```

### `CapabilityScope`

```typescript
export interface CapabilityScope {
    readonly capabilities: ReadonlyArray<string>;
    // Warning: (ae-forgotten-export) The symbol "Constraint" needs to be exported by the entry point index.d.ts
    //
    readonly constraints: ReadonlyArray<Constraint>;
    readonly expires_at: string;
    readonly jurisdictions: ReadonlyArray<string>;
}
```

### `CapabilityTier`

```typescript
export type CapabilityTier = "T1" | "T2" | "T3" | "T4";
```

### `CapabilityTierClassification`

```typescript
export interface CapabilityTierClassification {
    readonly hitl: boolean;
    readonly tier: CapabilityTier;
}
```

### `CapabilityTierOverrides`

```typescript
export type CapabilityTierOverrides = Readonly<Record<string, CapabilityTierClassification>>;
```

### `CapabilityTierRegistry`

```typescript
export interface CapabilityTierRegistry {
    classify(capability: string): CapabilityTierClassification;
}
```

### `CapabilityTierRegistryOptions`

```typescript
export interface CapabilityTierRegistryOptions {
    readonly defaultClassification?: CapabilityTierClassification;
    readonly overrides?: CapabilityTierOverrides;
}
```

### `capabilityToSdkPermissions`

```typescript
export function capabilityToSdkPermissions(scope: CcScope, tools: readonly string[]): MappedSdkPermissions;
```

### `CaptureResult`

```typescript
export interface CaptureResult {
    readonly candidateId?: string;
    readonly captured: boolean;
    readonly reason?: string;
}
```

### `captureSkillFromCycle`

```typescript
export function captureSkillFromCycle(agentId: string, runId: string, trigger: LearningTrigger, outcome: OutcomeRecord | null, traceSummary: string, opts: SkillCaptureOptions, logger: LoggerPort): Promise<CaptureResult>;
```

### `CascadeAdapter`

```typescript
export class CascadeAdapter implements LLMProviderPort {
    constructor(config: CascadeAdapterConfig);
    complete(req: ChatRequest): Promise<ChatResponse>;
    estimateCost(req: ChatRequest): {
        usd: number;
    };
    stream(req: ChatRequest): AsyncIterable<StreamDelta>;
}
```

### `CascadeAdapterConfig`

```typescript
export interface CascadeAdapterConfig {
    providers: LLMProviderPort[];
}

// Warning: (ae-forgotten-export) The symbol "CboeVixSpotInput" needs to be exported by the entry point index.d.ts
//
```

### `cboeVixSpot`

```typescript
export const cboeVixSpot: Skill<CboeVixSpotInput, CboeVixSpotOutput>;
```

### `CboeVixSpotOutput`

```typescript
export interface CboeVixSpotOutput {
    cached: boolean;
    delayed_minutes: number;
    fetched_at: string;
    last: number;
    symbol: "VIX";
}
```

### `CcScope`

```typescript
export type CcScope = "cc:read" | "cc:execute" | "cc:admin";
```

### `CertChainInvalidError`

```typescript
export class CertChainInvalidError extends Error {
    constructor(detail: string);
    readonly detail: string;
}
```

### `CertExpiredError`

```typescript
export class CertExpiredError extends Error {
    constructor(now: number, notAfter: number);
    readonly notAfter: number;
    readonly now: number;
}
```

### `CfoView`

```typescript
export interface CfoView {
    burn_rate_per_day_cents: number;
    by_initiative: Array<{
        initiative_id: string;
        spent_cents: number;
        budget_cents: number | null;
        pct: number | null;
    }>;
    pending_value_estimate_cents: number;
    period: {
        from: string;
        to: string;
    };
    projected_30d_cents: number;
}
```

### `ChatMessage`

```typescript
export interface ChatMessage {
    attachments?: MessageAttachment[];
    content: string;
    role: "system" | "user" | "assistant";
}
```

### `ChatRequest`

```typescript
export interface ChatRequest {
    abortSignal?: AbortSignal;
    maxTokens?: number;
    messages: ChatMessage[];
    metadata?: {
        tenantId?: string;
        agentId?: string;
        correlationId?: string;
    };
    model?: string;
    temperature?: number;
}
```

### `ChatResponse`

```typescript
export interface ChatResponse {
    content: string;
    finishReason: "stop" | "length" | "tool" | "error";
    model: string;
    usage: ChatUsage;
}
```

### `ChatUsage`

```typescript
export interface ChatUsage {
    readonly cacheCreationTokens?: number;
    readonly cacheReadTokens?: number;
    costUsd?: number;
    inputTokens: number;
    outputTokens: number;
}
```

### `checkRequiredAnchors`

```typescript
export function checkRequiredAnchors(core: GateDecisionCore, requiredAnchorIds: readonly string[]): EnvelopeVerification;
```

### `CHILD_SYSTEM_PROMPT`

```typescript
export const CHILD_SYSTEM_PROMPT: string;
```

### `ChildAgentOptions`

```typescript
export interface ChildAgentOptions {
    agentId: string;
    handoffChain?: string[];
    maxChainDepth?: number;
    task: Record<string, unknown>;
    timeoutMs?: number;
}
```

### `ChildAgentPort`

```typescript
export interface ChildAgentPort {
    spawnAsync(opts: ChildAgentOptions): Promise<{
        workerId: string;
    }>;
    spawnSync(opts: ChildAgentOptions): Promise<ChildAgentResult>;
}
```

### `ChildAgentResult`

```typescript
export interface ChildAgentResult {
    error?: string;
    output?: unknown;
    status: "accepted" | "completed" | "failed" | "timeout";
    workerId: string;
}
```

### `ChildWorkflowOpts`

```typescript
export interface ChildWorkflowOpts {
    readonly idempotencyKey?: string;
    readonly tenantId?: string;
    readonly version?: string;
}
```

### `CircuitBreaker`

```typescript
export interface CircuitBreaker<TArgs extends unknown[], TResult> {
    (...args: TArgs): Promise<TResult>;
    readonly failureCount: number;
    reset(): void;
    readonly state: CircuitState;
}
```

### `circuitBreaker`

```typescript
export function circuitBreaker<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: CircuitBreakerOptions): CircuitBreaker<TArgs, TResult>;
```

### `CircuitBreakerConfig`

```typescript
export interface CircuitBreakerConfig {
    cooldownMs: number;
    thresholdUsd: number;
    windowMs: number;
}
```

### `CircuitBreakerOptions`

```typescript
export interface CircuitBreakerOptions {
    failureThreshold?: number;
    isFailure?: (err: unknown) => boolean;
    name: string;
    now?: () => number;
    resetAfterMs?: number;
}
```

### `CircuitBreakerResetMode`

```typescript
export type CircuitBreakerResetMode = "cron-rth" | "admin-endpoint" | "never";
```

### `CircuitBreakerSnapshot`

```typescript
export interface CircuitBreakerSnapshot {
    failure_count: number;
    last_failure: string | null;
    last_success: string | null;
    provider: string;
    reset_after_ms: number | null;
    state: "closed" | "open" | "half-open";
}
```

### `CircuitOpenError`

```typescript
export class CircuitOpenError extends Error {
    constructor(circuitName: string, retryAfterMs: number);
    readonly circuitName: string;
    readonly retryAfterMs: number;
}
```

### `CircuitState`

```typescript
export type CircuitState = "closed" | "open" | "half-open";
```

### `CitadelActionContext`

```typescript
export interface CitadelActionContext {
    readonly agentId: string;
    readonly agentTier: AgentTier;
    readonly runId: string;
    readonly tenantId?: string;
}
```

### `CitadelActionPort`

```typescript
export interface CitadelActionPort {
    createSprint(input: SprintInput, ctx: CitadelActionContext): Promise<SprintRef>;
    recordDecision(decision: DecisionInput, ctx: CitadelActionContext): Promise<DecisionClaim>;
    sealSprint(sprintId: string, evidence: VerificationEvidence, ctx: CitadelActionContext): Promise<SealedSprintClaim>;
    updateTaskStatus(ref: TaskRef, status: TaskStatus, ctx: CitadelActionContext): Promise<void>;
}
```

### `CitadelCampaignMcpClient`

```typescript
export interface CitadelCampaignMcpClient {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
```

### `CitadelCampaignPort`

```typescript
export interface CitadelCampaignPort {
    blockAction(action_id: string, reason: string, ctx: CitadelActionContext): Promise<void>;
    bumpEngagementScore(contact_id: string, delta: number, reason: string, ctx: CitadelActionContext): Promise<ContactRef>;
    claimAction(action_id: string, ctx: CitadelActionContext): Promise<CampaignActionRef | null>;
    completeAction(completion: ActionCompletion, ctx: CitadelActionContext): Promise<void>;
    createAction(input: CampaignActionInput, ctx: CitadelActionContext): Promise<CampaignActionRef>;
    createCampaign(input: CampaignInput, ctx: CitadelActionContext): Promise<CampaignRef>;
    findContactByEmail(email: string, ctx: CitadelActionContext): Promise<ContactRef | null>;
    getCampaign(slug: string, ctx: CitadelActionContext): Promise<CampaignRef | null>;
    listActions(filter: ActionFilter, ctx: CitadelActionContext): Promise<readonly CampaignActionRef[]>;
    updateAction(ref: string, update: CampaignActionPatch, ctx: CitadelActionContext): Promise<void>;
    updateCampaignStatus(slug: string, status: CampaignStatus, ctx: CitadelActionContext): Promise<void>;
    updateContactStatus(contact_id: string, status: string, ctx: CitadelActionContext): Promise<void>;
    upsertContact(input: ContactInput, ctx: CitadelActionContext): Promise<ContactRef>;
}
```

### `CitadelInvalidStateTransitionError`

```typescript
export class CitadelInvalidStateTransitionError extends Error {
    constructor(current_status: TaskStatus, requested_status: TaskStatus, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly current_status: TaskStatus;
    readonly requested_status: TaskStatus;
}
```

### `CitadelSprintNotActiveError`

```typescript
export class CitadelSprintNotActiveError extends Error {
    constructor(sprint_id: string, current_status: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly current_status: string;
    readonly sprint_id: string;
}
```

### `CitadelTaskRefNotFoundError`

```typescript
export class CitadelTaskRefNotFoundError extends Error {
    constructor(task_ref: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly task_ref: string;
}
```

### `CitadelTierViolationError`

```typescript
export class CitadelTierViolationError extends Error {
    constructor(message: string, required_tier: AgentTier, actual_tier: AgentTier, operation: string, cause?: unknown | undefined);
    readonly actual_tier: AgentTier;
    readonly cause?: unknown | undefined;
    readonly operation: string;
    readonly required_tier: AgentTier;
}
```

### `Claim`

```typescript
export interface Claim {
    agentId?: string;
    claimSource: ClaimSource;
    claimStatus: ClaimStatus;
    confidence: number;
    createdAt: string;
    entryId?: string;
    id: string;
    object?: string;
    predicate: string;
    scope: MemoryScope;
    subject: string;
    validFrom?: string;
    validUntil?: string;
}
```

### `ClaimAssertOptions`

```typescript
export interface ClaimAssertOptions {
    agentId?: string;
    claimSource?: ClaimSource;
    confidence?: number;
    entryId?: string;
    scope?: MemoryScope;
    validFrom?: string;
    validUntil?: string;
}
```

### `ClaimPort`

```typescript
export interface ClaimPort {
    assert(subject: string, predicate: string, object?: string, opts?: ClaimAssertOptions): Promise<string>;
    query(filter: ClaimQueryFilter): Promise<Claim[]>;
}
```

### `ClaimQueryFilter`

```typescript
export interface ClaimQueryFilter {
    agentId?: string;
    claimStatus?: ClaimStatus;
    limit?: number;
    object?: string;
    predicate?: string;
    subject?: string;
}
```

### `ClaimSource`

```typescript
export type ClaimSource = "human_input" | "agent_inference" | "consolidation" | "external_ingestion";
```

### `ClaimStatus`

```typescript
export type ClaimStatus = "active" | "disputed" | "superseded" | "retracted";
```

### `classifyReason`

```typescript
export function classifyReason(reason: string): string;
```

### `classifyReceipt`

```typescript
export function classifyReceipt(receipt: unknown): PayResult["status"];
```

### `ClientPolicy`

```typescript
export interface ClientPolicy {
    readonly allowed_actions: readonly ("swap" | "deposit" | "withdraw" | "transfer")[];
    // Warning: (ae-forgotten-export) The symbol "TokenAddress" needs to be exported by the entry point index.d.ts
    //
    readonly allowed_pairs: readonly [TokenAddress, TokenAddress][];
    readonly cache_ttl_seconds: number;
    readonly daily_volume_cap: string;
    readonly deposit_cap: string;
    readonly max_slippage_bps: number;
}
```

### `ClockExhaustedError`

```typescript
export class ClockExhaustedError extends Error {
    constructor(recorded: number, requested: number);
}
```

### `ClockPort`

```typescript
export interface ClockPort {
    now(): number;
}
```

### `ClockSkewError`

```typescript
export class ClockSkewError extends Error {
    constructor(skewMs: number);
    readonly skewMs: number;
}
```

### `CloudEvent`

```typescript
export interface CloudEvent {
    correlationid?: string;
    data?: unknown;
    datacontenttype?: string;
    dataschemaversion?: number;
    id: string;
    partitionkey?: string;
    source: string;
    specversion: "1.0";
    time: string;
    traceparent?: string;
    type: string;
}
```

### `CoherenceDetector`

```typescript
export interface CoherenceDetector {
    check(recentToolCalls: Array<{
        name: string;
        args: unknown;
    }>, stepsWithoutTool: number): {
        isLoop: boolean;
        isStall: boolean;
        score: number;
    };
}
```

### `CoherenceEpisode`

```typescript
export interface CoherenceEpisode {
    isFalsePositive: boolean;
    stepCount: number;
    stopReason: string;
}
```

### `CoherenceModel`

```typescript
export interface CoherenceModel {
    episodes: number;
    falsePositiveRate: number;
    lastUpdated: number;
    loopDetectionWindow: number;
    stallThreshold: number;
}
```

### `CompactionLLMFn`

```typescript
export type CompactionLLMFn = (prompt: string) => Promise<string>;
```

### `CompactionOutcome`

```typescript
export interface CompactionOutcome {
    compacted: boolean;
    log: LogMessage[];
    mode: "llm" | "deterministic" | "none";
}
```

### `CompactionReport`

```typescript
export interface CompactionReport {
    readonly summariesAdded: number;
    readonly tokensEstimatedAfter: number;
    readonly tokensEstimatedBefore: number;
    readonly turnsAfter: number;
    readonly turnsBefore: number;
}
```

### `CompactionSummary`

```typescript
export interface CompactionSummary {
    readonly createdAt: number;
    readonly originalTokens: number;
    readonly text: string;
    readonly turnCount: number;
}
```

### `CompactOpts`

```typescript
export interface CompactOpts {
    readonly keepLast?: number;
}
```

### `Compactor`

```typescript
export type Compactor = ReturnType<typeof createCompactor>;
```

### `CompactorConfig`

```typescript
export interface CompactorConfig {
    emergencyThreshold?: number;
    indexFor?: (msg: LogMessage) => number | undefined;
    keepLast?: number;
    threshold?: number;
}
```

### `compactToolLog`

```typescript
export function compactToolLog(log: LogMessage[], opts?: {
    keepFirst?: number;
    keepLast?: number;
}): LogMessage[];
```

### `compactToolLogDecay`

```typescript
export function compactToolLogDecay(log: LogMessage[], config?: DecayCompactionConfig): LogMessage[];
```

### `compactToolLogGist`

```typescript
export function compactToolLogGist(log: Array<{
    role: string;
    content: string;
    toolName?: string;
}>, llmFn: GistLLMFn, keepRecentN?: number, config?: GistCompressionConfig): Promise<Array<{
    role: string;
    content: string;
    toolName?: string;
}>>;
```

### `compileToSmt`

```typescript
export function compileToSmt(spec: AxiomSpec): string;
```

### `completeRunStep`

```typescript
export function completeRunStep(db: DbClient, stepId: string, payload: Record<string, unknown>): Promise<{
    leafHash: string;
}>;
```

### `ComplexAgentOptions`

```typescript
export interface ComplexAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback> {
    act: (decision: TDecision, ctx: OODAContext) => Promise<TAction>;
    agentId: string;
    agentVersion?: string;
    decide: (orient: TOrient, ctx: OODAContext) => Promise<TDecision>;
    feedback: (input: TAction & {
        decision?: TDecision;
    }, ctx: OODAContext) => Promise<TFeedback>;
    hitlEscalationLevel?: "L2" | "L3";
    intervalMs: number;
    observe: (_: void, ctx: OODAContext) => Promise<TObs>;
    orient: (obs: TObs, ctx: OODAContext) => Promise<TOrient>;
    outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
    reflect?: (input: TAction & {
        decision: TDecision;
    }, ctx: OODAContext) => Promise<TFeedback>;
    riskGuards?: RiskGuard[];
    sessionGuards?: SessionGuard[];
}
```

### `ComplianceAuditResult`

```typescript
export interface ComplianceAuditResult {
    readonly auditClaimEmitted: boolean;
    readonly decision: "proceed" | "block" | "warn";
    readonly evaluatedRules: number;
    readonly violations: ComplianceViolation[];
}
```

### `ComplianceContract`

```typescript
export interface ComplianceContract {
    readonly audit_format?: "json" | "pdf";
    readonly data_class: DataClass;
    readonly jurisdictions: Jurisdiction[];
    readonly legal_bases: LegalBasisDecl[];
    readonly mode: ComplianceMode;
    readonly retention: string;
    readonly rules: ComplianceRule[];
    readonly tier: string;
}
```

### `ComplianceContractPort`

```typescript
export interface ComplianceContractPort {
    postStep(invocation: CapabilityInvocation, contract: ComplianceContract, ctx: TenantContext): Promise<ComplianceAuditResult>;
    preStep(invocation: CapabilityInvocation, contract: ComplianceContract, ctx: TenantContext): Promise<ComplianceGate>;
    validateManifest(contract: ComplianceContract, opts?: {
        timeoutMs?: number;
    }): Promise<ManifestValidationResult>;
}
```

### `ComplianceEvaluationTimeoutError`

```typescript
export class ComplianceEvaluationTimeoutError extends Error {
    constructor(timeoutMs: number, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly timeoutMs: number;
}
```

### `ComplianceGate`

```typescript
export type ComplianceGate = {
    readonly decision: "proceed";
    readonly warnings: ComplianceViolation[];
} | {
    readonly decision: "block";
    readonly violation: ComplianceViolation;
};
```

### `ComplianceMode`

```typescript
export type ComplianceMode = "strict" | "audit_only";
```

### `CompliancePolicyError`

```typescript
export class CompliancePolicyError extends Error {
    constructor(message: string, ruleId: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly ruleId: string;
}
```

### `ComplianceRule`

```typescript
export interface ComplianceRule {
    readonly authority?: string;
    readonly enforcement: EnforcementLevel;
    readonly id: string;
    readonly jurisdiction: Jurisdiction;
    readonly legal_ref: LegalBasisRef;
    readonly rationale: string;
    readonly source: RuleSource;
}
```

### `ComplianceViolation`

```typescript
export interface ComplianceViolation {
    readonly articleRef: string;
    readonly description: string;
    readonly remediationHint?: string;
    readonly ruleId: string;
    readonly severity: "block" | "warn";
}
```

### `composeActionGates`

```typescript
export function composeActionGates(...gates: readonly ActionGate[]): ActionGate;
```

### `CompositeRunJournal`

```typescript
export class CompositeRunJournal implements RunJournalPort {
    constructor(primary: RunJournalPort, mirror: {
        port: EpisodicMemoryPort;
        agentId: string;
        sessionId: string;
    }, onMirrorError?: ((reason: string) => void) | undefined);
    append(msg: LogMessage, meta?: JournalAppendMeta): Promise<number>;
    get degraded(): boolean;
    read(range: {
        from: number;
        to: number;
    }): Promise<JournalStep[]>;
    search(query: string, opts?: {
        topK?: number;
    }): Promise<JournalStep[]>;
}
```

### `ComputeContext`

```typescript
export interface ComputeContext {
    signal?: AbortSignal;
}
```

### `computeIdempotencyKey`

```typescript
export function computeIdempotencyKey(payload: IdempotencyKeyPayload): string;
```

### `computeJwkThumbprint`

```typescript
export function computeJwkThumbprint(jwk: EcP256Jwk): string;
```

### `computeKellyFraction`

```typescript
export function computeKellyFraction(historicalTradeCount: number, expectedReturn: number, variance: number, config: {
    kelly_cap: number;
    kelly_bootstrap_fraction: number;
    bootstrap_trade_threshold: number;
}): {
    fraction: number;
    mode: "bootstrap" | "kelly";
};
```

### `computeKeyId`

```typescript
export function computeKeyId(publicKey: KeyObject): string;

// Warning: (ae-missing-release-tag) "computePaymentAuthorizationCommitment" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `computePaymentAuthorizationCommitment`

```typescript
export function computePaymentAuthorizationCommitment(policy: PaymentPolicy, facts: PaymentFacts): string;
```

### `computeQuality`

```typescript
export function computeQuality(inputs: QualityInputs): number;
```

### `computeQualityOrNull`

```typescript
export function computeQualityOrNull(inputs: ProductiveQualityInputs): number | null;
```

### `computeQualityWithBreakdown`

```typescript
export function computeQualityWithBreakdown(inputs: QualityInputs): QualityBreakdown;
```

### `computeRoi`

```typescript
export function computeRoi(input: ComputeRoiInput): ComputeRoiResult;
```

### `ComputeRoiInput`

```typescript
export interface ComputeRoiInput {
    costsCentsByOutcomeId?: Map<string, number>;
    outcomes: Outcome[];
}
```

### `ComputeRoiResult`

```typescript
export interface ComputeRoiResult {
    netRoiPct: number | null;
    outcomeCount: number;
    pendingCount: number;
    totalCostCents: number;
    totalValueCents: number;
    valueToCostRatio: number | null;
}
```

### `computeStepHash`

```typescript
export function computeStepHash(step: TraceStep, runId: string): Promise<string>;
```

### `Condition`

```typescript
export type Condition = {
    type: "budget_constraint";
    child_max_fraction: number;
} | {
    type: "scope_subset";
    parent_scope: string[];
    child_scope: string[];
} | {
    type: "no_pii_in_output";
    pii_count_var?: string;
} | {
    type: "cost_positive_roi";
    min_roi_ratio: number;
} | {
    type: "response_time";
    max_ms: number;
} | {
    type: "custom_smt";
    smt_fragment: string;
};

// Warning: (ae-missing-release-tag) "CONFIG_GROUNDED_ANCHORS" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `CONFIG_GROUNDED_ANCHORS`

```typescript
export const CONFIG_GROUNDED_ANCHORS: ReadonlySet<string>;

// Warning: (ae-missing-release-tag) "ConfigValidationResult" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ConfigValidationResult`

```typescript
export interface ConfigValidationResult {
    readonly ran: boolean;
    readonly rationale: string;
    readonly valid: boolean;
}

// Warning: (ae-forgotten-export) The symbol "ConnectRelayOptions" needs to be exported by the entry point index.d.ts
//
```

### `connectRelay`

```typescript
export function connectRelay(opts: ConnectRelayOptions): Promise<RelayConnection>;
```

### `ConsoleChannel`

```typescript
export class ConsoleChannel implements MessagingChannelPort {
    constructor(config?: ConsoleChannelConfig);
    sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
    sendMessage(target: string, text: string): Promise<void>;
}
```

### `ConsoleChannelConfig`

```typescript
export interface ConsoleChannelConfig {
    stream?: NodeJS.WriteStream;
}
```

### `ConsumerMode`

```typescript
export type ConsumerMode = "strict" | "permissive" | "audit_only";
```

### `ContactDirection`

```typescript
export type ContactDirection = "inbound" | "outbound";
```

### `ContactInput`

```typescript
export interface ContactInput {
    readonly campaign_slug: string;
    readonly direction: ContactDirection;
    readonly email?: string;
    readonly handle: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly platform: string;
    readonly source?: string;
}
```

### `ContactRef`

```typescript
export interface ContactRef {
    readonly campaign_slug: string;
    readonly contact_id: string;
    readonly email?: string;
    readonly engagement_score: number;
    readonly handle: string;
    readonly status: string;
}
```

### `ContainerExecutionOptions`

```typescript
export interface ContainerExecutionOptions {
    cpuQuota?: number;
    executionId?: string;
    extraEnv?: Record<string, string>;
    memoryMb?: number;
    mode?: string;
    networkMode?: "none" | "outbound" | "bridge";
    readOnlyRoot?: boolean;
    timeoutSeconds?: number;
}
```

### `ContainerRuntime`

```typescript
export class ContainerRuntime {
    constructor(opts?: ContainerRuntimeOptions);
    executeBinary<T = unknown>(command: string[], automationName: string, input: unknown, options?: BinaryExecutionOptions): Promise<ExecutionResult<T>>;
    executeContainer<T = unknown>(image: string, automationName: string, input: unknown, options?: ContainerExecutionOptions): Promise<ExecutionResult<T>>;
}
```

### `ContainerRuntimeOptions`

```typescript
export interface ContainerRuntimeOptions {
    defaultTimeoutSeconds?: number;
    sandbox?: SandboxExecutor;
    spawnFn?: ContainerSpawnFn;
}
```

### `ContainerSpawnFn`

```typescript
export type ContainerSpawnFn = (cmd: string, args: string[], opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    stdio: ["pipe", "pipe", "pipe"];
    signal?: AbortSignal;
}) => ChildProcess;
```

### `ContentClaim`

```typescript
export interface ContentClaim {
    readonly anchor: ReadonlyArray<{
        readonly chain: "StarknetMainnet" | "StarknetL3Glacis";
        readonly tx_hash?: string;
    }>;
    readonly evidence: {
        readonly proof: string;
        readonly public_inputs: Record<string, unknown>;
    };
    readonly predicate: {
        readonly domain: "vauban.federation.message.v1";
        readonly body: Record<string, unknown>;
    };
    readonly revelation_mask: {
        readonly disclosed: string[];
        readonly committed: string[];
    };
    readonly subject: string;
    readonly temporal_frame: {
        readonly not_before: string;
        readonly not_after: string;
        readonly revoked_at?: string | null;
    };
}
```

### `CONTROL_VERB_REQUIRED_SCOPE`

```typescript
export const CONTROL_VERB_REQUIRED_SCOPE: Readonly<Record<ControlVerb, ControlScope>>;
```

### `CONTROL_VERBS`

```typescript
export const CONTROL_VERBS: ReadonlySet<ControlVerb>;
```

### `ControlClaimVerdict`

```typescript
export interface ControlClaimVerdict {
    readonly allowed: boolean;
    readonly auditStep: BatteryTraceStep;
    readonly grant: ControlScope | undefined;
    readonly reason: string;
    readonly requiredScope: ControlScope | undefined;
    readonly verb: string;
}
```

### `CONTROLLER_CONTROL_ADR`

```typescript
export const CONTROLLER_CONTROL_ADR = "ADR-ECO-118";

// Warning: (ae-forgotten-export) The symbol "ControlScopeCandidate" needs to be exported by the entry point index.d.ts
//
```

### `controllerControlScopeLens`

```typescript
export const controllerControlScopeLens: BatteryLens<ControlScopeCandidate>;
```

### `ControlScope`

```typescript
export type ControlScope = SubTokenScope;
```

### `ControlVerb`

```typescript
export type ControlVerb = "observe" | "status" | "approve" | "reject" | "veto" | "revive" | "steer" | "whisper" | "stop" | "message" | "team-list" | "team-send" | "delegate" | "coordinate" | "start" | "sync";
```

### `ConversationContext`

```typescript
export class ConversationContext {
    constructor(opts?: ConversationContextOpts);
    addTurn(role: "user" | "assistant", content: string, meta?: Turn["meta"]): void;
    compact(llmFn: CompactionLLMFn, opts?: CompactOpts): Promise<CompactionReport>;
    estimatedTokens(): number;
    static fromJSON(snapshot: ConversationContextSnapshot): ConversationContext;
    maybeCompact(model: string, llmFn: CompactionLLMFn, threshold?: number): Promise<boolean>;
    get summaries(): readonly CompactionSummary[];
    toJSON(): ConversationContextSnapshot;
    toMessages(strategy: AgentStrategyName, systemPrompt?: string): string | LLMMessage[];
    get turnCount(): number;
    get turns(): readonly Turn[];
    get workingMemorySize(): number;
}
```

### `ConversationContextOpts`

```typescript
export interface ConversationContextOpts {
    readonly getContextWindow?: (model: string) => number;
    readonly workingMemorySize?: number;
}
```

### `ConversationContextSnapshot`

```typescript
export interface ConversationContextSnapshot {
    readonly summaries: readonly CompactionSummary[];
    readonly turns: readonly Turn[];
    readonly version: 1;
    readonly workingMemorySize: number;
}
```

### `cosineSimilarity`

```typescript
export function cosineSimilarity(a: number[], b: number[]): number;
```

### `COST_GATE_ADR`

```typescript
export const COST_GATE_ADR = "ADR-ECO-045";

// Warning: (ae-missing-release-tag) "CostAccountingOptions" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `CostAccountingOptions`

```typescript
export interface CostAccountingOptions {
    readonly now?: () => number;
}

// Warning: (ae-missing-release-tag) "CostAccountingPort" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `CostAccountingPort`

```typescript
export interface CostAccountingPort extends LLMProviderPort {
    reset(): void;
    snapshot(): CostAccountingSnapshot;
}

// Warning: (ae-missing-release-tag) "CostAccountingSnapshot" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `CostAccountingSnapshot`

```typescript
export interface CostAccountingSnapshot {
    readonly byCycle: readonly CostRecord[];
    readonly byWorker: readonly CostRecord[];
    readonly cacheHitRatio: number;
    readonly totals: CostRecord;
}
```

### `CostEntry`

```typescript
export interface CostEntry {
    agentId: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    ts: number;
}
```

### `costGateAllow`

```typescript
export function costGateAllow(d: AgentRunDeclaration): boolean;
```

### `costGateDeny`

```typescript
export function costGateDeny(d: AgentRunDeclaration): string[];
```

### `costGateLens`

```typescript
export function costGateLens(opts?: {
    name?: string;
}): BatteryLens<AgentRunDeclaration>;

// Warning: (ae-missing-release-tag) "CostRecord" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `CostRecord`

```typescript
export interface CostRecord {
    readonly agentId: string;
    readonly cacheCreationTokens: number;
    readonly cacheReadTokens: number;
    readonly callCount: number;
    readonly correlationId: string;
    readonly costUsd: number;
    readonly errorCount: number;
    readonly inputTokens: number;
    readonly latencyMs: number;
    readonly outputTokens: number;
}
```

### `CostTier`

```typescript
export type CostTier = "low" | "medium" | "high";
```

### `createAgent`

```typescript
export function createAgent(cfg: AgentConfig): Agent;
```

### `createAgentConfigLoader`

```typescript
export function createAgentConfigLoader<T = Record<string, unknown>>(opts: {
    db: DbClient;
    ttlMs?: number;
    defaultConfig?: T;
    columnName?: "config" | "extra";
}): AgentConfigLoader<T>;
```

### `createAgentFromConfig`

```typescript
export function createAgentFromConfig<TConfig = unknown, TObs = unknown, TOrient = unknown, TDecision = unknown, TAction = unknown, TFeedback = unknown>(deps: AgentFactoryDeps, config: AgentFactoryConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>): Promise<OODAAgent>;
```

### `createAgentMetrics`

```typescript
export function createAgentMetrics(opts?: CreateAgentMetricsOptions): AgentMetrics;
```

### `CreateAgentMetricsOptions`

```typescript
export interface CreateAgentMetricsOptions {
    prefix?: string;
    // Warning: (ae-forgotten-export) The symbol "Registry" needs to be exported by the entry point index.d.ts
    registry?: Registry;
}
```

### `createAgentRunTracker`

```typescript
export function createAgentRunTracker(db: DbClient): AgentRunTracker;
```

### `createAgentsClient`

```typescript
export function createAgentsClient(opts: AgentsClientOptions): AgentsClient;
```

### `createAttentionGate`

```typescript
export function createAttentionGate(opts: AttentionGateOptions): AttentionGate;
```

### `createBrainCompactionLlmFn`

```typescript
export function createBrainCompactionLlmFn(semanticMemory: SemanticMemoryPort, localLlmFn: CompactionLLMFn, sessionTag: string): CompactionLLMFn;
```

### `createBrainPortFromEnv`

```typescript
export function createBrainPortFromEnv(agentId?: string, logger?: (message: string, ...args: unknown[]) => void): BrainPort | undefined;

// Warning: (ae-internal-missing-underscore) The name "createBrainRecallImpl" should be prefixed with an underscore because the declaration is marked as @internal
//
```

### `createBudgetState`

```typescript
export function createBudgetState(overrides?: Partial<AgentBudgetState>): AgentBudgetState;
```

### `createBulkhead`

```typescript
export function createBulkhead<T>(opts: OrchestrationBulkheadOptions): BulkheadPool<T>;
```

### `createBullMQRunner`

```typescript
export function createBullMQRunner(config: BullMQRunnerConfig): BullMQRunner;
```

### `createCapabilityTierRegistry`

```typescript
export function createCapabilityTierRegistry(options?: CapabilityTierRegistryOptions): CapabilityTierRegistry;
```

### `createCitadelCampaignMcpAdapter`

```typescript
export function createCitadelCampaignMcpAdapter(client: CitadelCampaignMcpClient): CitadelCampaignPort;
```

### `createCoherenceDetector`

```typescript
export function createCoherenceDetector(config?: {
    loopDetectionWindow?: number;
    stallThreshold?: number;
}): CoherenceDetector;
```

### `createCompactor`

```typescript
export function createCompactor(config?: CompactorConfig): {
    maybeCompact: (log: LogMessage[], budget: AgentBudgetState, llmFn: (prompt: string) => Promise<string>, indexFor?: (msg: LogMessage) => number | undefined) => Promise<CompactionOutcome>;
};
```

### `createComplexAgent`

```typescript
export function createComplexAgent<TObs, TOrient, TDecision, TAction, TFeedback>(deps: AgentFactoryDeps, opts: ComplexAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback>): Promise<OODAAgent>;

// Warning: (ae-missing-release-tag) "createCostAccountingPort" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `createCostAccountingPort`

```typescript
export function createCostAccountingPort(impl: LLMProviderPort, options?: CostAccountingOptions): CostAccountingPort;

// Warning: (ae-forgotten-export) The symbol "DiscordAdapterOptions" needs to be exported by the entry point index.d.ts
//
```

### `createDiscordAdapter`

```typescript
export function createDiscordAdapter(opts: DiscordAdapterOptions): GatewayAdapter;
```

### `createEd25519Signer`

```typescript
export function createEd25519Signer(privateKey: KeyObject): SignFn;
```

### `createEd25519Verifier`

```typescript
export function createEd25519Verifier(publicKey: KeyObject): VerifyFn;
```

### `createGateway`

```typescript
export function createGateway(opts: GatewayOptions): GatewayHandle;
```

### `createHttpBrainAdapter`

```typescript
export function createHttpBrainAdapter(opts: HttpBrainAdapterOptions): BrainPort;
```

### `createMaxInputLengthGuard`

```typescript
export function createMaxInputLengthGuard(maxChars: number): GuardrailDef<string>;
```

### `createMeshDelegate`

```typescript
export function createMeshDelegate(dispatcher: MeshDispatcher): <T = string>(options: DelegateOptions) => Promise<DelegateResult<T>>;
```

### `createMultiBrainPort`

```typescript
export function createMultiBrainPort(opts: MultiBrainPortOptions): MultiBrainPort;
```

### `createMultiBrainPortFromEnv`

```typescript
export function createMultiBrainPortFromEnv(env?: Record<string, string | undefined>, opts?: MultiBrainFromEnvOptions): MultiBrainPort | undefined;

// Warning: (ae-forgotten-export) The symbol "SlackCallbackHandlerOpts" needs to be exported by the entry point index.d.ts
//
```

### `createNodeSlackCallbackHandler`

```typescript
export function createNodeSlackCallbackHandler(opts: SlackCallbackHandlerOpts): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```

### `createOneShotStrategy`

```typescript
export function createOneShotStrategy(): AgentStrategy;
```

### `createOODAAgent`

```typescript
export function createOODAAgent<TConfig = unknown, TObs = unknown, TOrient = unknown, TDecision = unknown, TAction = unknown, TFeedback = unknown>(config: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>): OODAAgent;
```

### `createOODAStrategy`

```typescript
export function createOODAStrategy(invoker: OODACycleInvoker): AgentStrategy;

// Warning: (ae-forgotten-export) The symbol "OtelClientOptions" needs to be exported by the entry point index.d.ts
//
```

### `createOtelClient`

```typescript
export function createOtelClient(opts: OtelClientOptions): OtelClient;
```

### `createOutcomesClient`

```typescript
export function createOutcomesClient(opts: OutcomesClientOptions): OutcomesClient;
```

### `createPipelinesClient`

```typescript
export function createPipelinesClient(_opts: PipelinesClientOptions): PipelinesClient;
```

### `createPlanStrategy`

```typescript
export function createPlanStrategy(): AgentStrategy;

// Warning: (ae-forgotten-export) The symbol "ProviderRouterOptions" needs to be exported by the entry point index.d.ts
//
```

### `createProviderRouter`

```typescript
export function createProviderRouter(opts?: ProviderRouterOptions): ProviderRouter;
```

### `createPublisherRegistry`

```typescript
export function createPublisherRegistry(input: PublisherRegistryInput): PublisherRegistry;
```

### `createReactStrategy`

```typescript
export function createReactStrategy(): AgentStrategy;

// Warning: (ae-forgotten-export) The symbol "ReasoningAgentOptions" needs to be exported by the entry point index.d.ts
//
```

### `createReasoningAgent`

```typescript
export function createReasoningAgent<TObs, TOrient, TDecision, TAction, TFeedback>(deps: AgentFactoryDeps, opts: ReasoningAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback>): Promise<OODAAgent>;

// Warning: (ae-forgotten-export) The symbol "RecallParams" needs to be exported by the entry point index.d.ts
//
```

### `createRecallTool`

```typescript
export function createRecallTool(journal: RunJournalPort): AgentTool<typeof RecallParams>;

// Warning: (ae-forgotten-export) The symbol "RemoteApprovalOptions" needs to be exported by the entry point index.d.ts
//
```

### `createRemoteApprovalChannel`

```typescript
export function createRemoteApprovalChannel(opts: RemoteApprovalOptions): RemoteApprovalChannel;

// Warning: (ae-forgotten-export) The symbol "RemoteControlHubOptions" needs to be exported by the entry point index.d.ts
//
```

### `createRemoteControlHub`

```typescript
export function createRemoteControlHub(opts?: RemoteControlHubOptions): RemoteControlPort;
```

### `createRemoteControlServer`

```typescript
export function createRemoteControlServer(port: RemoteControlPort, opts?: RemoteControlServerOptions): Promise<RemoteControlServerHandle>;
```

### `createRunsClient`

```typescript
export function createRunsClient(opts: RunsClientOptions): RunsClient;

// Warning: (ae-forgotten-export) The symbol "SimpleAgentOptions" needs to be exported by the entry point index.d.ts
//
```

### `createSimpleAgent`

```typescript
export function createSimpleAgent<TContext, TOrient, TFeedback>(deps: AgentFactoryDeps, opts: SimpleAgentOptions<TContext, TOrient, TFeedback>): Promise<OODAAgent>;
```

### `createSkillContext`

```typescript
export function createSkillContext(opts: CreateSkillContextOptions): SkillContext;
```

### `CreateSkillContextOptions`

```typescript
export interface CreateSkillContextOptions {
    db: DbClient;
    dryRunMocks?: Record<string, (input: unknown) => unknown>;
    executionId?: string;
    isReplay?: boolean;
    logger: LoggerPort;
    progress?: ProgressCallback;
    secrets?: SecretsAccessor;
    startedAt?: Date;
    timeoutSeconds?: number;
}

// Warning: (ae-forgotten-export) The symbol "SlackAdapterOptions" needs to be exported by the entry point index.d.ts
//
```

### `createSlackAdapter`

```typescript
export function createSlackAdapter(opts: SlackAdapterOptions): GatewayAdapter;

// Warning: (ae-forgotten-export) The symbol "TelegramAdapterOptions" needs to be exported by the entry point index.d.ts
//
```

### `createTelegramAdapter`

```typescript
export function createTelegramAdapter(opts: TelegramAdapterOptions): GatewayAdapter;
```

### `createTelemetryBus`

```typescript
export function createTelemetryBus(opts: TelemetryBusOptions): TelemetrySink & {
    counters: TelemetryCounters;
    flush(): Promise<void>;
};
```

### `createUnconfiguredOODAInvoker`

```typescript
export function createUnconfiguredOODAInvoker(): OODACycleInvoker;
```

### `CriticalRule`

```typescript
export interface CriticalRule {
    readonly id: string;
    readonly when: (c: ProactiveCandidate) => boolean;
}
```

### `CriticHistoryEntry`

```typescript
export interface CriticHistoryEntry {
    discrepancy: string;
    round: number;
}
```

### `criticLoop`

```typescript
export function criticLoop<T>(initial: T, verify: CriticVerifier<T>, revise: (current: T, discrepancy: string) => Promise<T>, maxRounds?: number): Promise<CriticResult<T>>;
```

### `CriticResult`

```typescript
export interface CriticResult<T> {
    history: CriticHistoryEntry[];
    output: T;
    rounds: number;
    verified: boolean;
}
```

### `CriticVerifier`

```typescript
export type CriticVerifier<T> = (output: T) => Promise<{
    ok: true;
} | {
    ok: false;
    discrepancy: string;
}>;
```

### `cronSessionGuard`

```typescript
export function cronSessionGuard(expr: string): SessionGuard;
```

### `CryptoRandomDuringReplayError`

```typescript
export class CryptoRandomDuringReplayError extends Error {
    constructor();
}
```

### `CycleCost`

```typescript
export interface CycleCost {
    category?: string;
    costUsd: number;
    durationMs: number;
    inputTokens: number;
    modelTier: string;
    outcomeValue?: number;
    outputTokens: number;
    runId: string;
    skillId?: string;
}
```

### `CycleEvent`

```typescript
export type CycleEvent = CycleEventV010 | CycleEventV011;
```

### `CycleEventV010`

```typescript
export type CycleEventV010 = {
    type: "phase_start";
    runId: string;
    cycleIndex: number;
    phase: string;
    ts: number;
} | {
    type: "phase_complete";
    runId: string;
    cycleIndex: number;
    phase: string;
    durationMs: number;
    ts: number;
} | {
    type: "phase_error";
    runId: string;
    cycleIndex: number;
    phase: string;
    error: {
        message: string;
    };
    ts: number;
} | {
    type: "guard_tripped";
    runId: string;
    cycleIndex: number;
    guard: string;
    reason: string;
    ts: number;
} | {
    type: "hitl_waiting";
    runId: string;
    cycleIndex: number;
    stepId: string;
    payloadHash: string;
    ts: number;
} | {
    type: "hitl_approved";
    runId: string;
    cycleIndex: number;
    stepId: string;
    ts: number;
} | {
    type: "cycle_complete";
    runId: string;
    cycleIndex: number;
    status: CycleStatus;
    durationMs: number;
    ts: number;
} | {
    type: "cycle_skipped";
    runId: string;
    cycleIndex: number;
    reason: string;
    ts: number;
} | {
    type: "cycle_error";
    runId: string;
    cycleIndex: number;
    error: {
        message: string;
    };
    ts: number;
} | {
    type: "timestamp_pending";
    runId: string;
    cycleIndex: number;
    rootHash: string;
    ts: number;
};
```

### `CycleEventV011`

```typescript
export type CycleEventV011 = {
    type: "guardrail_violated";
    runId: string;
    cycleIndex: number;
    phase: string;
    timing: "pre-phase" | "post-phase";
    proofHash: string;
    reason: string;
    ts: number;
} | {
    type: "handoff_initiated";
    runId: string;
    cycleIndex: number;
    targetAgentId: string;
    childRunId: string;
    handoffChain: string[];
    ts: number;
} | {
    type: "cycle_proven";
    runId: string;
    cycleIndex: number;
    rootHash: string;
    entriesCount: number;
    proofChainRef: string;
    ts: number;
};
```

### `CycleMetadata`

```typescript
export interface CycleMetadata {
    [key: string]: unknown;
    audit_trail_complete?: boolean;
    error_paths_explicit?: boolean;
    has_fallback?: boolean;
    hash_primitive?: string;
    is_idempotent?: boolean;
    model_name?: string;
    model_provider?: string;
    pii_redacted?: boolean;
    regulatory_scope?: string;
    rso_veto?: boolean;
    slsa_level?: number;
    source_count?: number;
    timeouts_configured?: boolean;
}
```

### `CycleSnapshot`

```typescript
export interface CycleSnapshot {
    budgetUsdMax: number;
    budgetUsdSpent: number;
    metadata?: CycleMetadata;
    parentRunId?: string;
    rootHash: string;
    runId: string;
    scope_id?: string;
    steps: CycleStep[];
}
```

### `cycleSnapshotSchema`

```typescript
export const cycleSnapshotSchema: z.ZodObject<{
    runId: z.ZodString;
    parentRunId: z.ZodOptional<z.ZodString>;
    steps: z.ZodArray<z.ZodObject<{
        index: z.ZodNumber;
        phase: z.ZodString;
        type: z.ZodString;
        output: z.ZodOptional<z.ZodUnknown>;
        storedInput: z.ZodOptional<z.ZodUnknown>;
        model: z.ZodOptional<z.ZodObject<{
            provider: z.ZodString;
            name: z.ZodString;
            version: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            version: string;
            name: string;
        }, {
            provider: string;
            version: string;
            name: string;
        }>>;
        toolName: z.ZodOptional<z.ZodString>;
        costUsd: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        phase: string;
        index: number;
        model?: {
            provider: string;
            version: string;
            name: string;
        } | undefined;
        costUsd?: number | undefined;
        toolName?: string | undefined;
        output?: unknown;
        storedInput?: unknown;
    }, {
        type: string;
        phase: string;
        index: number;
        model?: {
            provider: string;
            version: string;
            name: string;
        } | undefined;
        costUsd?: number | undefined;
        toolName?: string | undefined;
        output?: unknown;
        storedInput?: unknown;
    }>, "many">;
    budgetUsdMax: z.ZodNumber;
    budgetUsdSpent: z.ZodNumber;
    scope_id: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodObject<{
        rso_veto: z.ZodOptional<z.ZodBoolean>;
        hash_primitive: z.ZodOptional<z.ZodString>;
        has_fallback: z.ZodOptional<z.ZodBoolean>;
        is_idempotent: z.ZodOptional<z.ZodBoolean>;
        source_count: z.ZodOptional<z.ZodNumber>;
        model_provider: z.ZodOptional<z.ZodString>;
        model_name: z.ZodOptional<z.ZodString>;
        slsa_level: z.ZodOptional<z.ZodNumber>;
        timeouts_configured: z.ZodOptional<z.ZodBoolean>;
        error_paths_explicit: z.ZodOptional<z.ZodBoolean>;
        pii_redacted: z.ZodOptional<z.ZodBoolean>;
        audit_trail_complete: z.ZodOptional<z.ZodBoolean>;
        regulatory_scope: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        rso_veto: z.ZodOptional<z.ZodBoolean>;
        hash_primitive: z.ZodOptional<z.ZodString>;
        has_fallback: z.ZodOptional<z.ZodBoolean>;
        is_idempotent: z.ZodOptional<z.ZodBoolean>;
        source_count: z.ZodOptional<z.ZodNumber>;
        model_provider: z.ZodOptional<z.ZodString>;
        model_name: z.ZodOptional<z.ZodString>;
        slsa_level: z.ZodOptional<z.ZodNumber>;
        timeouts_configured: z.ZodOptional<z.ZodBoolean>;
        error_paths_explicit: z.ZodOptional<z.ZodBoolean>;
        pii_redacted: z.ZodOptional<z.ZodBoolean>;
        audit_trail_complete: z.ZodOptional<z.ZodBoolean>;
        regulatory_scope: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        rso_veto: z.ZodOptional<z.ZodBoolean>;
        hash_primitive: z.ZodOptional<z.ZodString>;
        has_fallback: z.ZodOptional<z.ZodBoolean>;
        is_idempotent: z.ZodOptional<z.ZodBoolean>;
        source_count: z.ZodOptional<z.ZodNumber>;
        model_provider: z.ZodOptional<z.ZodString>;
        model_name: z.ZodOptional<z.ZodString>;
        slsa_level: z.ZodOptional<z.ZodNumber>;
        timeouts_configured: z.ZodOptional<z.ZodBoolean>;
        error_paths_explicit: z.ZodOptional<z.ZodBoolean>;
        pii_redacted: z.ZodOptional<z.ZodBoolean>;
        audit_trail_complete: z.ZodOptional<z.ZodBoolean>;
        regulatory_scope: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>>;
    rootHash: z.ZodString;
}, "strict", z.ZodTypeAny, {
    runId: string;
    rootHash: string;
    steps: {
        type: string;
        phase: string;
        index: number;
        model?: {
            provider: string;
            version: string;
            name: string;
        } | undefined;
        costUsd?: number | undefined;
        toolName?: string | undefined;
        output?: unknown;
        storedInput?: unknown;
    }[];
    budgetUsdMax: number;
    budgetUsdSpent: number;
    metadata?: z.objectOutputType<{
        rso_veto: z.ZodOptional<z.ZodBoolean>;
        hash_primitive: z.ZodOptional<z.ZodString>;
        has_fallback: z.ZodOptional<z.ZodBoolean>;
        is_idempotent: z.ZodOptional<z.ZodBoolean>;
        source_count: z.ZodOptional<z.ZodNumber>;
        model_provider: z.ZodOptional<z.ZodString>;
        model_name: z.ZodOptional<z.ZodString>;
        slsa_level: z.ZodOptional<z.ZodNumber>;
        timeouts_configured: z.ZodOptional<z.ZodBoolean>;
        error_paths_explicit: z.ZodOptional<z.ZodBoolean>;
        pii_redacted: z.ZodOptional<z.ZodBoolean>;
        audit_trail_complete: z.ZodOptional<z.ZodBoolean>;
        regulatory_scope: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    parentRunId?: string | undefined;
    scope_id?: string | undefined;
}, {
    runId: string;
    rootHash: string;
    steps: {
        type: string;
        phase: string;
        index: number;
        model?: {
            provider: string;
            version: string;
            name: string;
        } | undefined;
        costUsd?: number | undefined;
        toolName?: string | undefined;
        output?: unknown;
        storedInput?: unknown;
    }[];
    budgetUsdMax: number;
    budgetUsdSpent: number;
    metadata?: z.objectInputType<{
        rso_veto: z.ZodOptional<z.ZodBoolean>;
        hash_primitive: z.ZodOptional<z.ZodString>;
        has_fallback: z.ZodOptional<z.ZodBoolean>;
        is_idempotent: z.ZodOptional<z.ZodBoolean>;
        source_count: z.ZodOptional<z.ZodNumber>;
        model_provider: z.ZodOptional<z.ZodString>;
        model_name: z.ZodOptional<z.ZodString>;
        slsa_level: z.ZodOptional<z.ZodNumber>;
        timeouts_configured: z.ZodOptional<z.ZodBoolean>;
        error_paths_explicit: z.ZodOptional<z.ZodBoolean>;
        pii_redacted: z.ZodOptional<z.ZodBoolean>;
        audit_trail_complete: z.ZodOptional<z.ZodBoolean>;
        regulatory_scope: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    parentRunId?: string | undefined;
    scope_id?: string | undefined;
}>;
```

### `CycleStatus`

```typescript
export type CycleStatus = "succeeded" | "failed" | "skipped";
```

### `CycleStep`

```typescript
export interface CycleStep {
    costUsd?: number;
    index: number;
    model?: {
        provider: string;
        name: string;
        version: string;
    };
    output?: unknown;
    phase: string;
    storedInput?: unknown;
    toolName?: string;
    type: string;
}

// Warning: (ae-missing-release-tag) "DagNodeSpec" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DagNodeSpec`

```typescript
export interface DagNodeSpec {
    readonly dependsOn?: readonly string[];
    readonly grant?: {
        readonly tools?: readonly string[];
        readonly maxSteps?: number;
    };
    readonly id: string;
    readonly mapOver?: string;
    readonly maxTimeoutRetries?: number;
    readonly model?: string;
    readonly runIf?: (inputs: NodeInputs) => boolean;
    readonly samples?: number;
    readonly task: string;
    readonly timeoutMs?: number;
}

// Warning: (ae-missing-release-tag) "DagRunInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DagRunInput`

```typescript
export interface DagRunInput<TOutput = unknown> {
    readonly adrEco: string;
    readonly bestOfN?: AdaptiveBestOfNPolicy;
    readonly clock: ClockPort;
    readonly defaultMaxTimeoutRetries?: number;
    readonly executor: NodeExecutor<TOutput>;
    readonly journal?: StepJournal<TOutput>;
    readonly maxConcurrency?: number;
    readonly maxReplans?: number;
    readonly nodes: readonly DagNodeSpec[];
    readonly progress?: WorkflowProgressSink<TOutput>;
    readonly replanner?: RePlanner<TOutput>;
    readonly runId: string;
    readonly signal?: AbortSignal;
    readonly verifier?: Verifier_2<TOutput>;
}

// Warning: (ae-missing-release-tag) "DagRunManifest" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DagRunManifest`

```typescript
export interface DagRunManifest<TOutput = unknown> {
    readonly nodes: ReadonlyArray<NodeManifestEntry<TOutput>>;
    readonly rootHash: string;
    readonly summary: {
        readonly total: number;
        readonly done: number;
        readonly deferred: number;
        readonly failed: number;
    };
    readonly workflowStatus: "DONE" | "FAILED";
}

// Warning: (ae-missing-release-tag) "DagSchedulerError" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DagSchedulerError`

```typescript
export class DagSchedulerError extends Error {
    constructor(reason: string);
}
```

### `dangerousToRiskVector`

```typescript
export function dangerousToRiskVector(dangerous?: boolean): RiskVector;
```

### `DataClass`

```typescript
export type DataClass = "public" | "internal" | "confidential" | "secret";
```

### `__unknown`

```typescript
interface DbClient {
    query<T extends object>(sql: string, params?: unknown[]): Promise<{
        rows: T[];
        rowCount?: number;
    }>;
}
export { DbClient }
export { DbClient as DbPort }
```

### `DbConnectionLost`

```typescript
export class DbConnectionLost extends PortError {
    constructor(message?: string, cause?: unknown);
    readonly port = "db";
}
```

### `DbConnectionLostError`

```typescript
export class DbConnectionLostError extends Error {
    constructor(message: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
}
```

### `DbQueryError`

```typescript
export class DbQueryError extends PortError {
    constructor(opts: {
        message: string;
        cause?: unknown;
        sqlPreview?: string;
    });
    readonly port = "db";
    readonly sqlPreview?: string;
}
```

### `DbQueryTimeoutError`

```typescript
export class DbQueryTimeoutError extends Error {
    constructor(message: string, queryPreview: string, timeoutMs: number, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly queryPreview: string;
    readonly timeoutMs: number;
}
```

### `DeadlineExceededError`

```typescript
export class DeadlineExceededError extends Error {
    constructor(message?: string);
    readonly name = "DeadlineExceededError";
}
```

### `DebateConfig`

```typescript
export interface DebateConfig {
    context?: string;
    maxRounds?: number;
    question: string;
    skeptic: (question: string, thesis: DebateStance, context?: string) => Promise<DebateStance>;
    strategist: (question: string, context?: string) => Promise<DebateStance>;
    synthesizer: (question: string, thesis: DebateStance, antithesis: DebateStance, context?: string) => Promise<DebateSynthesis>;
}
```

### `DebateResult`

```typescript
export interface DebateResult {
    antithesis: DebateStance;
    rounds: number;
    synthesis: DebateSynthesis;
    thesis: DebateStance;
}
```

### `DebateStance`

```typescript
export interface DebateStance {
    confidence: number;
    content: string;
    keyPoints: string[];
    risks: string[];
}
```

### `DebateSynthesis`

```typescript
export interface DebateSynthesis {
    conclusion: string;
    consensusScore: number;
    hitlRecommended: boolean;
    recommendation: string;
    tradeoffs: string[];
}
```

### `DecayCompactionConfig`

```typescript
export interface DecayCompactionConfig {
    errorBonus?: number;
    halfLifeTurns?: number;
    keepTopK?: number;
}

// Warning: (ae-missing-release-tag) "decideProvably" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `decideProvably`

```typescript
export function decideProvably<I, O>(args: {
    policyId: string;
    policyVersion: string;
    policy: DeterministicPolicy<I, O>;
    input: I;
    adrEco: string;
}): GovernedDecision<I, O>;

// Warning: (ae-missing-release-tag) "decisionAnchorPreimage" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `decisionAnchorPreimage`

```typescript
export function decisionAnchorPreimage(p: {
    id: string;
    agentId: string;
    policyId: string;
    policyVersion: string;
    input: unknown;
    output: unknown;
    decidedAt: string;
}): Record<string, unknown>;
```

### `DecisionClaim`

```typescript
export interface DecisionClaim {
    readonly archived_to_brain: boolean;
    readonly cascade_triggered?: boolean;
    readonly created_at: Date;
    readonly decision_id: string;
}

// Warning: (ae-missing-release-tag) "DecisionGrade" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DecisionGrade`

```typescript
export type DecisionGrade = "A0" | "A1" | "A3";
```

### `DecisionInput`

```typescript
export interface DecisionInput {
    readonly chosen: string;
    readonly context: string;
    readonly decision: string;
    readonly options: readonly string[];
    readonly rationale: string;
    readonly tags?: readonly string[];
}
```

### `decodePairingPayload`

```typescript
export function decodePairingPayload(uri: string): PairingPayload;
```

### `decomposeTask`

```typescript
export function decomposeTask(task: string, decomposer: (task: string) => Promise<Plan>): Promise<Plan>;
```

### `DEFAULT_BACKOFF_MS`

```typescript
export const DEFAULT_BACKOFF_MS: readonly [30000, number, number, number, number];
```

### `DEFAULT_CAPABILITY_TIER_CLASSIFICATION`

```typescript
export const DEFAULT_CAPABILITY_TIER_CLASSIFICATION: CapabilityTierClassification;
```

### `DEFAULT_CHILD_MAX_STEPS`

```typescript
export const DEFAULT_CHILD_MAX_STEPS = 30;
```

### `DEFAULT_INSTRUCTION_PATTERNS`

```typescript
export const DEFAULT_INSTRUCTION_PATTERNS: RegExp[];
```

### `DEFAULT_PERSONA`

```typescript
export const DEFAULT_PERSONA: AgentPersona;
```

### `DEFAULT_POLICIES`

```typescript
export const DEFAULT_POLICIES: Record<string, AxiomPolicy>;
```

### `DEFAULT_PROTOCOL_MODE`

```typescript
export const DEFAULT_PROTOCOL_MODE = "execute";
```

### `DEFAULT_RECENCY_HALFLIFE_MS`

```typescript
export const DEFAULT_RECENCY_HALFLIFE_MS: number;
```

### `DEFAULT_RESOURCE_LIMITS`

```typescript
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits>;
```

### `DEFAULT_RRF_WEIGHTS`

```typescript
export const DEFAULT_RRF_WEIGHTS: {
    readonly cosine: 0.5;
    readonly recency: 0.3;
    readonly importance: 0.2;
};
```

### `DEFAULT_SEPOLIA_RPC_URL`

```typescript
export const DEFAULT_SEPOLIA_RPC_URL = "https://sepolia.rpc.vauban.tech/rpc/v0_10";
```

### `defaultCoherenceModel`

```typescript
export function defaultCoherenceModel(): CoherenceModel;
```

### `DefaultMeshDispatcher`

```typescript
export class DefaultMeshDispatcher implements MeshDispatcher {
    constructor(config?: DispatcherConfig);
    classify(need: string): MeshAgentKind;
    dispatch(intent: DispatchIntent): Promise<DispatchResult>;
}
```

### `defaultPolicy`

```typescript
export function defaultPolicy(env: "dev" | "prod", piiFields?: readonly string[]): PayloadPolicy;
```

### `defaultScorerRegistry`

```typescript
export const defaultScorerRegistry: ScorerRegistry;
```

### `DefaultTierPolicy`

```typescript
export class DefaultTierPolicy implements TierPolicy {
    tiersFor(category: string, _mode: "degraded" | "full"): ModelTier[];
}
```

### `DegradedMetrics`

```typescript
export interface DegradedMetrics {
    readonly episodes_count: number;
    readonly pct_time_degraded: number;
    readonly total_degraded_last_90d: number;
}
```

### `DegradedModeExhaustedError`

```typescript
export class DegradedModeExhaustedError extends Error {
    constructor(tenantId: string, totalDegradedSeconds: number, capSeconds: number);
    readonly capSeconds: number;
    readonly tenantId: string;
    readonly totalDegradedSeconds: number;
}
```

### `DegradedResponse`

```typescript
export interface DegradedResponse {
    readonly fallback: "UNGROUNDED";
    readonly reason: string;
    readonly stale_since: string;
    readonly status: "degraded";
}
```

### `delegate`

```typescript
export function delegate(input: DelegateInput): Promise<DelegationPlan>;
```

### `DelegateAttenuationError`

```typescript
export class DelegateAttenuationError extends Error {
    readonly name = "DelegateAttenuationError";
}
```

### `DelegateChunk`

```typescript
export interface DelegateChunk {
    readonly agentKind?: MeshAgentKind;
    readonly done: boolean;
    readonly text: string;
}
```

### `DelegateInput`

```typescript
export interface DelegateInput {
    readonly adrEco?: string;
    readonly clock: ClockPort;
    readonly dangerousTools?: readonly string[];
    readonly grant?: DelegationGrant;
    readonly parentTools: readonly string[];
    readonly runId: string;
    readonly task: string;
}
```

### `DelegateOptions`

```typescript
export interface DelegateOptions {
    readonly capabilities?: ReadonlyArray<string>;
    readonly childId?: string;
    readonly clock?: ClockPort;
    readonly context?: string | Record<string, unknown>;
    readonly deadline_ms?: number;
    readonly kind?: MeshAgentKind;
    readonly max_cost_eur?: number;
    readonly need: string;
    readonly onChunk?: (chunk: DelegateChunk) => void;
    readonly parentToken?: AttenuatedToken;
    readonly toolArgs?: unknown;
    readonly toolName?: string;
}
```

### `DelegateResult`

```typescript
export interface DelegateResult<T = string> {
    readonly agentKind: MeshAgentKind;
    readonly auditStep?: unknown;
    readonly childToken?: AttenuatedToken;
    readonly costEur: number;
    readonly delegationChain: ReadonlyArray<MeshDelegationLink>;
    readonly durationMs: number;
    readonly output: T;
    readonly truncated: boolean;
}
```

### `DELEGATION_ADR`

```typescript
export const DELEGATION_ADR = "ADR-ECO-076";
```

### `DelegationChainTooDeepError`

```typescript
export class DelegationChainTooDeepError extends Error {
    constructor(claimId: string, depth: number, maxDepth: number);
    readonly claimId: string;
    readonly depth: number;
    readonly maxDepth: number;
}
```

### `DelegationClaim`

```typescript
export interface DelegationClaim {
    readonly created_at: string;
    readonly ed25519_sig: string;
    readonly holder: string;
    readonly id: string;
    readonly issuer: string;
    readonly parent_id?: string;
    readonly revoked_at?: string | null;
    readonly scope: CapabilityScope;
    readonly ttl: number;
}
```

### `DelegationExpiredError`

```typescript
export class DelegationExpiredError extends Error {
    constructor(claimId: string, expiresAt: string);
    readonly claimId: string;
    readonly expiresAt: string;
}
```

### `DelegationGrant`

```typescript
export interface DelegationGrant {
    readonly maxSteps?: number;
    readonly tools?: readonly string[];
}
```

### `DelegationNotNarrowingError`

```typescript
export class DelegationNotNarrowingError extends Error {
    constructor(parentId: string, childId: string, violationType: string);
    readonly childId: string;
    readonly parentId: string;
    readonly violationType: string;
}
```

### `DelegationPlan`

```typescript
export interface DelegationPlan {
    readonly actionGate: ActionGate;
    readonly allowed: boolean;
    readonly attenuatedTools: readonly string[];
    readonly auditStep: BatteryTraceStep;
    readonly maxSteps: number;
    readonly reason: string;
    readonly systemPrompt: string;
}
```

### `DelegationPort`

```typescript
export interface DelegationPort {
    getChain(claimId: string): Promise<DelegationClaim[]>;
    getClaim(claimId: string): Promise<DelegationClaim | null>;
    getDescendants(claimId: string): Promise<DelegationClaim[]>;
    isRevoked(claimId: string): Promise<boolean>;
    // Warning: (ae-forgotten-export) The symbol "RootCapability" needs to be exported by the entry point index.d.ts
    mintDelegation(parent: DelegationClaim | RootCapability, narrowed: CapabilityScope, opts?: {
        ttl?: number;
        issuerId?: string;
        holderId?: string;
    }): Promise<DelegationClaim>;
    // Warning: (ae-forgotten-export) The symbol "RevocationOpts" needs to be exported by the entry point index.d.ts
    revoke(claimId: string, opts?: RevocationOpts): Promise<number>;
    // Warning: (ae-forgotten-export) The symbol "VerifyChainResult_2" needs to be exported by the entry point index.d.ts
    verifyChain(claim: DelegationClaim): Promise<VerifyChainResult_2>;
}
```

### `DelegationRevokedError`

```typescript
export class DelegationRevokedError extends Error {
    constructor(claimId: string, revokedAt: string, reason?: string | undefined);
    readonly claimId: string;
    readonly reason?: string | undefined;
    readonly revokedAt: string;
}
```

### `DepositParams`

```typescript
export interface DepositParams {
    readonly amount: string;
    readonly token: TokenAddress;
    // Warning: (ae-forgotten-export) The symbol "VaultAddress" needs to be exported by the entry point index.d.ts
    //
    readonly vault_address: VaultAddress;
}
```

### `DepositResult`

```typescript
export interface DepositResult {
    readonly deposit_amount: string;
    readonly shares_minted: string;
    readonly tx_hash: string;
}
```

### `deprecated`

```typescript
export function deprecated(apiName: string, options?: DeprecationOptions): void;
```

### `DeprecationOptions`

```typescript
export interface DeprecationOptions {
    emit?: (message: string) => void;
    note?: string;
    removeIn?: string;
    replacement?: string;
    since?: string;
}
```

### `DepsValidationError`

```typescript
export class DepsValidationError extends Error {
    constructor(message: string);
}

// Warning: (ae-missing-release-tag) "DeterministicPolicy" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DeterministicPolicy`

```typescript
export type DeterministicPolicy<I, O> = (input: I) => O;
```

### `DifficultyClass`

```typescript
export type DifficultyClass = "simple" | "standard" | "complex" | "reasoning";
```

### `DiscordChannel`

```typescript
export class DiscordChannel implements MessagingChannelPort {
    constructor(config: DiscordChannelConfig);
    sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
    sendMessage(target: string, text: string): Promise<void>;
}
```

### `DiscordChannelConfig`

```typescript
export interface DiscordChannelConfig {
    webhookUrl: string;
}
```

### `DiscordPublisher`

```typescript
export class DiscordPublisher implements PublisherPort {
    constructor(cfg: DiscordPublisherConfig);
    readonly channel: "discord";
    isConfigured(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
}
```

### `DiscordPublisherConfig`

```typescript
export interface DiscordPublisherConfig {
    readonly webhookUrl: string;
}
```

### `DispatcherConfig`

```typescript
export interface DispatcherConfig {
    readonly classifier?: (need: string) => MeshAgentKind;
    readonly costPerMs?: number;
    readonly fallbackExecutor?: (intent: DispatchIntent) => Promise<string>;
    readonly llmExecutor?: (prompt: string, deadlineMs: number) => Promise<string>;
    readonly mcpTools?: Readonly<Record<string, (args: unknown) => Promise<string>>>;
    readonly oodaExecutor?: (need: string, context: string | undefined, deadlineMs: number) => Promise<string>;
    readonly pluginExecutor?: (need: string, context: string | undefined) => Promise<string>;
}
```

### `DispatchIntent`

```typescript
export interface DispatchIntent {
    readonly context?: string;
    readonly deadline_ms?: number;
    readonly kind: MeshAgentKind;
    readonly max_cost_eur?: number;
    readonly need: string;
    readonly toolArgs?: unknown;
    readonly toolName?: string;
}
```

### `DispatchResult`

```typescript
export interface DispatchResult {
    readonly costEur: number;
    readonly durationMs: number;
    readonly output: string;
    readonly truncated: boolean;
}
```

### `DlqJobPayload`

```typescript
export interface DlqJobPayload {
    attemptsMade: number;
    data?: unknown;
    failureReason: string;
    jobId: string | undefined;
    movedAt: string;
    originalQueue: string;
}
```

### `DomainEvent`

```typescript
export interface DomainEvent<T = unknown> {
    causationId?: string;
    correlationId: string;
    idempotencyKey: string;
    payload: T;
    schemaVersion: string;
    signature: string;
    source: EventSource_2;
    timestamp: string;
    type: string;
}
```

### `DomainSkillEntry`

```typescript
export interface DomainSkillEntry {
    readonly name: string;
    readonly skill: Skill;
}
```

### `DpopClaims`

```typescript
export interface DpopClaims {
    ath?: string;
    htm: string;
    htu: string;
    iat: number;
    jti: string;
}
```

### `DpopReplayStore`

```typescript
export class DpopReplayStore {
    constructor(opts?: {
        maxSize?: number;
    });
    isReplayed(jti: string, nowMs?: number): boolean;
    record(jti: string, expiresAtMs: number): void;
    reset(): void;
    get size(): number;
}
```

### `DpopValidationFailure`

```typescript
export interface DpopValidationFailure {
    reason: string;
    valid: false;
}
```

### `DpopValidationResult`

```typescript
export type DpopValidationResult = ValidatedDpop | DpopValidationFailure;

// Warning: (ae-missing-release-tag) "DRIFT_ANCHOR_ID" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DRIFT_ANCHOR_ID`

```typescript
export const DRIFT_ANCHOR_ID = "anti-drift-scope";

// Warning: (ae-missing-release-tag) "DriftArtifact" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `DriftArtifact`

```typescript
export interface DriftArtifact {
    readonly diff_base?: string;
    readonly diff_head?: string;
    readonly worktree?: string;
}
```

### `EconomicObserver`

```typescript
export interface EconomicObserver {
    getStats(agentId: string): Promise<{
        cost7d: number;
        value7d: number;
        roi: number;
        cycles: number;
    }>;
    recordCycle(agentId: string, tokenCostUsd: number, outcomeValueCents: number, confidence: number): Promise<void>;
    shouldThrottle(agentId: string): Promise<boolean>;
}
```

### `economicObserverGuard`

```typescript
export function economicObserverGuard(observer: EconomicObserver, agentId: string): RiskGuard;
```

### `EconomyMode`

```typescript
export type EconomyMode = "degraded" | "full";
```

### `EconomyRouter`

```typescript
export class EconomyRouter {
    constructor(config: EconomyRouterConfig);
    recordOutcome(runId: string, tier: ModelTier, inputTokens: number, outputTokens: number, durationMs: number, opts?: {
        skillId?: string;
        outcomeValue?: number;
        category?: string;
    }): void;
    route(category: string, opts?: {
        skillId?: string;
        budgetRemainingUsd?: number;
    }): RouteDecision;
    get routingRate(): number;
}
```

### `EconomyRouterConfig`

```typescript
export interface EconomyRouterConfig {
    breaker: FleetCircuitBreaker;
    budgetBuffer?: number;
    mode: EconomyMode;
    policy: TierPolicy;
    tracker: OutcomeTracker;
}
```

### `EconomyRouterOpts`

```typescript
export interface EconomyRouterOpts {
    defaultTier: ProviderTier["name"];
    eventBus?: EventBusPort;
    hourlyBudgetUsd: number;
    monthlyBudgetUsd: number;
    monthlyWindowMs?: number;
    _now?: () => number;
    onCircuitBreak?: (reason: string) => void;
    _tenantId?: string;
    tiers: ProviderTier[];
    windowMs?: number;
}
```

### `EcP256Jwk`

```typescript
export interface EcP256Jwk {
    alg?: "ES256";
    crv: "P-256";
    d?: never;
    kty: "EC";
    use?: "sig";
    x: string;
    y: string;
}
```

### `EmailPublisher`

```typescript
export class EmailPublisher implements PublisherPort {
    constructor(cfg: EmailPublisherConfig);
    readonly channel: "email";
    isConfigured(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
}
```

### `EmailPublisherConfig`

```typescript
export interface EmailPublisherConfig {
    readonly apiKey: string;
    readonly defaultFrom: string;
}
```

### `EmbedFn`

```typescript
export type EmbedFn = (text: string) => Promise<number[]>;
```

### `emergencyContextSummary`

```typescript
export function emergencyContextSummary(log: LogMessage[], summarize: (prompt: string) => Promise<string>, opts: {
    recursion: false;
}): Promise<string>;

// Warning: (ae-missing-release-tag) "emitAuditStep" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `emitAuditStep`

```typescript
export function emitAuditStep(decisionCore: unknown, adrEco: string): AuditStep;
```

### `EMPTY_SKILL_REGISTRY`

```typescript
export const EMPTY_SKILL_REGISTRY: SkillRegistry;
```

### `encodePairingPayload`

```typescript
export function encodePairingPayload(p: PairingPayload): string;
```

### `EnforcementLevel`

```typescript
export type EnforcementLevel = "block" | "warn" | "log";

// Warning: (ae-missing-release-tag) "ENGINE_GROUNDED_ANCHORS" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ENGINE_GROUNDED_ANCHORS`

```typescript
export const ENGINE_GROUNDED_ANCHORS: ReadonlySet<string>;

// Warning: (ae-missing-release-tag) "EngineVerdict" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `EngineVerdict`

```typescript
export interface EngineVerdict {
    readonly pass: boolean;
    readonly rationale: string;
}
```

### `EntryInclusion`

```typescript
export interface EntryInclusion {
    entry: SkillIndexEntry;
    leaf: string;
    proof: string[];
    root: string;
}
```

### `entryLeafHash`

```typescript
export function entryLeafHash(entry: SkillIndexEntry): string;
```

### `EnvelopeVerification`

```typescript
export interface EnvelopeVerification {
    readonly reasons: readonly string[];
    readonly valid: boolean;
}
```

### `EnvKeyProvider`

```typescript
export class EnvKeyProvider implements KeyProvider {
    constructor();
    getKey(keyId: string): Promise<Uint8Array>;
    hasColocationRisk(): boolean;
}
```

### `EpisodicAppendOptions`

```typescript
export interface EpisodicAppendOptions {
    artifacts?: string[];
    importanceScore?: number;
    metadata?: Record<string, unknown>;
    traceId?: string;
}
```

### `EpisodicCosineFn`

```typescript
export type EpisodicCosineFn = (entry: EpisodicMemoryEntry) => number;
```

### `EpisodicEvent`

```typescript
export interface EpisodicEvent {
    agentId: string;
    artifacts?: string[];
    content: string | Record<string, unknown>;
    createdAt: string;
    eventType: string;
    id: string;
    importanceScore: number;
    metadata?: Record<string, unknown>;
    sessionId: string;
}
```

### `EpisodicMemoryEntry`

```typescript
export interface EpisodicMemoryEntry {
    agentId: string;
    event: string;
    metadata?: Record<string, unknown>;
    runId: string;
    timestamp: number;
    traceId?: string;
}
```

### `EpisodicMemoryPort`

```typescript
export interface EpisodicMemoryPort {
    append(agentId: string, sessionId: string, eventType: string, content: string | Record<string, unknown>, opts?: EpisodicAppendOptions): Promise<string>;
    query(filter: EpisodicQueryFilter): Promise<EpisodicEvent[]>;
    queryByTrace(traceId: string, opts?: {
        limit?: number;
    }): Promise<EpisodicMemoryEntry[]>;
    record(agentId: string, runId: string, event: string, metadata?: Record<string, unknown>, opts?: {
        traceId?: string;
    }): Promise<void>;
    since(agentId: string, sinceMs: number, opts?: {
        limit?: number;
    }): Promise<EpisodicMemoryEntry[]>;
}
```

### `EpisodicQueryFilter`

```typescript
export interface EpisodicQueryFilter {
    agentId: string;
    eventTypes?: string[];
    limit?: number;
    minImportance?: number;
    sessionId?: string;
    timerangeEnd?: string;
    timerangeStart?: string;
}
```

### `Erc8004Registration`

```typescript
export interface Erc8004Registration {
    active: boolean;
    agentWallet: string;
    description: string;
    metadata?: Record<string, unknown>;
    name: string;
    registrations: string[];
    services: Erc8004Service[];
    supportedTrust: Erc8004Trust[];
    type: "agent" | "service";
}
```

### `Erc8004RegistrationInput`

```typescript
export interface Erc8004RegistrationInput {
    active?: boolean;
    agentWallet: string;
    description: string;
    metadata?: Record<string, unknown>;
    name: string;
    registrations?: string[];
    services: Erc8004Service[];
    supportedTrust: Erc8004Trust[];
    type: "agent" | "service";
}
```

### `Erc8004Service`

```typescript
export interface Erc8004Service {
    description?: string;
    type: "a2a" | "mcp" | "x402" | "webhook" | "http";
    url: string;
    x402Support?: Erc8004X402Support;
}
```

### `Erc8004Trust`

```typescript
export type Erc8004Trust = "reputation" | "tee-attestation" | "run-certificate";
```

### `Erc8004X402Support`

```typescript
export interface Erc8004X402Support {
    chains: string[];
    mode: Array<"DIRECT" | "DELEGATE">;
}
```

### `errorRunStep`

```typescript
export function errorRunStep(db: DbClient, stepId: string, error: Error): Promise<void>;
```

### `EscalationLevel`

```typescript
export type EscalationLevel = "L0" | "L1" | "L2" | "L3";
```

### `estimateDifficulty`

```typescript
export function estimateDifficulty(features: TaskFeatures): DifficultyClass;
```

### `EvalResult`

```typescript
export interface EvalResult {
    candidateId: string;
    deltaVsIncumbent: number;
    incumbentMeanScore: number;
    meanScore: number;
    passRate: number;
    pValue: number;
    significant: boolean;
    stddev: number;
    verifierSetSize: number;
}

// Warning: (ae-missing-release-tag) "evaluatePaymentAuthorization" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `evaluatePaymentAuthorization`

```typescript
export function evaluatePaymentAuthorization(policy: PaymentPolicy, facts: PaymentFacts): PaymentAuthorizationVerdict;
```

### `evaluateQualityGate`

```typescript
export function evaluateQualityGate(input: MarketingGateInput): MarketingGateResult;
```

### `EventBusPort`

```typescript
export interface EventBusPort {
    dlq(): {
        depth(): Promise<number>;
        replay(eventId: string): Promise<void>;
    };
    pendingCount(stream: string, consumerGroup: string): Promise<number>;
    publish(event: CloudEvent, stream: string): Promise<void>;
    publishWithIdempotency<T>(event: Omit<DomainEvent<T>, "signature">, key: string): Promise<void>;
    replayFrom(streamKey: string, fromId: string): AsyncIterable<DomainEvent>;
    subscribeDomain<T>(eventType: string, handler: (event: DomainEvent<T>) => Promise<void>, opts?: {
        groupId?: string;
        dlq?: string;
    }): Subscription;
}
```

### `EventFilter`

```typescript
export interface EventFilter {
    readonly [key: string]: unknown;
    readonly source?: string;
    readonly tenantId?: string;
    readonly type?: string;
}
```

### `EventPublishError`

```typescript
export class EventPublishError extends Error {
    constructor(message: string, stream: string, eventId: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly eventId: string;
    readonly stream: string;
}
```

### `EventSchemas`

```typescript
export const EventSchemas: {
    readonly "agent.started": z.ZodObject<{
        agentName: z.ZodString;
        runId: z.ZodString;
        inputs: z.ZodUnknown;
        tenantId: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        agentName: string;
        tenantId?: string | undefined;
        inputs?: unknown;
    }, {
        runId: string;
        agentName: string;
        tenantId?: string | undefined;
        inputs?: unknown;
    }>;
    readonly "agent.completed": z.ZodObject<{
        agentName: z.ZodString;
        runId: z.ZodString;
        outputs: z.ZodUnknown;
        durationMs: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        costUsd: number;
        durationMs: number;
        agentName: string;
        outputs?: unknown;
    }, {
        runId: string;
        costUsd: number;
        durationMs: number;
        agentName: string;
        outputs?: unknown;
    }>;
    readonly "agent.failed": z.ZodObject<{
        agentName: z.ZodString;
        runId: z.ZodString;
        error: z.ZodString;
        retryCount: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        error: string;
        runId: string;
        agentName: string;
        retryCount: number;
    }, {
        error: string;
        runId: string;
        agentName: string;
        retryCount: number;
    }>;
    readonly "agent.hitl_requested": z.ZodObject<{
        approvalId: z.ZodString;
        question: z.ZodString;
        deadline: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        question: string;
        approvalId: string;
        deadline: string;
    }, {
        question: string;
        approvalId: string;
        deadline: string;
    }>;
    readonly "agent.hitl_resolved": z.ZodObject<{
        approvalId: z.ZodString;
        decision: z.ZodEnum<["approved", "rejected"]>;
        by: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        decision: "rejected" | "approved";
        by: string;
        approvalId: string;
    }, {
        decision: "rejected" | "approved";
        by: string;
        approvalId: string;
    }>;
    readonly "incident.slo_burn": z.ZodObject<{
        slo: z.ZodString;
        burnRate: z.ZodNumber;
        severity: z.ZodEnum<["low", "medium", "high", "critical"]>;
    }, "strict", z.ZodTypeAny, {
        severity: "critical" | "low" | "medium" | "high";
        slo: string;
        burnRate: number;
    }, {
        severity: "critical" | "low" | "medium" | "high";
        slo: string;
        burnRate: number;
    }>;
    readonly "incident.detected": z.ZodObject<{
        source: z.ZodString;
        severity: z.ZodEnum<["low", "medium", "high", "critical"]>;
        summary: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        source: string;
        summary: string;
        severity: "critical" | "low" | "medium" | "high";
    }, {
        source: string;
        summary: string;
        severity: "critical" | "low" | "medium" | "high";
    }>;
    readonly "forge.inbox.reply_classified": z.ZodObject<{
        uid: z.ZodString;
        from: z.ZodString;
        subject: z.ZodString;
        type: z.ZodEnum<["INTERESTED", "NOT_INTERESTED", "BOUNCE", "SPAM", "OTHER"]>;
        priority: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
        signal: z.ZodString;
        nextAction: z.ZodString;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "INTERESTED" | "NOT_INTERESTED" | "BOUNCE" | "SPAM" | "OTHER";
        timestamp: string;
        schemaVersion: string;
        signal: string;
        priority: "HIGH" | "MEDIUM" | "LOW";
        from: string;
        subject: string;
        uid: string;
        nextAction: string;
    }, {
        type: "INTERESTED" | "NOT_INTERESTED" | "BOUNCE" | "SPAM" | "OTHER";
        timestamp: string;
        schemaVersion: string;
        signal: string;
        priority: "HIGH" | "MEDIUM" | "LOW";
        from: string;
        subject: string;
        uid: string;
        nextAction: string;
    }>;
    readonly "forge.lead.qualified": z.ZodObject<{
        leadId: z.ZodString;
        score: z.ZodNumber;
        source: z.ZodEnum<["inbound", "outbound", "referral"]>;
    }, "strict", z.ZodTypeAny, {
        source: "inbound" | "outbound" | "referral";
        score: number;
        leadId: string;
    }, {
        source: "inbound" | "outbound" | "referral";
        score: number;
        leadId: string;
    }>;
    readonly "forge.outreach.sent": z.ZodObject<{
        leadId: z.ZodString;
        channel: z.ZodEnum<["email", "linkedin", "x", "telegram"]>;
        content: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        content: string;
        channel: "telegram" | "email" | "x" | "linkedin";
        leadId: string;
    }, {
        content: string;
        channel: "telegram" | "email" | "x" | "linkedin";
        leadId: string;
    }>;
    readonly "forge.policy.triggered": z.ZodObject<{
        policyId: z.ZodString;
        context: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strict", z.ZodTypeAny, {
        context: Record<string, unknown>;
        policyId: string;
    }, {
        context: Record<string, unknown>;
        policyId: string;
    }>;
    readonly "vauban.vault.rebalance_proposed": z.ZodObject<{
        vaultId: z.ZodString;
        currentRatio: z.ZodNumber;
        targetRatio: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        vaultId: string;
        currentRatio: number;
        targetRatio: number;
    }, {
        vaultId: string;
        currentRatio: number;
        targetRatio: number;
    }>;
    readonly "vauban.vault.rebalanced": z.ZodObject<{
        vaultId: z.ZodString;
        txHash: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        vaultId: string;
        txHash: string;
    }, {
        vaultId: string;
        txHash: string;
    }>;
    readonly "vauban.vault.analyzed": z.ZodObject<{
        vaultId: z.ZodString;
        tvlUsd: z.ZodNumber;
        anomalies: z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            severity: z.ZodEnum<["info", "warning", "error", "critical"]>;
            metric: z.ZodString;
            current: z.ZodUnion<[z.ZodString, z.ZodNumber]>;
            expected: z.ZodUnion<[z.ZodString, z.ZodNumber]>;
            description: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: string;
            expected: string | number;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
            current: string | number;
        }, {
            type: string;
            expected: string | number;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
            current: string | number;
        }>, "many">;
        overallSeverity: z.ZodEnum<["info", "warning", "error", "critical"]>;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        timestamp: string;
        schemaVersion: string;
        overallSeverity: "error" | "info" | "critical" | "warning";
        vaultId: string;
        tvlUsd: number;
        anomalies: {
            type: string;
            expected: string | number;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
            current: string | number;
        }[];
    }, {
        timestamp: string;
        schemaVersion: string;
        overallSeverity: "error" | "info" | "critical" | "warning";
        vaultId: string;
        tvlUsd: number;
        anomalies: {
            type: string;
            expected: string | number;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
            current: string | number;
        }[];
    }>;
    readonly "vauban.goal.checked": z.ZodObject<{
        goalId: z.ZodString;
        successRate: z.ZodNumber;
        alertLevel: z.ZodEnum<["none", "warning", "critical"]>;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        timestamp: string;
        schemaVersion: string;
        successRate: number;
        goalId: string;
        alertLevel: "critical" | "none" | "warning";
    }, {
        timestamp: string;
        schemaVersion: string;
        successRate: number;
        goalId: string;
        alertLevel: "critical" | "none" | "warning";
    }>;
    readonly "vauban.rebalancing.checked": z.ZodObject<{
        portfolioId: z.ZodString;
        maxDrift: z.ZodNumber;
        alertLevel: z.ZodEnum<["none", "warning", "critical"]>;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        timestamp: string;
        schemaVersion: string;
        alertLevel: "critical" | "none" | "warning";
        portfolioId: string;
        maxDrift: number;
    }, {
        timestamp: string;
        schemaVersion: string;
        alertLevel: "critical" | "none" | "warning";
        portfolioId: string;
        maxDrift: number;
    }>;
    readonly "vauban.tax.checked": z.ZodObject<{
        userId: z.ZodString;
        rulesTriggered: z.ZodArray<z.ZodString, "many">;
        alertLevel: z.ZodEnum<["none", "warning", "critical"]>;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        timestamp: string;
        schemaVersion: string;
        userId: string;
        alertLevel: "critical" | "none" | "warning";
        rulesTriggered: string[];
    }, {
        timestamp: string;
        schemaVersion: string;
        userId: string;
        alertLevel: "critical" | "none" | "warning";
        rulesTriggered: string[];
    }>;
    readonly "vauban.vault.compounded": z.ZodObject<{
        vaultId: z.ZodString;
        compoundedAt: z.ZodString;
        rewardsUsd: z.ZodNumber;
        caller: z.ZodString;
        txHash: z.ZodOptional<z.ZodString>;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        schemaVersion: string;
        vaultId: string;
        compoundedAt: string;
        rewardsUsd: number;
        caller: string;
        txHash?: string | undefined;
    }, {
        schemaVersion: string;
        vaultId: string;
        compoundedAt: string;
        rewardsUsd: number;
        caller: string;
        txHash?: string | undefined;
    }>;
    readonly "vauban-finance.forecast.generated": z.ZodObject<{
        scenarioId: z.ZodString;
        successRate: z.ZodNumber;
        paramVelocity: z.ZodNumber;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        timestamp: string;
        schemaVersion: string;
        scenarioId: string;
        successRate: number;
        paramVelocity: number;
    }, {
        timestamp: string;
        schemaVersion: string;
        scenarioId: string;
        successRate: number;
        paramVelocity: number;
    }>;
    readonly "vauban-finance.trade.executed": z.ZodObject<{
        symbol: z.ZodString;
        direction: z.ZodEnum<["long", "short", "hold"]>;
        quantity: z.ZodNumber;
        conviction: z.ZodNumber;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        symbol: string;
        timestamp: string;
        schemaVersion: string;
        direction: "long" | "short" | "hold";
        quantity: number;
        conviction: number;
    }, {
        symbol: string;
        timestamp: string;
        schemaVersion: string;
        direction: "long" | "short" | "hold";
        quantity: number;
        conviction: number;
    }>;
    readonly "glacis.identity.verified": z.ZodObject<{
        userId: z.ZodString;
        method: z.ZodEnum<["zk_passport", "zk_email", "world_id"]>;
    }, "strict", z.ZodTypeAny, {
        method: "zk_passport" | "zk_email" | "world_id";
        userId: string;
    }, {
        method: "zk_passport" | "zk_email" | "world_id";
        userId: string;
    }>;
    readonly "citadel.sprint.closed": z.ZodObject<{
        sprintId: z.ZodString;
        completed: z.ZodNumber;
        carryOver: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        completed: number;
        sprintId: string;
        carryOver: number;
    }, {
        completed: number;
        sprintId: string;
        carryOver: number;
    }>;
    readonly "citadel.sprint.analyzed": z.ZodObject<{
        sprintId: z.ZodString;
        healthScore: z.ZodNumber;
        overallSeverity: z.ZodEnum<["info", "warning", "error", "critical"]>;
        insights: z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            severity: z.ZodEnum<["info", "warning", "error", "critical"]>;
            metric: z.ZodString;
            description: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            type: string;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
        }, {
            type: string;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
        }>, "many">;
        blockers: z.ZodArray<z.ZodString, "many">;
        recommendations: z.ZodArray<z.ZodString, "many">;
        timestamp: z.ZodString;
        schemaVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        timestamp: string;
        schemaVersion: string;
        insights: {
            type: string;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
        }[];
        sprintId: string;
        healthScore: number;
        overallSeverity: "error" | "info" | "critical" | "warning";
        blockers: string[];
        recommendations: string[];
    }, {
        timestamp: string;
        schemaVersion: string;
        insights: {
            type: string;
            description: string;
            severity: "error" | "info" | "critical" | "warning";
            metric: string;
        }[];
        sprintId: string;
        healthScore: number;
        overallSeverity: "error" | "info" | "critical" | "warning";
        blockers: string[];
        recommendations: string[];
    }>;
    readonly "brain.skill.extracted": z.ZodObject<{
        skillId: z.ZodString;
        agentSource: z.ZodString;
        confidence: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        confidence: number;
        agentSource: string;
        skillId: string;
    }, {
        confidence: number;
        agentSource: string;
        skillId: string;
    }>;
    readonly "cc.cost.recorded": z.ZodObject<{
        agent: z.ZodString;
        costUsd: z.ZodNumber;
        tokens: z.ZodNumber;
        model: z.ZodString;
        tenantId: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        model: string;
        costUsd: number;
        agent: string;
        tokens: number;
        tenantId?: string | undefined;
    }, {
        model: string;
        costUsd: number;
        agent: string;
        tokens: number;
        tenantId?: string | undefined;
    }>;
    readonly "cc.cost.anomaly_detected": z.ZodObject<{
        agent: z.ZodString;
        expected: z.ZodNumber;
        actual: z.ZodNumber;
        period: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        expected: number;
        agent: string;
        actual: number;
        period: string;
    }, {
        expected: number;
        agent: string;
        actual: number;
        period: string;
    }>;
    readonly "tenant.provisioned": z.ZodObject<{
        tenantId: z.ZodString;
        plan: z.ZodEnum<["starter", "team", "pro", "enterprise"]>;
        virtualKey: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        tenantId: string;
        plan: "starter" | "team" | "pro" | "enterprise";
        virtualKey: string;
    }, {
        tenantId: string;
        plan: "starter" | "team" | "pro" | "enterprise";
        virtualKey: string;
    }>;
    readonly "tenant.budget.exceeded": z.ZodObject<{
        tenantId: z.ZodString;
        period: z.ZodString;
        amountUsd: z.ZodNumber;
        limitUsd: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        tenantId: string;
        period: string;
        amountUsd: number;
        limitUsd: number;
    }, {
        tenantId: string;
        period: string;
        amountUsd: number;
        limitUsd: number;
    }>;
};
```

### `__unknown`

```typescript
type EventSource_2 = "forge" | "vauban" | "vauban-finance" | "brain" | "citadel" | "glacis" | "cc" | "tenant";
export { EventSource_2 as EventSource }
```

### `EventType`

```typescript
export type EventType = {
    type: "agent.started";
    payload: z.infer<typeof AgentStartedV1>;
} | {
    type: "agent.completed";
    payload: z.infer<typeof AgentCompletedV1>;
} | {
    type: "agent.failed";
    payload: z.infer<typeof AgentFailedV1>;
} | {
    type: "agent.hitl_requested";
    payload: z.infer<typeof AgentHitlRequestedV1>;
} | {
    type: "agent.hitl_resolved";
    payload: z.infer<typeof AgentHitlResolvedV1>;
} | {
    type: "incident.slo_burn";
    payload: z.infer<typeof IncidentSloBurnV1>;
} | {
    type: "incident.detected";
    payload: z.infer<typeof IncidentDetectedV1>;
} | {
    type: "forge.inbox.reply_classified";
    payload: z.infer<typeof ForgeInboxReplyClassifiedV1>;
} | {
    type: "forge.lead.qualified";
    payload: z.infer<typeof ForgeLeadQualifiedV1>;
} | {
    type: "forge.outreach.sent";
    payload: z.infer<typeof ForgeOutreachSentV1>;
} | {
    type: "forge.policy.triggered";
    payload: z.infer<typeof ForgePolicyTriggeredV1>;
} | {
    type: "vauban.vault.rebalance_proposed";
    payload: z.infer<typeof VaubanVaultRebalanceProposedV1>;
} | {
    type: "vauban.vault.rebalanced";
    payload: z.infer<typeof VaubanVaultRebalancedV1>;
} | {
    type: "glacis.identity.verified";
    payload: z.infer<typeof GlacisIdentityVerifiedV1>;
} | {
    type: "citadel.sprint.closed";
    payload: z.infer<typeof CitadelSprintClosedV1>;
} | {
    type: "citadel.sprint.analyzed";
    payload: z.infer<typeof CitadelSprintAnalyzedV1>;
} | {
    type: "brain.skill.extracted";
    payload: z.infer<typeof BrainSkillExtractedV1>;
} | {
    type: "cc.cost.recorded";
    payload: z.infer<typeof CcCostRecordedV1>;
} | {
    type: "cc.cost.anomaly_detected";
    payload: z.infer<typeof CcCostAnomalyDetectedV1>;
} | {
    type: "tenant.provisioned";
    payload: z.infer<typeof TenantProvisionedV1>;
} | {
    type: "tenant.budget.exceeded";
    payload: z.infer<typeof TenantBudgetExceededV1>;
} | {
    type: "vauban.vault.analyzed";
    payload: z.infer<typeof VaubanVaultAnalyzedV1>;
} | {
    type: "vauban.goal.checked";
    payload: z.infer<typeof VaubanGoalCheckedV1>;
} | {
    type: "vauban.rebalancing.checked";
    payload: z.infer<typeof VaubanRebalancingCheckedV1>;
} | {
    type: "vauban.tax.checked";
    payload: z.infer<typeof VaubanTaxCheckedV1>;
} | {
    type: "vauban.vault.compounded";
    payload: z.infer<typeof VaubanVaultCompoundedV1>;
} | {
    type: "vauban-finance.forecast.generated";
    payload: z.infer<typeof VaubanFinanceForecastGeneratedV1>;
} | {
    type: "vauban-finance.trade.executed";
    payload: z.infer<typeof VaubanFinanceTradeExecutedV1>;
};
```

### `EventTypeName`

```typescript
export type EventTypeName = keyof typeof EventSchemas;
```

### `EvictionPolicy`

```typescript
export interface EvictionPolicy {
    readonly name: string;
    select(entries: readonly WorkingMemoryEntry[], targetSize: number): string[];
}

// Warning: (ae-missing-release-tag) "ExecFn" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ExecFn`

```typescript
export type ExecFn = (cmd: string, cwd: string) => ExecResult;

// Warning: (ae-missing-release-tag) "ExecResult" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ExecResult`

```typescript
export interface ExecResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}
```

### `executeStep`

```typescript
export function executeStep(step: PlanStep, executor: (step: PlanStep) => Promise<unknown>): Promise<StepResult>;

// Warning: (ae-missing-release-tag) "EXECUTION_GROUNDED_ANCHORS" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `EXECUTION_GROUNDED_ANCHORS`

```typescript
export const EXECUTION_GROUNDED_ANCHORS: ReadonlySet<string>;
```

### `ExecutionMode`

```typescript
export type ExecutionMode = "dry-run" | "live";
```

### `ExecutionResult`

```typescript
export interface ExecutionResult<T = unknown> {
    readonly automationName: string;
    readonly completedAt: Date;
    readonly durationMs: number;
    readonly error?: {
        code: string;
        message: string;
        details?: unknown;
    };
    readonly executionId: string;
    readonly input: unknown;
    readonly logs: ReadonlyArray<{
        readonly level: string;
        readonly message: string;
        readonly timestamp: string;
    }>;
    readonly output?: T;
    readonly startedAt: Date;
    readonly status: "completed" | "failed" | "timeout";
}
```

### `ExhaustResourcesOptions`

```typescript
export interface ExhaustResourcesOptions {
    err?: () => Error;
    maxCalls: number;
}
```

### `exportProofClaim`

```typescript
export function exportProofClaim(trace: Trace, traceBytes: string, signClaim?: SignFn, opts?: ExportProofClaimOptions): ProofClaim;
```

### `ExportProofClaimOptions`

```typescript
export interface ExportProofClaimOptions {
    paymentAuthorization?: PaymentAuthorization;
    paymentReceipt?: SettlementReceipt;
}
```

### `exportTrajectory`

```typescript
export function exportTrajectory(runId: string, db: DbClient, opts?: TrajectoryOptions): Promise<TrajectoryExport>;
```

### `ExternalKMSKeyProvider`

```typescript
export class ExternalKMSKeyProvider implements KeyProvider {
    constructor(options: ExternalKMSKeyProviderOptions);
    getKey(keyId: string): Promise<Uint8Array>;
    hasColocationRisk(): boolean;
}
```

### `ExternalKMSKeyProviderOptions`

```typescript
export interface ExternalKMSKeyProviderOptions {
    authToken?: string;
    endpoint: string;
}
```

### `ExtractedSkill`

```typescript
export interface ExtractedSkill {
    chainOfThought: string;
    confidence: number;
    description: string;
    name: string;
    verified: boolean;
}
```

### `extractFeatures`

```typescript
export function extractFeatures(input: string, context?: string): TaskFeatures;
```

### `extractSkillFromTrace`

```typescript
export function extractSkillFromTrace(events: CycleEvent[], _ctx: OODAContext, opts: LearnOptions): Promise<ExtractedSkill | null>;

// Warning: (ae-missing-release-tag) "extractTestFailureDetail" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `extractTestFailureDetail`

```typescript
export function extractTestFailureDetail(output: string): string;

// Warning: (ae-missing-release-tag) "extractTraceContext" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `extractTraceContext`

```typescript
export function extractTraceContext(headers: Record<string, string>): SpanContext | null;
```

### `FallbackAdapter`

```typescript
export class FallbackAdapter implements TimestampPort {
    constructor(adapters: readonly TimestampPort[]);
    request(rootHash: string): Promise<SignedReceipt>;
    verify(receipt: SignedReceipt, rootHash: string): Promise<{
        valid: boolean;
        reason?: string;
    }>;
}

// Warning: (ae-missing-release-tag) "fanInArgmin" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `fanInArgmin`

```typescript
export function fanInArgmin<C>(candidates: readonly C[], score: (candidate: C) => number, id: (candidate: C) => string): FanInResult<C>;

// Warning: (ae-missing-release-tag) "FanInResult" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `FanInResult`

```typescript
export interface FanInResult<C> {
    readonly ranked: readonly {
        readonly id: string;
        readonly score: number;
    }[];
    readonly winner: C;
}

// Warning: (ae-missing-release-tag) "fanOut" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `fanOut`

```typescript
export function fanOut<T, R>(items: readonly T[], evaluate: (item: T, index: number) => Promise<R>, maxConcurrency?: number): Promise<R[]>;
```

### `FederationDelegationChainError`

```typescript
export class FederationDelegationChainError extends Error {
    constructor(messageId: string, chainDepth: number, reason: string);
    readonly chainDepth: number;
    readonly messageId: string;
    readonly reason: string;
}
```

### `FederationMessage`

```typescript
export interface FederationMessage {
    readonly content_claim: ContentClaim;
    readonly delegation_chain?: ReadonlyArray<{
        readonly id: string;
        readonly parent_id?: string;
        readonly scope: {
            readonly capabilities: ReadonlyArray<string>;
            readonly constraints: ReadonlyArray<unknown>;
            readonly jurisdictions: ReadonlyArray<string>;
            readonly expires_at: string;
        };
        readonly ed25519_sig: string;
    }>;
    readonly header: FederationMessageHeader;
    readonly id: string;
    readonly transport: TransportMeta;
}
```

### `FederationMessageHeader`

```typescript
export interface FederationMessageHeader {
    readonly causation_id?: string;
    readonly correlation_id: string;
    readonly from_agent: AgentRef;
    readonly message_id: string;
    readonly nonce: string;
    readonly timestamp: string;
    readonly to_agent: AgentRef;
}
```

### `FederationMessageId`

```typescript
export type FederationMessageId = string;
```

### `FederationPort`

```typescript
export interface FederationPort {
    ack(messageId: FederationMessageId): Promise<void>;
    nack(messageId: FederationMessageId, reason?: string): Promise<void>;
    receive(opts?: FederationReceiveOpts): Promise<FederationMessage[]>;
    send(message: FederationMessage, opts?: {
        timeoutMs?: number;
    }): Promise<FederationMessageId>;
    verifyMessage(msg: FederationMessage): Promise<FederationVerifyResult>;
}
```

### `FederationReceiveOpts`

```typescript
export interface FederationReceiveOpts {
    readonly destinationTenantId?: string;
    readonly maxMessages?: number;
    readonly timeout?: number;
}
```

### `FederationRoutingError`

```typescript
export class FederationRoutingError extends Error {
    constructor(tenantId: string, reason: string);
    readonly reason: string;
    readonly tenantId: string;
}
```

### `FederationSignatureInvalidError`

```typescript
export class FederationSignatureInvalidError extends Error {
    constructor(messageId: string, reason: string);
    readonly messageId: string;
    readonly reason: string;
}
```

### `FederationVerifyResult`

```typescript
export interface FederationVerifyResult {
    readonly chain_depth?: number;
    readonly errors: string[];
    readonly signer_agent_id?: string;
    readonly valid: boolean;
}
```

### `FileIOMode`

```typescript
export type FileIOMode = "none" | "ro" | "sandboxed";
```

### `FileIoMode`

```typescript
export type FileIoMode = "off" | "read-only" | "sandboxed-tmp";

// Warning: (ae-missing-release-tag) "FileReader" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `__unknown`

```typescript
type FileReader_2 = (absPath: string) => string;
export { FileReader_2 as FileReader }
```

### `FileRunJournal`

```typescript
export class FileRunJournal implements RunJournalPort {
    constructor(filePath: string, onDegraded?: ((reason: string) => void) | undefined);
    append(msg: LogMessage, meta?: JournalAppendMeta): Promise<number>;
    get degraded(): boolean;
    read(range: {
        from: number;
        to: number;
    }): Promise<JournalStep[]>;
    search(query: string, opts?: {
        topK?: number;
    }): Promise<JournalStep[]>;
}

// Warning: (ae-missing-release-tag) "findBreakpoint" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `findBreakpoint`

```typescript
export function findBreakpoint(steps: readonly TraceStep[], predicate: (step: TraceStep) => boolean): number | null;
```

### `findIndexEntry`

```typescript
export function findIndexEntry(index: SignedSkillIndex, skillId: string, version?: string): SkillIndexEntry | null;
```

### `FleetCircuitBreaker`

```typescript
export class FleetCircuitBreaker {
    constructor(config?: Partial<CircuitBreakerConfig>, _now?: () => number);
    canProceed(): boolean;
    recordCost(costUsd: number): void;
    reset(): void;
    // Warning: (ae-forgotten-export) The symbol "CircuitState_2" needs to be exported by the entry point index.d.ts
    get state(): CircuitState_2;
    get windowSpend(): number;
}
```

### `foldAttentionStep`

```typescript
export function foldAttentionStep(sink: TraceStepSink, runId: string, verdict: AttentionVerdict, clock: ClockPort): Promise<TraceStep>;
```

### `FORBIDDEN_MODEL_FAMILIES_PER_TIER`

```typescript
export const FORBIDDEN_MODEL_FAMILIES_PER_TIER: Record<Tier, readonly string[]>;
```

### `FORBIDDEN_MODELS_PER_TIER`

```typescript
export const FORBIDDEN_MODELS_PER_TIER: Record<Tier, readonly string[]>;
```

### `FormalSolver`

```typescript
export type FormalSolver = "z3" | "none";
```

### `formalVerify`

```typescript
export function formalVerify(axiomSpecs: AxiomSpec[], mode: ConsumerMode, context: VerifyContext, customPolicies?: Partial<Record<string, AxiomPolicy>>): Promise<FormalVerifyDecision[]>;
```

### `FormalVerifyDecision`

```typescript
export interface FormalVerifyDecision {
    decision: PolicyDecision;
    result: FormalVerifyResult;
}
```

### `FormalVerifyResult`

```typescript
export interface FormalVerifyResult {
    axiom: string;
    counterexample?: string;
    rationale: string;
    solver: FormalSolver;
    state: FormalVerifyState;
    time_ms: number;
    witness?: string;
}
```

### `FormalVerifyState`

```typescript
export type FormalVerifyState = "SAFE" | "UNSAFE" | "UNKNOWN" | "SKIPPED";
```

### `FreshnessMarker`

```typescript
export interface FreshnessMarker {
    readonly entryId: string;
    readonly stale: boolean;
    readonly validFrom?: string;
    readonly validUntil?: string;
}

// Warning: (ae-missing-release-tag) "FrozenIntent" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `FrozenIntent`

```typescript
export interface FrozenIntent {
    readonly scope?: {
        readonly allowed_paths?: readonly string[];
    };
}
```

### `GATE_DECISION_KIND`

```typescript
export const GATE_DECISION_KIND: "verifier-battery";
```

### `GateDecisionCore`

```typescript
export interface GateDecisionCore {
    readonly acceptedHash: string | null;
    readonly acceptedIndex: number | null;
    readonly acceptedScore: number | null;
    readonly adrEco: string;
    readonly kind: typeof GATE_DECISION_KIND;
    readonly rejected: readonly RejectedCandidate[];
    readonly verdicts: readonly CandidateVerdict[];
    readonly voteThreshold: number;
}
```

### `GateResult`

```typescript
export interface GateResult {
    pass: boolean;
    violations: GateViolation[];
}
```

### `GateSeverity`

```typescript
export type GateSeverity = "block";
```

### `GateVerdictEnvelope`

```typescript
export interface GateVerdictEnvelope {
    readonly artifactHash: string;
    readonly attempt: number;
    readonly chain_head?: string;
    readonly commit: string;
    readonly decisionCore: GateDecisionCore;
    readonly keyid: string;
    readonly outputHash: string;
    readonly policy_digest?: string;
    readonly producerId: string;
    readonly runId: string;
    readonly sig?: string;
    readonly stageId: string;
}
```

### `GateViolation`

```typescript
export interface GateViolation {
    axiom: AxiomId;
    rationale: string;
    rule: string;
    severity: GateSeverity;
}
```

### `GatewayAdapter`

```typescript
export interface GatewayAdapter {
    deliver(text: string): Promise<void>;
    deliverApproval?(prompt: ApprovalPrompt): Promise<void>;
    readonly platform: string;
    start(onMessage: (msg: InboundMessage) => void, onApprovalCallback?: (cb: ApprovalCallback) => void): Promise<void>;
    stop(): Promise<void>;
}
```

### `GatewayHandle`

```typescript
export interface GatewayHandle {
    readonly platforms: string[];
    start(): Promise<void>;
    stop(): Promise<void>;
}
```

### `GatewayOptions`

```typescript
export interface GatewayOptions {
    adapters: GatewayAdapter[];
    approvalChannel?: RemoteApprovalChannel;
    greeting?: string | false;
    hub: RemoteControlPort;
    // Warning: (ae-forgotten-export) The symbol "GatewayLogger" needs to be exported by the entry point index.d.ts
    log?: GatewayLogger;
    onRevive?: (id: string) => boolean;
    onStop?: () => boolean;
    verbose?: boolean;
}
```

### `GENESIS_PREV_HASH`

```typescript
export const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
```

### `getAgentId`

```typescript
export function getAgentId(agent: AgentType): string;
```

### `getFallbackChain`

```typescript
export function getFallbackChain(config: PhaseModelConfig, phase: OODAPhaseKind): ModelSpec[];
```

### `__unknown`

```typescript
function getSDKProvider(): BasicTracerProvider | null;
export { getSDKProvider as getSDKConfig }
export { getSDKProvider }
```

### `getTracer`

```typescript
export function getTracer(name?: string): Tracer;
```

### `GistCompressionConfig`

```typescript
export interface GistCompressionConfig {
    maxGistTokens?: number;
    raw_threshold?: number;
}
```

### `GistedMessage`

```typescript
export interface GistedMessage {
    content: string;
    originalLength: number;
    role: "tool";
    toolName?: string;
}
```

### `GistLLMFn`

```typescript
export type GistLLMFn = (prompt: string) => Promise<string>;
```

### `gistToolResult`

```typescript
export function gistToolResult(rawContent: string, toolName: string | undefined, llmFn: GistLLMFn, config?: GistCompressionConfig): Promise<GistedMessage>;
```

### `GitHubPublisher`

```typescript
export class GitHubPublisher implements PublisherPort {
    constructor(cfg: GitHubPublisherConfig);
    readonly channel: "github";
    isConfigured(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
}
```

### `GitHubPublisherConfig`

```typescript
export interface GitHubPublisherConfig {
    readonly token: string;
}
```

### `GOLDEN_ATTACK_EMBEDDINGS`

```typescript
export const GOLDEN_ATTACK_EMBEDDINGS: ReadonlyArray<{
    label: string;
    embedding: number[];
}>;
```

### `GOLDEN_FIXTURES`

```typescript
export const GOLDEN_FIXTURES: ReadonlyArray<{
    trace: string;
    expectedSkillName: string;
}>;

// Warning: (ae-missing-release-tag) "GovernanceError" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `GovernanceError`

```typescript
export class GovernanceError extends Error {
    constructor(message: string);
}

// Warning: (ae-missing-release-tag) "GovernedDecision" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `GovernedDecision`

```typescript
export interface GovernedDecision<I, O> {
    readonly auditStep: AuditStep;
    readonly claim: DecisionClaim_2<I, O>;
}

// Warning: (ae-missing-release-tag) "gradeDecision" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `gradeDecision`

```typescript
export function gradeDecision(verdict: ReexecVerdict<unknown>, externalVerifier: boolean): DecisionGrade;

// Warning: (ae-missing-release-tag) "GroundedTestResult" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `GroundedTestResult`

```typescript
export interface GroundedTestResult {
    readonly collectedCount?: number;
    readonly exitCode: number;
    readonly failCount: number;
    readonly passCount: number;
    readonly ran: boolean;
    readonly rationale: string;
    readonly skipCount?: number;
}
```

### `GuardrailDef`

```typescript
export interface GuardrailDef<TInput = unknown, TOutput = unknown> {
    check(input: TInput | TOutput, ctx: OODAContext): Promise<GuardrailResult>;
    readonly name: string;
    readonly timing: GuardrailTiming;
}
```

### `GuardrailResult`

```typescript
export interface GuardrailResult {
    pass: boolean;
    proofHash?: string;
    reason?: string;
}
```

### `GuardrailTiming`

```typescript
export type GuardrailTiming = "pre-phase" | "post-phase";
```

### `GuardrailViolation`

```typescript
export interface GuardrailViolation {
    name: string;
    phase: string;
    proofHash?: string;
    reason: string;
    timing: GuardrailTiming;
}
```

### `guardrailViolationToEvent`

```typescript
export function guardrailViolationToEvent(violation: GuardrailViolation, runId: string, cycleIndex: number): Extract<CycleEventV011, {
    type: "guardrail_violated";
}>;
```

### `guardStructuredOutput`

```typescript
export function guardStructuredOutput<T>(schema: ZodSchema<T>, raw: string): StructuredOutputVerdict<T>;
```

### `handoff`

```typescript
export function handoff(opts: HandoffOptions, client: AgentHandoffClient): Promise<HandoffResult>;
```

### `HandoffCycleError`

```typescript
export class HandoffCycleError extends Error {
    constructor(agentId: string, chain: string[]);
}
```

### `HandoffOptions`

```typescript
export interface HandoffOptions {
    ctx: OODAContext;
    handoffChain: string[];
    messages: Array<{
        role: string;
        content: string;
    }>;
    targetAgentId: string;
}
```

### `HandoffResult`

```typescript
export interface HandoffResult {
    accepted: boolean;
    childRunId: string;
    nextChain: string[];
}
```

### `handoffToEvent`

```typescript
export function handoffToEvent(targetAgentId: string, childRunId: string, handoffChain: string[], runId: string, cycleIndex: number): Extract<CycleEventV011, {
    type: "handoff_initiated";
}>;
```

### `HardGate`

```typescript
export class HardGate {
    evaluate(cycle: CycleSnapshot, parent?: ParentCycleContext): GateResult;
}
```

### `hardGate`

```typescript
export const hardGate: HardGate;
```

### `hashJti`

```typescript
export function hashJti(jti: string): string;
```

### `hashKey`

```typescript
export function hashKey(...parts: unknown[]): string;
```

### `hashLLMCacheKey`

```typescript
export function hashLLMCacheKey(key: LLMCacheKey): Promise<string>;
```

### `HITLCallbackData`

```typescript
export interface HITLCallbackData {
    action: "approve" | "reject";
    approvalId: string;
}
```

### `HITLDecision`

```typescript
export type HITLDecision = "approved" | "rejected";
```

### `HITLGateArgs`

```typescript
export interface HITLGateArgs {
    agentId: string;
    decisionPayload: Record<string, unknown>;
    executionMode: ExecutionMode;
    runId: string;
}
```

### `HITLGateOptions`

```typescript
export interface HITLGateOptions {
    onTimeout?: HITLOnTimeoutPolicy;
    pollIntervalMs?: number;
    timeoutMs?: number;
}
```

### `HITLGateVerdict`

```typescript
export interface HITLGateVerdict {
    approved: boolean;
    rationale?: string;
    resolvedBy?: string;
    timedOut: boolean;
}
```

### `HITLHandlerResult`

```typescript
export interface HITLHandlerResult {
    body: unknown;
    status: number;
}
```

### `HITLNotFoundError`

```typescript
export class HITLNotFoundError extends Error {
    constructor(id: string);
    readonly id: string;
}
```

### `HITLOnTimeoutPolicy`

```typescript
export type HITLOnTimeoutPolicy = "reject" | "approve" | "continue-skip";
```

### `HITLPort`

```typescript
export interface HITLPort {
    await(id: string, timeoutMs?: number): Promise<HITLState>;
    expire(id: string): Promise<void>;
    getState(id: string): Promise<HITLState>;
    request(req: HITLRequest): Promise<string>;
    resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void>;
}
```

### `HITLRequest`

```typescript
export interface HITLRequest {
    agentSource: string;
    channel: "telegram" | "slack" | "discord";
    context: Record<string, unknown>;
    deadline: string;
    id: string;
    options: string[];
    question: string;
    tenantId?: string;
}

// Warning: (ae-forgotten-export) The symbol "HitlRequestInput" needs to be exported by the entry point index.d.ts
//
```

### `hitlRequest`

```typescript
export const hitlRequest: Skill<HitlRequestInput, HitlRequestOutput>;
```

### `HitlRequestOutput`

```typescript
export interface HitlRequestOutput {
    expires_at: string;
    id: string;
    status: "pending" | "replay";
}
```

### `HITLState`

```typescript
export type HITLState = "pending" | "approved" | "rejected" | "expired" | "executed";
```

### `HmacInvalidError`

```typescript
export class HmacInvalidError extends Error {
    constructor(runId: string);
}
```

### `hmacSha256`

```typescript
export function hmacSha256(key: Uint8Array, input: string | Uint8Array): Promise<string>;
```

### `HttpBrainAdapterOptions`

```typescript
export interface HttpBrainAdapterOptions {
    agentId?: string;
    apiKey?: string;
    baseUrl: string;
    brainId: string;
    logger?: (message: string, ...args: unknown[]) => void;
    throwOnQueryFailure?: boolean;
    timeoutMs?: number;
    token?: string;
}

// Warning: (ae-forgotten-export) The symbol "HttpFetchInput" needs to be exported by the entry point index.d.ts
//
```

### `httpFetch`

```typescript
export const httpFetch: Skill<HttpFetchInput, HttpFetchOutput>;
```

### `HttpFetchAllowlistError`

```typescript
export class HttpFetchAllowlistError extends Error {
    constructor(url: string, host: string);
    readonly host: string;
    readonly url: string;
}
```

### `HttpFetchOutput`

```typescript
export interface HttpFetchOutput {
    body: string;
    headers: Record<string, string>;
    status: number;
    truncated: boolean;
}
```

### `HttpVCR`

```typescript
export class HttpVCR {
    clear(): void;
    export(): VCRCassette[];
    intercept(url: string, method: string, body: string | null, realFetch: () => Promise<Response>): Promise<Response>;
    static key(url: string, method: string, body: string | null): string;
    load(cassettes: VCRCassette[]): void;
    mode: VCRMode;
    stats: VCRStats;
}
```

### `IdempotencyCache`

```typescript
export interface IdempotencyCache<T> {
    delete(key: string): void;
    get(key: string): T | undefined;
    set(key: string, value: T): void;
}
```

### `IdempotencyKeyPayload`

```typescript
export interface IdempotencyKeyPayload {
    author: string;
    category: string;
    content: string;
}
```

### `idempotent`

```typescript
export function idempotent<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: IdempotentOptions<TArgs, TResult>): (...args: TArgs) => Promise<TResult>;
```

### `IdempotentOptions`

```typescript
export interface IdempotentOptions<TArgs extends unknown[], TResult> {
    cache?: IdempotencyCache<TResult>;
    keyFor: (...args: TArgs) => string;
    maxEntries?: number;
    ttlMs?: number;
}
```

### `ImageAttachment`

```typescript
export interface ImageAttachment {
    dataBase64: string;
    kind: "image";
    mediaType: string;
}
```

### `ImageMediaType`

```typescript
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
```

### `ImmuneMatch`

```typescript
export interface ImmuneMatch {
    entry: ImmuneMemoryEntry;
    similarity: number;
    threshold: number;
}
```

### `ImmuneMemoryEntry`

```typescript
export interface ImmuneMemoryEntry {
    embedding: number[];
    label: string;
    proofHash?: string;
    timestamp: number;
}

// Warning: (ae-forgotten-export) The symbol "ImportanceWeightedOptions" needs to be exported by the entry point index.d.ts
//
```

### `importanceWeightedPolicy`

```typescript
export function importanceWeightedPolicy(opts?: ImportanceWeightedOptions): EvictionPolicy;
```

### `InboundMessage`

```typescript
export interface InboundMessage {
    // Warning: (ae-forgotten-export) The symbol "InboundAttachment" needs to be exported by the entry point index.d.ts
    attachments?: InboundAttachment[];
    chatId: string;
    platform: string;
    text: string;
    ts: string;
    userId: string;
}
```

### `IndexVerifyResult`

```typescript
export interface IndexVerifyResult {
    code?: UntrustedIndexCode;
    detail?: string;
    valid: boolean;
}
```

### `IngestSpansResult`

```typescript
export interface IngestSpansResult {
    accepted: number;
    runs?: string[];
    skipped?: number;
    warnings?: string[];
}
```

### `initVaubanSDK`

```typescript
export function initVaubanSDK(opts: VaubanSDKOptions): BasicTracerProvider;

// Warning: (ae-missing-release-tag) "injectAt" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `injectAt`

```typescript
export function injectAt(steps: readonly TraceStep[], toStep: number, injected: TraceStep): readonly TraceStep[];
```

### `InjectBrainFailureOptions`

```typescript
export interface InjectBrainFailureOptions {
    failureRate: number;
    random?: () => number;
    type?: "rate-limit" | "timeout" | "network" | "random";
}

// Warning: (ae-missing-release-tag) "injectTraceContext" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `injectTraceContext`

```typescript
export function injectTraceContext(headers: Record<string, string>, ctx?: ReturnType<typeof context.active>): Record<string, string>;
```

### `InMemoryApprovalStore`

```typescript
export class InMemoryApprovalStore implements ApprovalStore {
    cancel(id: string): Promise<boolean>;
    create(entry: PendingApproval): Promise<void>;
    expireOverdue(now?: number): Promise<number>;
    get(id: string): Promise<PendingApproval | null>;
    listAll(): Promise<readonly PendingApproval[]>;
    resolve(id: string, verdict: Approval): Promise<boolean>;
}
```

### `InMemoryInstructionInbox`

```typescript
export class InMemoryInstructionInbox implements InstructionInbox {
    drain(): Instruction[];
    enqueue(text: string, source: string, whisper?: boolean, steerId?: string): void;
    size(): number;
}
```

### `InMemoryLLMResponseCache`

```typescript
export class InMemoryLLMResponseCache implements LLMResponseCache {
    clear(): void;
    get(key: LLMCacheKey): Promise<LLMCacheEntry | undefined>;
    put(key: LLMCacheKey, response: unknown): Promise<void>;
}
```

### `InMemoryNonceStore`

```typescript
export class InMemoryNonceStore implements NonceStore {
    reset(): void;
    setNX(key: string, ttlMs: number): Promise<boolean>;
}
```

### `InMemoryPersistencePort`

```typescript
export class InMemoryPersistencePort implements PersistencePort {
    clearAll(): Promise<void>;
    close(): Promise<void>;
    getMaxSeq(): Promise<number>;
    get isClosed(): boolean;
    loadEvents(sinceSeq?: number): Promise<SessionEvent[]>;
    loadRevocations(): Promise<string[]>;
    saveEvent(event: SessionEvent): Promise<void>;
    saveRevocation(jti: string): Promise<void>;
}
```

### `InMemoryReceiptQueue`

```typescript
export class InMemoryReceiptQueue implements ReceiptQueue {
    enqueue(entry: Omit<ReceiptQueueEntry, "hmac" | "attempts">, keyProvider: KeyProvider, keyId: string): Promise<void>;
    pending(): Promise<ReceiptQueueEntry[]>;
    process(adapter: TimestampPort, keyProvider: KeyProvider, keyId: string, opts?: {
        batchSize?: number;
        backoffMs?: readonly number[];
    }): Promise<{
        processed: number;
        failed: number;
        rejected: number;
    }>;
    size(): Promise<number>;
}

// Warning: (ae-missing-release-tag) "inMemoryRunState" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `inMemoryRunState`

```typescript
export function inMemoryRunState(steps: readonly TraceStep[]): RunStatePort;
```

### `InMemorySecretsAccessor`

```typescript
export class InMemorySecretsAccessor implements SecretsAccessor {
    constructor(secrets?: Readonly<Record<string, string>>);
    get accessedSecrets(): ReadonlySet<string>;
    get(name: string, defaultValue?: string): string;
    has(name: string): boolean;
}
```

### `InMemoryVetoChannel`

```typescript
export class InMemoryVetoChannel implements VetoChannel {
    await(callId: string, windowMs: number): Promise<VetoSignal | null>;
    pendingCount(): number;
    submit(signal: VetoSignal): void;
}
```

### `innerMonologue`

```typescript
export function innerMonologue(input: InnerMonologueInput, reasoner: (input: InnerMonologueInput) => Promise<{
    reasoning: string;
    insights: string[];
    confidence: number;
}>): Promise<InnerMonologueOutput>;
```

### `InnerMonologueInput`

```typescript
export interface InnerMonologueInput {
    config?: unknown;
    observation: unknown;
    previous?: string[];
}
```

### `InnerMonologueOutput`

```typescript
export interface InnerMonologueOutput {
    confidence: number;
    insights: string[];
    reasoning: SensitiveValue<string>;
}
```

### `insertRunStep`

```typescript
export function insertRunStep(db: DbClient, runId: string, input: InsertRunStepInput): Promise<{
    stepId: string;
}>;
```

### `InsertRunStepInput`

```typescript
export interface InsertRunStepInput {
    parentStepId?: string;
    payload?: Record<string, unknown>;
    phase: string;
    stepIndex: number;
    type: OODAPhaseKind;
}
```

### `InstallRevokedError`

```typescript
export class InstallRevokedError extends Error {
    constructor(installId: string);
    readonly installId: string;
}
```

### `INSTITUTIONNEL`

```typescript
export const INSTITUTIONNEL: Axiom;
```

### `institutionnelScorer`

```typescript
export const institutionnelScorer: ScoringFunction;
```

### `Instruction`

```typescript
export interface Instruction {
    at: string;
    source: string;
    steerId?: string;
    text: string;
    whisper: boolean;
}
```

### `InstructionInbox`

```typescript
export interface InstructionInbox {
    drain(): Instruction[];
    enqueue(text: string, source: string, whisper?: boolean, steerId?: string): void;
    size(): number;
}
```

### `InvalidGlacisAttestationError`

```typescript
export class InvalidGlacisAttestationError extends Error {
    constructor(tenantId: string, reason: string);
    readonly reason: string;
    readonly tenantId: string;
}
```

### `InvalidSignatureError`

```typescript
export class InvalidSignatureError extends Error {
    constructor(message?: string);
}
```

### `InvalidStateTransitionError`

```typescript
export class InvalidStateTransitionError extends Error {
    constructor(from: HITLState, to: HITLState);
    readonly from: HITLState;
    readonly to: HITLState;
}
```

### `InvalidStrategyError`

```typescript
export class InvalidStrategyError extends Error {
    constructor(message?: string);
    readonly name = "InvalidStrategyError";
}
```

### `InvalidTargetError`

```typescript
export class InvalidTargetError extends Error {
    constructor(message: string, target: string);
    readonly target: string;
}

// Warning: (ae-missing-release-tag) "isAdvisory" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `isAdvisory`

```typescript
export function isAdvisory(x: unknown): x is AdvisoryClaim<unknown>;
```

### `isControlClaimKind`

```typescript
export function isControlClaimKind(kind: TeammateMessageClaim["kind"]): kind is "control";
```

### `isControlVerb`

```typescript
export function isControlVerb(v: string): v is ControlVerb;
```

### `isDegradedResponse`

```typescript
export function isDegradedResponse(r: unknown): r is DegradedResponse;
```

### `isHitlGatableClaimKind`

```typescript
export function isHitlGatableClaimKind(kind: TeammateMessageClaim["kind"]): boolean;
```

### `isHostAllowed`

```typescript
export function isHostAllowed(host: string, allowlist: string[]): boolean;
```

### `isIdleCycle`

```typescript
export function isIdleCycle(inputs: ProductiveQualityInputs): boolean;
```

### `isKnownEventType`

```typescript
export function isKnownEventType(type: string): boolean;
```

### `isLinkStatus`

```typescript
export function isLinkStatus(value: string): value is LinkStatus;
```

### `isMultiModal`

```typescript
export function isMultiModal(obs: unknown): obs is MultiModalObservation;
```

### `isPortError`

```typescript
export function isPortError(err: unknown, port?: string): err is PortError;
```

### `isReadOnlySql`

```typescript
export function isReadOnlySql(sql: string): boolean;
```

### `isRecognizedClaimKind`

```typescript
export function isRecognizedClaimKind(kind: string): kind is TeammateMessageClaim["kind"];
```

### `isRetryablePortError`

```typescript
export function isRetryablePortError(err: unknown): err is PortError;
```

### `isSessionOriginKind`

```typescript
export function isSessionOriginKind(v: string): v is SessionOriginKind;
```

### `isTeamActionVerb`

```typescript
export function isTeamActionVerb(v: string): v is TeamActionVerb;
```

### `isValidToolName`

```typescript
export function isValidToolName(name: string): boolean;
```

### `JournalAppendMeta`

```typescript
export interface JournalAppendMeta {
    phase?: string;
}
```

### `JournalEntry`

```typescript
export interface JournalEntry {
    readonly error?: {
        message: string;
        stack?: string;
    };
    readonly finished_at?: Date;
    readonly idempotency_key?: string;
    readonly input: unknown;
    readonly journal_id: bigint;
    readonly output?: unknown;
    readonly run_id: string;
    readonly started_at: Date;
    readonly status: StepStatus;
    readonly step_index: number;
    readonly step_kind: StepKind;
    readonly step_name: string;
}
```

### `JournalMigrator`

```typescript
export type JournalMigrator = (journal: JournalEntry[]) => JournalEntry[];
```

### `JournalStep`

```typescript
export interface JournalStep {
    content: string;
    phase?: string;
    role: LogMessage["role"];
    stepIndex: number;
    timestamp: string;
    toolName?: string;
}
```

### `Jurisdiction`

```typescript
export type Jurisdiction = "FR.v1" | "EU.v1" | "CH.v1" | "UK.v1" | "SG.v1";

// Warning: (ae-forgotten-export) The symbol "SanitizeConfig" needs to be exported by the entry point index.d.ts
//
```

### `keepSafeOnly`

```typescript
export function keepSafeOnly<T extends {
    content: string;
}>(items: T[], opts?: SanitizeConfig): T[];
```

### `KeyProvider`

```typescript
export interface KeyProvider {
    getKey(keyId: string): Promise<Uint8Array>;
    hasColocationRisk(): boolean;
}
```

### `LatencyTier`

```typescript
export type LatencyTier = "low" | "medium" | "high";
```

### `LearningTrigger`

```typescript
export interface LearningTrigger {
    durationMs: number;
    roi: number;
    toolCallCount: number;
    wasReplay: boolean;
}
```

### `LearnOptions`

```typescript
export interface LearnOptions {
    enabled: boolean;
    extractor?: (trace: string) => Promise<ExtractedSkill | null>;
    // Warning: (ae-forgotten-export) The symbol "SkillLedger" needs to be exported by the entry point index.d.ts
    ledger?: SkillLedger;
    minConfidence?: number;
}
```

### `LegalBasisDecl`

```typescript
export interface LegalBasisDecl {
    basis: LegalBasisRef;
    domain: LegalBasisDomain;
    scope?: Jurisdiction[];
}
```

### `LegalBasisDomain`

```typescript
export type LegalBasisDomain = "processing" | "retention" | "transfer" | "consent";
```

### `LegalBasisRef`

```typescript
export type LegalBasisRef = "gdpr.art6_1_a" | "gdpr.art6_1_b" | "gdpr.art6_1_c" | "gdpr.art6_1_f" | "mica.art14" | "tfr.art4" | "cjeu.c520_21";
```

### `LensEngine`

```typescript
export type LensEngine = "rule" | "smt" | "execution" | "retrieval" | "statistical" | "llm-judge";
```

### `LensVerdict`

```typescript
export interface LensVerdict {
    readonly criticality: "hard" | "soft" | "advisory";
    readonly engine: LensEngine;
    readonly fired: boolean;
    readonly lens: string;
    readonly polarity: "affirm" | "refute";
    readonly rationale: string;
    readonly rawScore: number;
}
```

### `LessonInput`

```typescript
export interface LessonInput {
    readonly applies_to: readonly string[];
    readonly context: string;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly insight: string;
    readonly title: string;
}
```

### `LinkStatus`

```typescript
export type LinkStatus = "connected" | "reconnecting" | "relay-unreachable";
```

### `LiteLLMAdapter`

```typescript
export class LiteLLMAdapter implements LLMProviderPort {
    constructor(config: LiteLLMAdapterConfig);
    complete(req: ChatRequest): Promise<ChatResponse>;
    estimateCost(req: ChatRequest): {
        usd: number;
    };
    stream(req: ChatRequest): AsyncIterable<StreamDelta>;
}
```

### `LiteLLMAdapterConfig`

```typescript
export interface LiteLLMAdapterConfig {
    apiKey?: string;
    baseUrl: string;
    defaultModel?: string;
}
```

### `LLMCacheEntry`

```typescript
export interface LLMCacheEntry {
    key: string;
    recordedAt: number;
    response: unknown;
}
```

### `LLMCacheKey`

```typescript
export interface LLMCacheKey {
    messages: unknown;
    model: string;
    provider: string;
    seed?: number;
    temperature: number;
}
```

### `LLMCompletionFn`

```typescript
export type LLMCompletionFn = (messages: ReactMessage[]) => Promise<LLMReactResponse>;
```

### `LLMMessage`

```typescript
export interface LLMMessage {
    readonly content: string;
    readonly role: "system" | "user" | "assistant";
}
```

### `LLMProviderError`

```typescript
export class LLMProviderError extends Error {
    constructor(message: string, provider: string, model: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly model: string;
    readonly provider: string;
}
```

### `LLMProviderPort`

```typescript
export interface LLMProviderPort {
    complete(req: ChatRequest): Promise<ChatResponse>;
    estimateCost?(req: ChatRequest): {
        usd: number;
    };
    stream?(req: ChatRequest): AsyncIterable<StreamDelta>;
}
```

### `LLMRateLimitError`

```typescript
export class LLMRateLimitError extends LLMProviderError {
    constructor(message: string, provider: string, model: string, retryAfterMs: number, cause?: unknown);
    readonly retryAfterMs: number;
}
```

### `LLMReactResponse`

```typescript
export interface LLMReactResponse {
    content: string;
    isFinal: boolean;
    toolCalls?: ToolCall[];
}
```

### `LLMResponseCache`

```typescript
export interface LLMResponseCache {
    clear?(): void;
    get(key: LLMCacheKey): Promise<LLMCacheEntry | undefined>;
    put(key: LLMCacheKey, response: unknown): Promise<void>;
}
```

### `llmSpan`

```typescript
export function llmSpan(tracer: Tracer, request: {
    provider: string;
    model: string;
    maxTokens?: number;
    messageCount?: number;
    temperature?: number;
    topP?: number;
    seed?: number;
}): Span;
```

### `loadAgentContext`

```typescript
export function loadAgentContext(brain: BrainPort, agentId: string, domainTags: string[], logger: LoggerPort, opts?: LoadAgentContextOptions): Promise<AgentBootContext>;
```

### `LoadAgentContextOptions`

```typescript
export interface LoadAgentContextOptions {
    decisionsCategory?: string;
    domainCategories?: string[];
    domainContextLimit?: number;
    projectMd?: {
        query: string;
        category: string;
        tag: string;
    };
    recentDecisionsLimit?: number;
}
```

### `loadHubFromPersistence`

```typescript
export function loadHubFromPersistence(hub: RemoteControlPort, persistence: PersistencePort, opts?: {
    sinceSeq?: number;
}): Promise<{
    loaded: number;
    maxSeq: number;
}>;
```

### `loadPersonaFromBrain`

```typescript
export function loadPersonaFromBrain(brain: SemanticMemoryPort, agentId: string): Promise<AgentPersona | null>;
```

### `loadPersonaFromFile`

```typescript
export function loadPersonaFromFile(path: string): Promise<AgentPersona | null>;
```

### `loadRecentMemory`

```typescript
export function loadRecentMemory(brain: BrainPort, agentId: string, opts?: LoadRecentMemoryOptions): Promise<string>;
```

### `LoadRecentMemoryOptions`

```typescript
export interface LoadRecentMemoryOptions {
    category?: string;
    limit?: number;
    maxChars?: number;
    maxEntryChars?: number;
    tags?: string[];
}
```

### `loadSkillMd`

```typescript
export function loadSkillMd(filePath: string): Promise<ParsedSkillFile>;
```

### `localSqliteTelemetrySink`

```typescript
export function localSqliteTelemetrySink(opts?: LocalSqliteTelemetrySinkOptions): TelemetrySink;
```

### `LocalSqliteTelemetrySinkOptions`

```typescript
export interface LocalSqliteTelemetrySinkOptions {
    path?: string;
    readonly?: boolean;
}
```

### `LoggerFlushError`

```typescript
export class LoggerFlushError extends Error {
    constructor(message: string, pendingCount: number, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly pendingCount: number;
}
```

### `LoggerPort`

```typescript
export interface LoggerPort {
    child?(bindings: Record<string, unknown>): LoggerPort;
    debug(objOrMsg: object | string, msg?: string): void;
    error(objOrMsg: object | string, msg?: string): void;
    info(objOrMsg: object | string, msg?: string): void;
    warn(objOrMsg: object | string, msg?: string): void;
}
```

### `LogMessage`

```typescript
export type LogMessage = {
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolName?: string;
};
```

### `looksLikeSessionEvent`

```typescript
export function looksLikeSessionEvent(input: unknown): boolean;
```

### `lookupTier`

```typescript
export function lookupTier(provider: string, model: string): ModelTier | undefined;
```

### `lruPolicy`

```typescript
export const lruPolicy: EvictionPolicy;
```

### `makeEvent`

```typescript
export function makeEvent<T extends SessionEvent["type"]>(type: T, data: Extract<SessionEvent, {
    type: T;
}>["data"]): SessionEvent;
```

### `Manifest`

```typescript
export interface Manifest {
    readonly capabilities: readonly string[];
    readonly compliance: {
        readonly jurisdictions: readonly string[];
        readonly legal_bases: readonly string[];
        readonly data_classification: string;
    };
    // Warning: (ae-forgotten-export) The symbol "ComplianceMode_2" needs to be exported by the entry point index.d.ts
    //
    readonly compliance_mode: ComplianceMode_2;
    readonly ed25519_pubkey: string;
    readonly manifestHash: string;
    readonly name: string;
    readonly runtime: {
        readonly max_compute_seconds: number;
        readonly max_llm_tokens: number;
    };
    readonly signature: string;
    // Warning: (ae-forgotten-export) The symbol "Tier_2" needs to be exported by the entry point index.d.ts
    //
    readonly tier: Tier_2;
    readonly version: string;
}
```

### `ManifestComplianceConflictError`

```typescript
export class ManifestComplianceConflictError extends Error {
    constructor(name: string, version: string, violation: string);
    readonly name: string;
    readonly version: string;
    readonly violation: string;
}
```

### `ManifestNotFoundError`

```typescript
export class ManifestNotFoundError extends Error {
    constructor(name: string, version: string);
    readonly name: string;
    readonly version: string;
}
```

### `ManifestRegistryPort`

```typescript
export interface ManifestRegistryPort {
    listVersions(name: string): Promise<readonly string[]>;
    lookup(name: string, version: string): Promise<Manifest | null>;
    // Warning: (ae-forgotten-export) The symbol "RegisterOptions" needs to be exported by the entry point index.d.ts
    register(manifest: Manifest, options?: RegisterOptions): Promise<RegistrationResult>;
    revoke(claim_id: string, reason: string): Promise<void>;
    verifySignature(manifest: Manifest): Promise<boolean>;
}
```

### `ManifestSignatureInvalidError`

```typescript
export class ManifestSignatureInvalidError extends Error {
    constructor(name: string, version: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly name: string;
    readonly version: string;
}
```

### `ManifestValidationError`

```typescript
export class ManifestValidationError extends Error {
    constructor(violations: readonly ComplianceError[]);
    // Warning: (ae-forgotten-export) The symbol "ComplianceError" needs to be exported by the entry point index.d.ts
    //
    readonly violations: readonly ComplianceError[];
}
```

### `ManifestValidationResult`

```typescript
export interface ManifestValidationResult {
    readonly conflicts: PolicyConflict[];
    readonly evaluationTimeMs: number;
    readonly jurisdictionWarnings: string[];
    readonly missingLegalBases: string[];
    readonly valid: boolean;
}
```

### `ManifestVersionConflictError`

```typescript
export class ManifestVersionConflictError extends Error {
    constructor(name: string, version: string, existingStatus: string);
    readonly existingStatus: string;
    readonly name: string;
    readonly version: string;
}
```

### `MappedBashMode`

```typescript
export type MappedBashMode = "off" | "restricted";
```

### `MappedSdkPermissions`

```typescript
export interface MappedSdkPermissions {
    bash: MappedBashMode;
    fileIo: FileIoMode;
    mcp: string[];
}
```

### `mapScopesToSdkPermissions`

```typescript
export function mapScopesToSdkPermissions(scopes: readonly string[]): SdkPermissions;
```

### `MarketingGateInput`

```typescript
export interface MarketingGateInput {
    readonly action_type: string;
    readonly payload: Record<string, unknown> | null | undefined;
    readonly persona: AgentPersona;
    readonly platform?: string;
}
```

### `MarketingGateResult`

```typescript
export interface MarketingGateResult {
    readonly passed: boolean;
    readonly violations: string[];
    readonly warnings: string[];
}
```

### `MarketSignal`

```typescript
export interface MarketSignal {
    readonly divergence_bps: number;
    readonly oracle_count: number;
    readonly price: string;
    // Warning: (ae-forgotten-export) The symbol "Symbol_2" needs to be exported by the entry point index.d.ts
    //
    readonly symbol: Symbol_2;
    readonly timestamp: Date;
}
```

### `MAVAggregation`

```typescript
export type MAVAggregation = "mean" | "median" | "min" | "majority-vote";
```

### `MAX_TEAMMATE_BODY_BYTES`

```typescript
export const MAX_TEAMMATE_BODY_BYTES: number;
```

### `MCPChannel`

```typescript
export class MCPChannel implements MessagingChannelPort {
    constructor(config: MCPChannelConfig);
    sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
    sendMessage(target: string, text: string): Promise<void>;
}
```

### `MCPChannelConfig`

```typescript
export interface MCPChannelConfig {
    mcpClient: MCPClientLike;
    toolName: string;
}
```

### `MCPClientLike`

```typescript
export interface MCPClientLike {
    callTool(name: string, args: unknown, headers?: Record<string, string>): Promise<unknown>;
}
```

### `MCPToolDefinition`

```typescript
export interface MCPToolDefinition {
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
    name: string;
}
```

### `MemoryAgentRegistry`

```typescript
export class MemoryAgentRegistry implements AgentRegistryPort {
    list(filter?: Partial<AgentRegistryDescriptor>): Promise<AgentRegistryDescriptor[]>;
    register(descriptor: AgentRegistryDescriptor): Promise<void>;
    resolve(capability: string, opts?: {
        tenantId?: string;
    }): Promise<AgentRegistryDescriptor[]>;
    unregister(id: string): Promise<void>;
}
```

### `MemoryAttestation`

```typescript
export interface MemoryAttestation {
    agentId: string;
    contentHash: string;
    event: string;
    recordedAt: string;
    runId: string;
    signature: {
        alg: "Ed25519";
        pubkey: string;
        value: string;
    };
    traceId?: string;
}
```

### `MemoryContent`

```typescript
export type MemoryContent = Pick<EpisodicMemoryEntry, "agentId" | "runId" | "event" | "metadata" | "traceId">;
```

### `memoryEntryContentHash`

```typescript
export function memoryEntryContentHash(entry: MemoryContent): string;
```

### `MemoryHITLStateStore`

```typescript
export class MemoryHITLStateStore implements HITLPort {
    await(id: string, timeoutMs?: number): Promise<HITLState>;
    expire(id: string): Promise<void>;
    _expireOverdue(): Promise<void>;
    getState(id: string): Promise<HITLState>;
    request(req: HITLRequest): Promise<string>;
    resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void>;
}
```

### `MemoryProvenanceReason`

```typescript
export type MemoryProvenanceReason = "ok" | "no-attestation" | "content-tampered" | "untrusted-signer" | "bad-signature";
```

### `MemoryProvenanceResult`

```typescript
export interface MemoryProvenanceResult {
    reason: MemoryProvenanceReason;
    valid: boolean;
}
```

### `MemoryScope`

```typescript
export type MemoryScope = "private" | "shared" | "org_wide" | "cross_org";
```

### `MemoryValidationError`

```typescript
export class MemoryValidationError extends Error {
    constructor(message: string);
}
```

### `mergePersona`

```typescript
export function mergePersona(base: AgentPersona, local: AgentPersona): AgentPersona;
```

### `MeshAgentKind`

```typescript
export type MeshAgentKind = "ooda" | "llm-router" | "mcp-tool" | "plugin" | "fallback";
```

### `MeshCapabilityScope`

```typescript
export interface MeshCapabilityScope {
    readonly actions: ReadonlyArray<string>;
    readonly budgetEur: number;
    readonly expiresAt?: Date;
}
```

### `MeshDeadlineExceededError`

```typescript
export class MeshDeadlineExceededError extends Error {
    constructor(deadlineMs: number, partial?: string);
    readonly name = "MeshDeadlineExceededError";
    readonly partial?: string;
}
```

### `meshDefaultClassifier`

```typescript
export function meshDefaultClassifier(need: string): MeshAgentKind;
```

### `meshDelegate`

```typescript
export function meshDelegate<T = string>(options: DelegateOptions, dispatcher: MeshDispatcher): Promise<DelegateResult<T>>;
```

### `MeshDelegationLink`

```typescript
export interface MeshDelegationLink {
    readonly budget: number;
    readonly from: string;
    readonly scope: ReadonlyArray<string>;
    readonly to: string;
}
```

### `MeshDispatcher`

```typescript
export interface MeshDispatcher {
    dispatch(intent: DispatchIntent): Promise<DispatchResult>;
}
```

### `MeshDispatchError`

```typescript
export class MeshDispatchError extends Error {
    constructor(message: string, code: string);
    readonly code: string;
    readonly name = "MeshDispatchError";
}
```

### `MessageAttachment`

```typescript
export type MessageAttachment = ImageAttachment;

// Warning: (ae-forgotten-export) The symbol "MessageClaimCandidate" needs to be exported by the entry point index.d.ts
//
```

### `messageClaimScopeLens`

```typescript
export const messageClaimScopeLens: BatteryLens<MessageClaimCandidate>;
```

### `MessageClaimVerdict`

```typescript
export interface MessageClaimVerdict {
    readonly allowed: boolean;
    readonly auditStep: BatteryTraceStep;
    readonly reason: string;
}
```

### `MessagingChannelPort`

```typescript
export interface MessagingChannelPort {
    sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
    sendMessage(target: string, text: string): Promise<void>;
}
```

### `MessagingTriggerResult`

```typescript
export interface MessagingTriggerResult {
    replyText: string;
    runId?: string;
}
```

### `MeterBalance`

```typescript
export interface MeterBalance {
    agentId: string;
    firstRunAt: number;
    lastRunAt: number;
    netValueCents: number;
    totalRuns: number;
    totalValueCents: number;
}
```

### `MeterEntry`

```typescript
export interface MeterEntry {
    agentId: string;
    hash: string;
    prevHash: string;
    runId: string;
    timestamp: number;
    valueCents: number;
}
```

### `MeterVerifyResult`

```typescript
export interface MeterVerifyResult {
    firstInvalidAt?: number;
    reason?: string;
    totalEntries: number;
    valid: boolean;
}
```

### `MigrationResult`

```typescript
export interface MigrationResult {
    readonly entries_migrated: number;
    readonly error?: string;
    readonly from_version: string;
    readonly ok: boolean;
    readonly run_id: string;
    readonly to_version: string;
}
```

### `MIN_SKILL_BODY_TOKENS`

```typescript
export const MIN_SKILL_BODY_TOKENS = 8;
```

### `MinimalRedisClient`

```typescript
export interface MinimalRedisClient {
    del(key: string): Promise<unknown>;
    get(key: string): Promise<string | null>;
    quit(): Promise<unknown>;
    set(key: string, value: string): Promise<unknown>;
}
```

### `mintSubToken`

```typescript
export function mintSubToken(opts: MintSubTokenOptions): string;
```

### `mintSubTokenInstrumented`

```typescript
export function mintSubTokenInstrumented(opts: MintSubTokenOptions): string;
```

### `MintSubTokenOptions`

```typescript
export interface MintSubTokenOptions {
    cnf?: {
        jkt: string;
    };
    now?: () => number;
    parentToken: string;
    scope: SubTokenScope;
    ttlSec: number;
}
```

### `MissingDependencyError`

```typescript
export class MissingDependencyError extends Error {
    constructor(port: string);
    readonly port: string;
}
```

### `MissingDryRunFlagError`

```typescript
export class MissingDryRunFlagError extends Error {
    constructor();
}
```

### `mixtureOfAgentsStrategy`

```typescript
export function mixtureOfAgentsStrategy<TInput, TOutput>(config?: Partial<MoAConfig<TOutput>>): Strategy<TInput, TOutput>;
```

### `MoAConfig`

```typescript
export interface MoAConfig<TOutput> {
    aggregate?: (outputs: TOutput[]) => TOutput;
    proposersPerRound: number;
    rounds: number;
}
```

### `mobSelectIndex`

```typescript
export function mobSelectIndex(verdicts: readonly CandidateVerdict[], seedStr: string, rounds?: number): number | null;
```

### `ModelSpec`

```typescript
export interface ModelSpec {
    costTracking?: boolean;
    fallback?: ModelSpec[];
    model: string;
    provider: string;
    temperature?: number;
    topP?: number;
}
```

### `ModelTier`

```typescript
export interface ModelTier {
    costPerMTokenIn: number;
    costPerMTokenOut: number;
    label: "free" | "cheap" | "mid" | "premium";
    model: string;
    provider: string;
}
```

### `MultiBrainDelegate`

```typescript
export interface MultiBrainDelegate {
    readonly isDefault?: boolean;
    readonly name: string;
    readonly port: BrainPort;
}
```

### `MultiBrainFromEnvOptions`

```typescript
export interface MultiBrainFromEnvOptions extends BrainRosterOptions {
    readonly agentId?: string;
    readonly logger?: (message: string, ...args: unknown[]) => void;
    readonly timeoutMs?: number;
}
```

### `MultiBrainPort`

```typescript
export interface MultiBrainPort extends BrainPort {
    readonly brains: readonly string[];
    readonly defaultBrain: string;
    queryAcrossBrains(query: string, filters?: BrainQueryFilters): Promise<MultiBrainQueryReport>;
}
```

### `MultiBrainPortOptions`

```typescript
export interface MultiBrainPortOptions {
    readonly delegates: readonly MultiBrainDelegate[];
    readonly logger?: (message: string, ...args: unknown[]) => void;
}
```

### `MultiBrainQueryReport`

```typescript
export interface MultiBrainQueryReport {
    readonly entries: readonly BrainEntry[];
    readonly reached: readonly string[];
    readonly unreachable: readonly UnreachedBrain[];
}
```

### `MultiModalObservation`

```typescript
export interface MultiModalObservation {
    audioBase64?: string;
    audioMediaType?: AudioMediaType;
    documentUrl?: string;
    imageBase64?: string;
    imageMediaType?: ImageMediaType;
    text?: string;
}
```

### `multiModalToAnthropicContent`

```typescript
export function multiModalToAnthropicContent(obs: MultiModalObservation): AnthropicContentBlock[];
```

### `NO_RETRY`

```typescript
export const NO_RETRY: RetryConfig;

// Warning: (ae-missing-release-tag) "NodeExecutor" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `NodeExecutor`

```typescript
export type NodeExecutor<TOutput = unknown> = (node: DagNodeSpec, inputs: NodeInputs, ctx: {
    readonly attempt: number;
    readonly signal?: AbortSignal;
}) => Promise<NodeOutcome<TOutput>>;

// Warning: (ae-missing-release-tag) "NodeInputs" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `NodeInputs`

```typescript
export type NodeInputs = Readonly<Record<string, unknown>>;

// Warning: (ae-missing-release-tag) "NodeManifestEntry" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `NodeManifestEntry`

```typescript
export interface NodeManifestEntry<TOutput = unknown> {
    readonly attempts: number;
    readonly dependsOn: readonly string[];
    readonly id: string;
    readonly output: TOutput | null;
    readonly reason: string | null;
    readonly status: NodeStatus;
}

// Warning: (ae-missing-release-tag) "NodeOutcome" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `NodeOutcome`

```typescript
export interface NodeOutcome<TOutput = unknown> {
    readonly output: TOutput | null;
    readonly reason?: string;
    readonly status: NodeStatus;
}

// Warning: (ae-missing-release-tag) "NodeStatus" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `NodeStatus`

```typescript
export type NodeStatus = "done" | "deferred" | "failed";
```

### `NON_DELEGABLE_TOOLS`

```typescript
export const NON_DELEGABLE_TOOLS: ReadonlySet<string>;
```

### `NonceStore`

```typescript
export interface NonceStore {
    setNX(key: string, ttlMs: number): Promise<boolean>;
}
```

### `NonDeterministicReplayError`

```typescript
export class NonDeterministicReplayError extends Error {
    constructor(stepIndex: number, reason: string);
    readonly reason: string;
    readonly stepIndex: number;
}
```

### `NonSerializablePayloadError`

```typescript
export class NonSerializablePayloadError extends Error {
    constructor(reason: string, path: string[]);
    readonly path: string[];
}
```

### `NOOP_SECRETS`

```typescript
export const NOOP_SECRETS: SecretsAccessor;
```

### `NOOP_SESSION_SINK`

```typescript
export const NOOP_SESSION_SINK: SessionEventSink;
```

### `NOOP_TELEMETRY_SINK`

```typescript
export const NOOP_TELEMETRY_SINK: TelemetrySink;
```

### `noopLogger`

```typescript
export const noopLogger: LoggerPort;
```

### `NoopObservabilityPort`

```typescript
export class NoopObservabilityPort implements ObservabilityPort {
    flush(): Promise<void>;
    // Warning: (ae-forgotten-export) The symbol "ObservabilityEvent" needs to be exported by the entry point index.d.ts
    //
    recordEvent(_event: ObservabilityEvent): void;
    // Warning: (ae-forgotten-export) The symbol "MetricInput" needs to be exported by the entry point index.d.ts
    //
    recordMetric(_metric: MetricInput): void;
    // Warning: (ae-forgotten-export) The symbol "SpanAttributes" needs to be exported by the entry point index.d.ts
    // Warning: (ae-forgotten-export) The symbol "Span_2" needs to be exported by the entry point index.d.ts
    //
    startSpan(_name: string, _attrs?: SpanAttributes): Span_2;
}
```

### `NoopPrivacyAdapter`

```typescript
export class NoopPrivacyAdapter implements PrivacyPort {
    // Warning: (ae-forgotten-export) The symbol "RevelationMask" needs to be exported by the entry point index.d.ts
    // Warning: (ae-forgotten-export) The symbol "PrivacyContext" needs to be exported by the entry point index.d.ts
    //
    applyMask(payload: unknown, _mask: RevelationMask, _ctx: PrivacyContext): Promise<unknown>;
    // Warning: (ae-forgotten-export) The symbol "Commitment" needs to be exported by the entry point index.d.ts
    // Warning: (ae-forgotten-export) The symbol "SmtResult" needs to be exported by the entry point index.d.ts
    //
    commitToSmt(commitment: Commitment, _ctx: PrivacyContext): Promise<SmtResult>;
    // Warning: (ae-forgotten-export) The symbol "ZkProofInput" needs to be exported by the entry point index.d.ts
    // Warning: (ae-forgotten-export) The symbol "VerifyResult" needs to be exported by the entry point index.d.ts
    //
    verifyZkProof(_proof: ZkProofInput, _ctx: PrivacyContext): Promise<VerifyResult>;
}
```

### `noveltyLens`

```typescript
export function noveltyLens<T>(reference: readonly T[], opts?: {
    project?: (c: T) => string;
    criticality?: "hard" | "soft" | "advisory";
    name?: string;
}): BatteryLens<T>;
```

### `NullTimestampPort`

```typescript
export class NullTimestampPort implements TimestampPort {
    request(_rootHash: string): Promise<SignedReceipt>;
    verify(_receipt: SignedReceipt, _rootHash: string): Promise<{
        valid: boolean;
        reason: string;
    }>;
}
```

### `ObservabilityPort`

```typescript
export interface ObservabilityPort {
    flush(): Promise<void>;
    recordEvent(event: ObservabilityEvent): void;
    recordMetric(metric: MetricInput): void;
    startSpan(name: string, attrs?: SpanAttributes): Span_2;
}
```

### `OnUnknown`

```typescript
export type OnUnknown = "escalate_human" | "proceed_with_log" | "proceed_with_audit_log";
```

### `OnUnsafe`

```typescript
export type OnUnsafe = "block" | "escalate_human";
```

### `OODAAgent`

```typescript
export interface OODAAgent {
    getStatus(): {
        running: boolean;
        lastCycleAt?: string;
        nextCycleAt?: string;
        cyclesCompleted: number;
    };
    start(): Promise<void>;
    stop(): Promise<void>;
    streamCycle(opts: {
        dryRun: boolean;
        initialContext?: Record<string, unknown>;
    }): AsyncIterable<CycleEvent>;
    triggerCycle(opts: {
        dryRun: boolean;
        initialContext?: Record<string, unknown>;
    }): Promise<{
        runId: string;
        status: CycleStatus;
    }>;
}
```

### `OODAAgentConfig`

```typescript
export interface OODAAgentConfig<TConfig = unknown, TObs = unknown, TOrient = unknown, TDecision = unknown, TAction = unknown, TFeedback = unknown> {
    readonly agentId: string;
    readonly agentVersion?: string;
    readonly completeStepImpl?: OODAContext["completeStep"];
    readonly config?: TConfig;
    readonly configLoader?: AgentConfigLoader<TConfig>;
    readonly db: DbClient;
    readonly deps: OODAAgentDeps;
    readonly errorStepImpl?: OODAContext["errorStep"];
    readonly executionMode: ExecutionMode;
    readonly insertStepImpl?: OODAContext["insertStep"];
    readonly intervalMs: number;
    readonly logger: LoggerPort;
    readonly notifySlackImpl?: OODAContext["notifySlack"];
    readonly onStep?: (event: StepEvent) => void | Promise<void>;
    readonly outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
    readonly phases: {
        readonly observe: PhaseDef<void, TObs>;
        readonly orient: PhaseDef<TObs, TOrient>;
        readonly decide: PhaseDef<TOrient, TDecision>;
        readonly act: PhaseDef<TDecision, TAction>;
        readonly reflect?: PhaseDef<TAction & {
            decision: TDecision;
        }, TFeedback>;
        readonly feedback: PhaseDef<TAction, TFeedback>;
    };
    readonly resourceLimits?: ResourceLimits;
    readonly riskGuards?: readonly RiskGuard[];
    readonly sessionGuards?: readonly SessionGuard[];
    readonly skillCapture?: SkillCaptureOptions;
    readonly skills?: SkillRegistry;
    readonly telemetry?: TelemetrySink;
    readonly timestamping?: {
        readonly port: TimestampPort;
        readonly queue?: ReceiptQueue;
        readonly queueHmacKeyProvider?: KeyProvider;
        readonly queueHmacKeyId?: string;
        readonly when: "on-cycle-complete" | "on-demand" | "disabled";
    };
    readonly waitForHITL?: (ctx: {
        runId: string;
        stepId: string;
        payload: unknown;
    }) => Promise<void>;
}
```

### `OODAAgentDeps`

```typescript
export interface OODAAgentDeps {
    eventBus?: EventBusPort;
    hitl?: HITLPort;
    llm: LLMProviderPort;
    memory?: BrainPort;
    messaging?: MessagingChannelPort;
    registry?: AgentRegistryPort;
}

// Warning: (ae-internal-missing-underscore) The name "OODAAgentImpl" should be prefixed with an underscore because the declaration is marked as @internal
//
```

### `OODAContext`

```typescript
export interface OODAContext<TConfig = unknown> {
    readonly agentId: string;
    readonly completeStep: (stepId: string, payload: Record<string, unknown>) => Promise<{
        leafHash: string;
    }>;
    readonly config: TConfig;
    readonly configLoader?: AgentConfigLoader<TConfig>;
    readonly cycleIndex: number;
    readonly db: DbClient;
    readonly deps: Partial<OODAAgentDeps>;
    readonly emitStep: (input: {
        type: OODAPhaseKind;
        phase: string;
        payload?: Record<string, unknown>;
        status?: "completed" | "failed" | "skipped";
        error?: Error | string;
    }) => void;
    readonly errorStep: (stepId: string, error: Error) => Promise<void>;
    readonly executionMode: ExecutionMode;
    readonly insertStep: (input: {
        type: OODAPhaseKind;
        phase: string;
        payload?: Record<string, unknown>;
    }) => Promise<{
        stepId: string;
    }>;
    readonly isReplay: boolean;
    readonly logger: LoggerPort;
    readonly notifySlack: (channel: string, text: string) => Promise<void>;
    readonly runId: string;
    readonly skills: SkillRegistry;
    readonly stepId?: string;
}
```

### `OODACycleInvoker`

```typescript
export interface OODACycleInvoker {
    invoke(ctx: StrategyAgentContext): Promise<AgentCycleResult>;
}
```

### `OODAPhaseKind`

```typescript
export type OODAPhaseKind = "retrieval" | "decision" | "execution" | "feedback" | "observation";
```

### `OrchestrationBulkheadOptions`

```typescript
export interface OrchestrationBulkheadOptions {
    maxConcurrent: number;
    maxQueue?: number;
    rejectOnFull?: boolean;
}
```

### `ORIENTATION_TOOLS`

```typescript
export const ORIENTATION_TOOLS: ReadonlySet<string>;
```

### `OrientationMemory`

```typescript
export interface OrientationMemory {
    content: string;
    entry_id: string;
    metadata: {
        kind: "orientation-memory";
        symbol: string;
        regime: string;
        observed_at: string;
    };
}
```

### `OrientInputWithBrain`

```typescript
export interface OrientInputWithBrain<TObs> {
    readonly brainContext: BrainChunk[];
    readonly brainContextRefs: string[];
    readonly episodicWindow?: EpisodicEvent[];
    readonly raw: TObs;
    readonly renderedMemoryContext?: string;
    readonly workingMemoryGoal?: WorkingMemorySlot | null;
}
```

### `OtelClient`

```typescript
export interface OtelClient {
    // Warning: (ae-forgotten-export) The symbol "IngestSpansOptions" needs to be exported by the entry point index.d.ts
    //
    ingestSpans(spans: {
        resourceSpans: unknown[];
    }, opts?: IngestSpansOptions): Promise<IngestSpansResult>;
}
```

### `OtlpAttribute`

```typescript
export interface OtlpAttribute {
    key: string;
    value: OtlpAttributeValue;
}
```

### `OtlpAttributeValue`

```typescript
export interface OtlpAttributeValue {
    arrayValue?: {
        values: OtlpAttributeValue[];
    };
    boolValue?: boolean;
    doubleValue?: number;
    intValue?: string;
    stringValue?: string;
}
```

### `OtlpSpan`

```typescript
export interface OtlpSpan {
    attributes: OtlpAttribute[];
    endTimeUnixNano: string;
    kind?: number;
    name: string;
    parentSpanId?: string;
    spanId: string;
    startTimeUnixNano: string;
    status?: {
        code: number;
        message?: string;
    };
    traceId: string;
}
```

### `otlpTelemetrySink`

```typescript
export function otlpTelemetrySink(opts: OtlpTelemetrySinkOptions): TelemetrySink;
```

### `OtlpTelemetrySinkOptions`

```typescript
export interface OtlpTelemetrySinkOptions {
    fetchImpl?: typeof fetch;
    headers?: Record<string, string>;
    serviceName?: string;
    timeoutMs?: number;
    url: string;
}
```

### `Outcome`

```typescript
export interface Outcome {
    agent_id: string;
    agent_run_id: string | null;
    currency: string;
    id: string;
    is_pending_backfill: boolean;
    metadata?: Record<string, unknown> | null;
    occurred_at: string;
    outcome_type: OutcomeType;
    value_cents: number;
}
```

### `OutcomeAttributionFailed`

```typescript
export class OutcomeAttributionFailed extends PortError {
    constructor(runId: string, message: string, cause?: unknown);
    readonly port = "outcome";
    readonly runId: string;
}
```

### `OutcomeGateOptions`

```typescript
export interface OutcomeGateOptions {
    maxCumulativeCents?: number;
    maxValueCents?: number;
    minValueCents?: number;
}
```

### `OutcomeGateResult`

```typescript
export interface OutcomeGateResult {
    allowed: boolean;
    chargeableCents: number;
    reason?: string;
}
```

### `OutcomeHook`

```typescript
export interface OutcomeHook {
    onCycleEnd(runId: string, cost: CycleCost): Promise<void>;
}
```

### `OutcomePort`

```typescript
export interface OutcomePort {
    recordOutcomeAsync(run: AgentRunRef): void;
}
```

### `OutcomeRecord`

```typescript
export interface OutcomeRecord {
    readonly confidence?: number;
    readonly is_pending_backfill?: boolean;
    readonly metadata?: Record<string, unknown>;
    readonly outcome_type: string;
    readonly quality?: number;
    readonly value_cents: number;
}
```

### `OutcomesApiError`

```typescript
export class OutcomesApiError extends Error {
    constructor(status: number, body: string, message?: string);
    readonly body: string;
    readonly status: number;
}
```

### `OutcomesClient`

```typescript
export interface OutcomesClient {
    cfo(period: {
        from: string;
        to: string;
    }): Promise<CfoView>;
    list(filter?: OutcomesListFilter): Promise<OutcomesListResponse>;
    roi(period: {
        from: string;
        to: string;
    }, opts?: {
        sortBy?: "net_roi_pct" | "value_cents";
        limit?: number;
    }): Promise<RoiPerAgent[]>;
    summary(period: {
        from: string;
        to: string;
    }): Promise<OutcomeSummary>;
}
```

### `OutcomesClientOptions`

```typescript
export interface OutcomesClientOptions {
    baseUrl: string;
    getToken: () => Promise<string>;
}
```

### `OutcomesListFilter`

```typescript
export interface OutcomesListFilter {
    agentId?: string;
    cursor?: string;
    from?: string;
    limit?: number;
    to?: string;
    type?: OutcomeType;
}
```

### `OutcomesListResponse`

```typescript
export interface OutcomesListResponse {
    items: Outcome[];
    nextCursor?: string;
}
```

### `OutcomeSummary`

```typescript
export interface OutcomeSummary {
    attributed_count: number;
    net_roi_pct: number | null;
    outcome_count: number;
    pending_attribution_count: number;
    period: {
        from: string;
        to: string;
    };
    total_cost_cents: number;
    total_value_cents: number;
    value_to_cost_ratio: number | null;
}
```

### `OutcomeTracker`

```typescript
export class OutcomeTracker {
    constructor(policy: TierPolicy, hook?: OutcomeHook);
    flush(runId: string): Promise<void>;
    getCosts(windowMs?: number): CycleCost[];
    record(runId: string, model: string, inputTokens: number, outputTokens: number, durationMs: number, opts?: {
        skillId?: string;
        outcomeValue?: number;
        category?: string;
    }): CycleCost;
    totalCostInWindow(windowMs?: number): number;
}
```

### `OutcomeType`

```typescript
export type OutcomeType = string;
```

### `OutcomeWriteError`

```typescript
export class OutcomeWriteError extends Error {
    constructor(message: string, runId: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly runId: string;
}
```

### `PairingPayload`

```typescript
export interface PairingPayload {
    hostPubKey: string;
    pairingToken: string;
    relayUrl: string;
    sessionId: string;
    v: number;
}
```

### `ParentCycleContext`

```typescript
export interface ParentCycleContext {
    allowed_scope_ids?: string[];
    budgetUsdMax: number;
}
```

### `parseAllowedTools`

```typescript
export function parseAllowedTools(manifest: SkillManifest): string[];
```

### `parseAttenuatedToken`

```typescript
export function parseAttenuatedToken(token: AttenuatedToken): MeshCapabilityScope;
```

### `parseBrainChunk`

```typescript
export const parseBrainChunk: typeof parseRecallChunk;
```

### `ParsedSkillFile`

```typescript
export interface ParsedSkillFile {
    body: string;
    bodyTokens: number;
    manifest: SkillManifest;
    tier: VaubanSkillTier;
}

// Warning: (ae-missing-release-tag) "ParsedTestCommand" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ParsedTestCommand`

```typescript
export interface ParsedTestCommand {
    readonly args: readonly string[];
    readonly bin: string;
}
```

### `parseFreshnessMarker`

```typescript
export function parseFreshnessMarker(value: unknown): FreshnessMarker;

// Warning: (ae-forgotten-export) The symbol "PlanStep_2" needs to be exported by the entry point index.d.ts
//
```

### `parsePlanFromText`

```typescript
export function parsePlanFromText(text: string): PlanStep_2[] | null;
```

### `parseProtocolOutput`

```typescript
export function parseProtocolOutput<T = unknown>(stdout: string): ProtocolResult<T>;
```

### `parseReactToolCall`

```typescript
export function parseReactToolCall(content: string): StrategyToolCall | null;
```

### `parseRecallChunk`

```typescript
export function parseRecallChunk(value: unknown): RecallChunk;
```

### `parseRecallOptions`

```typescript
export function parseRecallOptions(value: unknown): RecallOptions;
```

### `parseRecallResult`

```typescript
export function parseRecallResult(value: unknown): RecallResult;
```

### `parseSkillMd`

```typescript
export function parseSkillMd(raw: string, source?: string): ParsedSkillFile;
```

### `parseStderrLogs`

```typescript
export function parseStderrLogs(stderr: string): Array<{
    level: string;
    message: string;
    timestamp: string;
}>;
```

### `parseStructuredOutput`

```typescript
export function parseStructuredOutput<T>(raw: string, opts?: ParseStructuredOutputOpts<T>): T;
```

### `ParseStructuredOutputError`

```typescript
export class ParseStructuredOutputError extends Error {
    constructor(message: string, raw: string, cause: unknown);
    readonly cause: unknown;
    readonly raw: string;
}
```

### `ParseStructuredOutputOpts`

```typescript
export interface ParseStructuredOutputOpts<T> {
    fallback?: T;
    schema?: ZodSchema<T>;
}
```

### `parseTeamActionBody`

```typescript
export function parseTeamActionBody(verb: TeamActionVerb, raw: string): TeamActionRequest;
```

### `parseTeamCoordinateBody`

```typescript
export function parseTeamCoordinateBody(raw: string): TeamCoordinateRequest;
```

### `parseTeamDelegateBody`

```typescript
export function parseTeamDelegateBody(raw: string): TeamDelegateRequest;
```

### `parseTeamListBody`

```typescript
export function parseTeamListBody(raw: string): TeamListRequest;
```

### `parseTeamSendBody`

```typescript
export function parseTeamSendBody(raw: string): TeamSendRequest;
```

### `parseTeamStartBody`

```typescript
export function parseTeamStartBody(raw: string): TeamStartRequest;
```

### `payloadHash`

```typescript
export function payloadHash(value: unknown, policy: PayloadPolicy): Promise<PayloadHashResult>;
```

### `PayloadHashResult`

```typescript
export interface PayloadHashResult {
    hash: string;
    hmac?: string;
    policy: PayloadPolicy["kind"];
    storedValue?: unknown;
}

// Warning: (ae-forgotten-export) The symbol "IncludePolicy" needs to be exported by the entry point index.d.ts
// Warning: (ae-forgotten-export) The symbol "RedactPolicy" needs to be exported by the entry point index.d.ts
// Warning: (ae-forgotten-export) The symbol "HmacPolicy" needs to be exported by the entry point index.d.ts
// Warning: (ae-forgotten-export) The symbol "HashOnlyPolicy" needs to be exported by the entry point index.d.ts
//
```

### `PayloadPolicy`

```typescript
export type PayloadPolicy = IncludePolicy | RedactPolicy | HmacPolicy | HashOnlyPolicy;
```

### `PaymentAuthorization`

```typescript
export interface PaymentAuthorization {
    authorized: boolean;
    commitmentSha256: string;
    evaluatedAt: string;
    policyId: string;
    policyVersion: number;
}
```

### `PaymentAuthorizationVerdict`

```typescript
export interface PaymentAuthorizationVerdict {
    authorized: boolean;
    checks: PolicyCheckResult[];
    commitmentSha256: string;
    evaluatedAt: string;
    failed: PolicyCheckName[];
    policyId: string;
    policyVersion: number;
}
```

### `PaymentFacts`

```typescript
export interface PaymentFacts {
    amountWei: string;
    network: string;
    purpose?: PaymentPurpose;
    recipient: string;
    recordedAt?: string;
    token?: string;
    txHash?: string;
}
```

### `PaymentPolicy`

```typescript
export interface PaymentPolicy {
    id: string;
    maxAgeMs?: number;
    minAmountWei?: string;
    networks: string[];
    purposes?: PaymentPurpose[];
    recipient: string;
    version: number;
}
```

### `PaymentPurpose`

```typescript
export type PaymentPurpose = "skill-install" | "attest" | "api-access" | "tip";
```

### `PayPort`

```typescript
export interface PayPort {
    pay(req: PayRequest): Promise<PayResult>;
    waitForAcceptance(txHash: string, opts?: {
        timeoutMs?: number;
    }): Promise<PayResult>;
}
```

### `PayRequest`

```typescript
export interface PayRequest {
    amount: bigint;
    network: string;
    senderAddress: string;
    senderPrivateKey: string;
    to: string;
    token: string;
}
```

### `PayResult`

```typescript
export interface PayResult {
    blockNumber?: number;
    explorerUrl: string;
    status: "submitted" | "accepted" | "rejected";
    txHash: string;
}
```

### `PendingApproval`

```typescript
export interface PendingApproval {
    createdAt: number;
    expiresAt: number;
    id: string;
    req: ApprovalRequest;
    status: ApprovalStatus;
    verdict?: Approval;
}
```

### `PendingRequest`

```typescript
export interface PendingRequest {
    approverId: string | null;
    candidateId: string;
    deadlineAt: string;
    requestedAt: string;
}
```

### `permitsCapability`

```typescript
export function permitsCapability(permissions: SdkPermissions, capability: SdkCapability): boolean;
```

### `permitsMcpScopes`

```typescript
export function permitsMcpScopes(permissions: SdkPermissions, required: readonly string[]): boolean;
```

### `PersistencePort`

```typescript
export interface PersistencePort {
    clearAll(): Promise<void>;
    close(): Promise<void>;
    getMaxSeq(): Promise<number>;
    loadEvents(sinceSeq?: number): Promise<SessionEvent[]>;
    loadRevocations(): Promise<string[]>;
    saveEvent(event: SessionEvent): Promise<void>;
    saveRevocation(jti: string): Promise<void>;
}
```

### `PERSONA_BRAIN_CATEGORY`

```typescript
export const PERSONA_BRAIN_CATEGORY = "agent-persona";
```

### `PersonaAcknowledgmentStyle`

```typescript
export const PersonaAcknowledgmentStyle: z.ZodEnum<["minimal", "detailed", "none"]>;
```

### `PersonaAcknowledgmentStyle`

```typescript
export type PersonaAcknowledgmentStyle = z.infer<typeof PersonaAcknowledgmentStyle>;
```

### `PersonaExplainReasoning`

```typescript
export const PersonaExplainReasoning: z.ZodEnum<["always", "on_error", "never"]>;
```

### `PersonaExplainReasoning`

```typescript
export type PersonaExplainReasoning = z.infer<typeof PersonaExplainReasoning>;
```

### `PersonaFormality`

```typescript
export const PersonaFormality: z.ZodEnum<["casual", "formal", "technical"]>;
```

### `PersonaFormality`

```typescript
export type PersonaFormality = z.infer<typeof PersonaFormality>;
```

### `PersonaSchema`

```typescript
export const PersonaSchema: z.ZodObject<{
    identity: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        role: z.ZodOptional<z.ZodString>;
        tone: z.ZodOptional<z.ZodEnum<["concise", "detailed", "pedagogical"]>>;
        formality: z.ZodOptional<z.ZodEnum<["casual", "formal", "technical"]>>;
        language: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        name?: string | undefined;
        role?: string | undefined;
        tone?: "concise" | "detailed" | "pedagogical" | undefined;
        formality?: "casual" | "formal" | "technical" | undefined;
        language?: string | undefined;
    }, {
        name?: string | undefined;
        role?: string | undefined;
        tone?: "concise" | "detailed" | "pedagogical" | undefined;
        formality?: "casual" | "formal" | "technical" | undefined;
        language?: string | undefined;
    }>>;
    traits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    domain_expertise: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    communication: z.ZodOptional<z.ZodObject<{
        max_response_length: z.ZodOptional<z.ZodNumber>;
        use_analogies: z.ZodOptional<z.ZodBoolean>;
        explain_reasoning: z.ZodOptional<z.ZodEnum<["always", "on_error", "never"]>>;
        acknowledgment_style: z.ZodOptional<z.ZodEnum<["minimal", "detailed", "none"]>>;
    }, "strict", z.ZodTypeAny, {
        max_response_length?: number | undefined;
        use_analogies?: boolean | undefined;
        explain_reasoning?: "always" | "never" | "on_error" | undefined;
        acknowledgment_style?: "none" | "minimal" | "detailed" | undefined;
    }, {
        max_response_length?: number | undefined;
        use_analogies?: boolean | undefined;
        explain_reasoning?: "always" | "never" | "on_error" | undefined;
        acknowledgment_style?: "none" | "minimal" | "detailed" | undefined;
    }>>;
    directives: z.ZodOptional<z.ZodObject<{
        must: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        must_not: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strict", z.ZodTypeAny, {
        must?: string[] | undefined;
        must_not?: string[] | undefined;
    }, {
        must?: string[] | undefined;
        must_not?: string[] | undefined;
    }>>;
    forbidden_patterns: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        pattern: z.ZodString;
        scope: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        name: string;
        pattern: string;
        scope?: string | undefined;
    }, {
        name: string;
        pattern: string;
        scope?: string | undefined;
    }>, "many">>;
    whitelist: z.ZodOptional<z.ZodObject<{
        hashtags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        mentions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strict", z.ZodTypeAny, {
        hashtags?: string[] | undefined;
        mentions?: string[] | undefined;
    }, {
        hashtags?: string[] | undefined;
        mentions?: string[] | undefined;
    }>>;
    examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
        situation: z.ZodString;
        bad: z.ZodOptional<z.ZodString>;
        good: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        situation: string;
        good?: string | undefined;
        bad?: string | undefined;
    }, {
        situation: string;
        good?: string | undefined;
        bad?: string | undefined;
    }>, "many">>;
    output_contracts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        schema_hint: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        description?: string | undefined;
        schema_hint?: string | undefined;
    }, {
        description?: string | undefined;
        schema_hint?: string | undefined;
    }>>>;
    extra_instructions: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    identity?: {
        name?: string | undefined;
        role?: string | undefined;
        tone?: "concise" | "detailed" | "pedagogical" | undefined;
        formality?: "casual" | "formal" | "technical" | undefined;
        language?: string | undefined;
    } | undefined;
    traits?: string[] | undefined;
    domain_expertise?: string[] | undefined;
    communication?: {
        max_response_length?: number | undefined;
        use_analogies?: boolean | undefined;
        explain_reasoning?: "always" | "never" | "on_error" | undefined;
        acknowledgment_style?: "none" | "minimal" | "detailed" | undefined;
    } | undefined;
    directives?: {
        must?: string[] | undefined;
        must_not?: string[] | undefined;
    } | undefined;
    forbidden_patterns?: {
        name: string;
        pattern: string;
        scope?: string | undefined;
    }[] | undefined;
    whitelist?: {
        hashtags?: string[] | undefined;
        mentions?: string[] | undefined;
    } | undefined;
    examples?: {
        situation: string;
        good?: string | undefined;
        bad?: string | undefined;
    }[] | undefined;
    output_contracts?: Record<string, {
        description?: string | undefined;
        schema_hint?: string | undefined;
    }> | undefined;
    extra_instructions?: string | undefined;
}, {
    identity?: {
        name?: string | undefined;
        role?: string | undefined;
        tone?: "concise" | "detailed" | "pedagogical" | undefined;
        formality?: "casual" | "formal" | "technical" | undefined;
        language?: string | undefined;
    } | undefined;
    traits?: string[] | undefined;
    domain_expertise?: string[] | undefined;
    communication?: {
        max_response_length?: number | undefined;
        use_analogies?: boolean | undefined;
        explain_reasoning?: "always" | "never" | "on_error" | undefined;
        acknowledgment_style?: "none" | "minimal" | "detailed" | undefined;
    } | undefined;
    directives?: {
        must?: string[] | undefined;
        must_not?: string[] | undefined;
    } | undefined;
    forbidden_patterns?: {
        name: string;
        pattern: string;
        scope?: string | undefined;
    }[] | undefined;
    whitelist?: {
        hashtags?: string[] | undefined;
        mentions?: string[] | undefined;
    } | undefined;
    examples?: {
        situation: string;
        good?: string | undefined;
        bad?: string | undefined;
    }[] | undefined;
    output_contracts?: Record<string, {
        description?: string | undefined;
        schema_hint?: string | undefined;
    }> | undefined;
    extra_instructions?: string | undefined;
}>;
```

### `personaTags`

```typescript
export function personaTags(agentId: string): string[];
```

### `PersonaTone`

```typescript
export const PersonaTone: z.ZodEnum<["concise", "detailed", "pedagogical"]>;
```

### `PersonaTone`

```typescript
export type PersonaTone = z.infer<typeof PersonaTone>;
```

### `PhaseDef`

```typescript
export interface PhaseDef<TInput, TOutput> {
    readonly fn: (input: TInput, ctx: OODAContext) => Promise<TOutput>;
    readonly hitlGate?: boolean;
    readonly readOnly?: boolean;
    readonly type: OODAPhaseKind;
}
```

### `PhaseModelConfig`

```typescript
export interface PhaseModelConfig {
    defaultModel: ModelSpec;
    phases: Partial<Record<OODAPhaseKind, ModelSpec>>;
}
```

### `PII_GUARD`

```typescript
export const PII_GUARD: GuardrailDef<string>;
```

### `PIIDetector`

```typescript
export type PIIDetector = (value: unknown) => boolean;
```

### `PillarScores`

```typescript
export interface PillarScores {
    readonly atomicTransitionIntegrity: number;
    readonly recoveryEfficiency: number;
    readonly verificationCoverage: number;
}
```

### `PipelineApiRemovedError`

```typescript
export class PipelineApiRemovedError extends Error {
    constructor(method: "run" | "list" | "status");
}
```

### `PipelineListEntry`

```typescript
export interface PipelineListEntry {
    name: string;
    schedule?: string;
    tier: 1 | 2;
}
```

### `PipelineRunInput`

```typescript
export interface PipelineRunInput {
    name: string;
    payload?: Record<string, unknown>;
}
```

### `PipelineRunResult`

```typescript
export interface PipelineRunResult {
    pipelineId: string;
    runId: string;
    statusUrl: string;
}
```

### `PipelinesClient`

```typescript
export interface PipelinesClient {
    // @deprecated (undocumented)
    list(): Promise<{
        pipelines: PipelineListEntry[];
    }>;
    // @deprecated (undocumented)
    run(input: PipelineRunInput): Promise<PipelineRunResult>;
    // @deprecated (undocumented)
    status(pipelineId: string): Promise<{
        status: string;
        progress: number;
    }>;
}
```

### `PipelinesClientOptions`

```typescript
export interface PipelinesClientOptions {
    baseUrl: string;
    getToken: () => Promise<string>;
}
```

### `Plan`

```typescript
export interface Plan {
    estimatedTokens?: number;
    goal: string;
    steps: PlanStep[];
}
```

### `PlanExecutionResult`

```typescript
export interface PlanExecutionResult {
    completedSteps: number;
    failedSteps: number;
    plan: Plan;
    results: StepResult[];
    totalDurationMs: number;
}
```

### `PlanStep`

```typescript
export interface PlanStep {
    description: string;
    index: number;
    params?: Record<string, unknown>;
    tool?: string;
}
```

### `POD_START_STAGES`

```typescript
export const POD_START_STAGES: readonly ["requested", "approved", "cert_minted", "committed", "reconciling", "announced"];
```

### `PodStartProgressPayload`

```typescript
export type PodStartProgressPayload = z.infer<typeof PodStartProgressPayloadSchema>;

// Warning: (ae-missing-release-tag) "PodStartProgressPayloadSchema" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `PodStartProgressPayloadSchema`

```typescript
export const PodStartProgressPayloadSchema: z.ZodObject<{
    stage: z.ZodEnum<["requested", "approved", "cert_minted", "committed", "reconciling", "announced"]>;
    detail: z.ZodOptional<z.ZodString>;
    failed: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    stage: "approved" | "requested" | "cert_minted" | "committed" | "reconciling" | "announced";
    failed?: boolean | undefined;
    detail?: string | undefined;
}, {
    stage: "approved" | "requested" | "cert_minted" | "committed" | "reconciling" | "announced";
    failed?: boolean | undefined;
    detail?: string | undefined;
}>;
```

### `PodStartProgressStage`

```typescript
export type PodStartProgressStage = z.infer<typeof PodStartProgressPayloadSchema>["stage"];
```

### `PolicyAction`

```typescript
export type PolicyAction = "proceed" | "block" | "escalate_human" | "log";
```

### `PolicyCheckName`

```typescript
export type PolicyCheckName = "recipient" | "network" | "amount" | "purpose" | "freshness";
```

### `PolicyCheckResult`

```typescript
export interface PolicyCheckResult {
    check: PolicyCheckName;
    detail?: string;
    passed: boolean;
}
```

### `PolicyConflict`

```typescript
export interface PolicyConflict {
    readonly description: string;
    readonly rule1Id: string;
    readonly rule2Id: string;
    readonly status: "CONFLICT" | "CONFLICT_UNDETERMINED";
}
```

### `PolicyDecision`

```typescript
export interface PolicyDecision {
    action: PolicyAction;
    rationale: string;
}
```

### `PolicyValidation`

```typescript
export interface PolicyValidation {
    readonly policy_hash?: string;
    readonly valid: boolean;
    readonly violations: readonly string[];
}
```

### `PortError`

```typescript
export abstract class PortError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
        retryable?: boolean;
    });
    abstract readonly port: string;
    readonly retryable: boolean;
}
```

### `PortfolioId`

```typescript
export type PortfolioId = string & {
    readonly __brand: "PortfolioId";
};

// Warning: (ae-missing-release-tag) "POST_CHAR_LIMIT" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `POST_CHAR_LIMIT`

```typescript
export const POST_CHAR_LIMIT = 280;
```

### `PostgresAgentRegistry`

```typescript
export class PostgresAgentRegistry implements AgentRegistryPort {
    constructor(db: DbClient);
    list(filter?: Partial<AgentRegistryDescriptor>): Promise<AgentRegistryDescriptor[]>;
    register(descriptor: AgentRegistryDescriptor): Promise<void>;
    resolve(capability: string, opts?: {
        tenantId?: string;
    }): Promise<AgentRegistryDescriptor[]>;
    unregister(id: string): Promise<void>;
}
```

### `PostgresHITLStateStore`

```typescript
export class PostgresHITLStateStore implements HITLPort {
    constructor(input: {
        db: DbClient;
    });
    await(id: string, timeoutMs?: number): Promise<HITLState>;
    expire(id: string): Promise<void>;
    _expireOverdue(): Promise<void>;
    getState(id: string): Promise<HITLState>;
    request(req: HITLRequest): Promise<string>;
    resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void>;
}
```

### `PostmortemInput`

```typescript
export interface PostmortemInput {
    readonly campaign_slug: string;
    readonly lessons: readonly string[];
    readonly metrics: Readonly<Record<string, number>>;
    readonly outcome: "success" | "partial" | "failure";
    readonly what_failed: readonly string[];
    readonly what_worked: readonly string[];
}
```

### `PriceEntry`

```typescript
export interface PriceEntry {
    asset: string;
    fetchedAt: string;
    priceUsd: number;
    source: string;
}
```

### `PricePort`

```typescript
export interface PricePort {
    getPrice(asset: string): Promise<number | null>;
    getPrices(assets: string[]): Promise<Record<string, number | null>>;
}
```

### `primaryTarget`

```typescript
export function primaryTarget(roster: BrainRoster): BrainTarget | null;
```

### `PrivacyNoopWarning`

```typescript
export class PrivacyNoopWarning extends Error {
    constructor(message: string, operation: string);
    readonly operation: string;
}
```

### `PrivacyPort`

```typescript
export interface PrivacyPort {
    applyMask(payload: unknown, mask: RevelationMask, ctx: PrivacyContext): Promise<unknown>;
    commitToSmt(commitment: Commitment, ctx: PrivacyContext): Promise<SmtResult>;
    verifyZkProof(proof: ZkProofInput, ctx: PrivacyContext): Promise<VerifyResult>;
}
```

### `ProactiveCandidate`

```typescript
export interface ProactiveCandidate {
    readonly observedAt: string;
    readonly payload: Record<string, unknown>;
    readonly recallStrength?: number;
    readonly source: "turn" | "schedule" | "event" | "sensor";
    readonly subject: string;
}
```

### `ProactiveQueuePort`

```typescript
export interface ProactiveQueuePort {
    drainPending(): Promise<ProactiveCandidate[]>;
    enqueue(c: ProactiveCandidate): Promise<void>;
    markDone(ids: string[]): Promise<void>;
}
```

### `ProactiveTriggerPort`

```typescript
export interface ProactiveTriggerPort {
    readonly source: ProactiveCandidate["source"];
    start(emit: (c: ProactiveCandidate) => void): Promise<void>;
    stop(): Promise<void>;
}
```

### `ProceduralMemoryPort`

```typescript
export interface ProceduralMemoryPort {
    registerSkill(agentId: string, skill: ProceduralSkill): Promise<void>;
    resolveSkills(agentId: string): Promise<ProceduralSkill[]>;
    shareSkill(skillName: string, fromAgentId: string, toAgentIds: string[]): Promise<void>;
}
```

### `ProceduralSkill`

```typescript
export interface ProceduralSkill {
    chainOfThought?: string;
    confidence: number;
    description: string;
    name: string;
    source: "learning-loop" | "manual" | "shared";
}
```

### `ProductiveQualityInputs`

```typescript
export interface ProductiveQualityInputs extends QualityInputs {
    readonly workUnits?: number;
}
```

### `PROFITABLE`

```typescript
export const PROFITABLE: Axiom;
```

### `profitableScorer`

```typescript
export const profitableScorer: ScoringFunction;
```

### `ProgressCallback`

```typescript
export type ProgressCallback = (value: number, message?: string) => void;
```

### `PromiseProgressConfig`

```typescript
export interface PromiseProgressConfig {
    plateauEpsilon?: number;
    plateauWindow?: number;
}
```

### `PromiseProgressSnapshot`

```typescript
export interface PromiseProgressSnapshot {
    isPlateau: boolean;
    observations: number;
    progress: number;
    promise: number;
}
```

### `PromiseProgressTracker`

```typescript
export class PromiseProgressTracker {
    constructor(goal: string, embedFn: EmbedFn, config?: PromiseProgressConfig);
    observe(output: string): Promise<PromiseProgressSnapshot>;
    reset(newGoal?: string): Promise<void>;
    snapshot(): PromiseProgressSnapshot;
}
```

### `ProofChain`

```typescript
export interface ProofChain {
    algorithm: "sha-256";
    entries: ProofChainEntry[];
    rootHash: string;
}
```

### `ProofChainEntry`

```typescript
export interface ProofChainEntry {
    index: number;
    stepHash: string;
}
```

### `ProofClaim`

```typescript
export interface ProofClaim {
    agent: {
        id: string;
        version: string;
    };
    agentSignature?: string;
    claimSignature?: string;
    completedAt: string;
    exportedAt: string;
    paymentAuthorization?: PaymentAuthorization;
    paymentReceipt?: SettlementReceipt;
    // Warning: (ae-forgotten-export) The symbol "ProofReceipt" needs to be exported by the entry point index.d.ts
    receipt?: ProofReceipt;
    rootHash: string;
    runId: string;
    startedAt: string;
    status: Trace["status"];
    stepCount: number;
    task?: string;
    traceSha256: string;
    readonly type: "preste-proof-claim";
    // Warning: (ae-forgotten-export) The symbol "PROOF_CLAIM_VERSION" needs to be exported by the entry point index.d.ts
    //
    readonly version: typeof PROOF_CLAIM_VERSION;
}
```

### `ProofClaimVerification`

```typescript
export interface ProofClaimVerification {
    reasons: string[];
    valid: boolean;
}
```

### `ProofGrade`

```typescript
export type ProofGrade = "attestation" | "attestation_custody_compatible" | "custody";
```

### `PROTOCOL_ENV`

```typescript
export const PROTOCOL_ENV: {
    readonly EXECUTION_ID: "VAUBAN_EXECUTION_ID";
    readonly AUTOMATION_NAME: "VAUBAN_AUTOMATION_NAME";
    readonly INPUT: "VAUBAN_INPUT";
    readonly TIMEOUT: "VAUBAN_TIMEOUT";
    readonly MODE: "VAUBAN_MODE";
};
```

### `ProtocolParseError`

```typescript
export class ProtocolParseError extends Error {
    constructor(reason: string, rawTail: string);
    readonly rawTail: string;
}
```

### `ProtocolResult`

```typescript
export type ProtocolResult<T = unknown> = {
    readonly status: "completed";
    readonly output: T;
} | {
    readonly status: "failed";
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
    };
};
```

### `ProtocolStatus`

```typescript
export type ProtocolStatus = "completed" | "failed";

// Warning: (ae-missing-release-tag) "provableActionGate" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `provableActionGate`

```typescript
export function provableActionGate(args: {
    policyId: string;
    policyVersion: string;
    adrEco: string;
    policy: DeterministicPolicy<ActionGateCall, GateDecisionCore_2>;
}): ActionGate;
```

### `proveEntryInclusion`

```typescript
export function proveEntryInclusion(index: SignedSkillIndex, skillId: string, version?: string): EntryInclusion | null;
```

### `ProvenancedEpisodicMemory`

```typescript
export class ProvenancedEpisodicMemory implements EpisodicMemoryPort {
    constructor(base: EpisodicMemoryPort, sign: SignFn, pubkeyHex: string, clock?: {
        now(): number;
    } | undefined);
    append(agentId: string, sessionId: string, eventType: string, content: string | Record<string, unknown>, opts?: EpisodicAppendOptions): Promise<string>;
    attestationFor(entry: MemoryContent): MemoryAttestation | null;
    query(filter: EpisodicQueryFilter): Promise<EpisodicEvent[]>;
    queryByTrace(traceId: string, opts?: {
        limit?: number;
    }): Promise<EpisodicMemoryEntry[]>;
    record(agentId: string, runId: string, event: string, metadata?: Record<string, unknown>, opts?: {
        traceId?: string;
    }): Promise<void>;
    since(agentId: string, sinceMs: number, opts?: {
        limit?: number;
    }): Promise<EpisodicMemoryEntry[]>;
    verifyEntry(entry: MemoryContent, verify: VerifyFn, opts?: {
        trustedPubkeys?: Iterable<string>;
    }): MemoryProvenanceResult;
}
```

### `ProviderRouter`

```typescript
export interface ProviderRouter {
    complete(request: ProviderRouterRequest, opts?: ProviderRouterCompleteOptions): Promise<ProviderRouterResponse>;
}
```

### `ProviderRouterCompleteOptions`

```typescript
export interface ProviderRouterCompleteOptions {
    onDelta?: (chunk: string) => void;
}
```

### `ProviderRouterError`

```typescript
export class ProviderRouterError extends Error {
    constructor(message: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
}
```

### `ProviderRouterRequest`

```typescript
export interface ProviderRouterRequest {
    maxTokens?: number;
    messages: Array<{
        role: string;
        content: string;
        toolName?: string;
    }>;
    tools?: unknown[];
}
```

### `ProviderRouterResponse`

```typescript
export interface ProviderRouterResponse {
    content: string;
    latencyMs: number;
    provider: string;
    toolCalls: Array<{
        name: string;
        args: unknown;
    }>;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
```

### `ProviderTier`

```typescript
export interface ProviderTier {
    costPerInputToken: number;
    costPerOutputToken: number;
    name: "free" | "cheap" | "mid" | "premium";
    qualityScore: number;
}
```

### `publishAllSignals`

```typescript
export function publishAllSignals(brainPort: SignalBrainPort, cycle: CycleSnapshot, scores: AxiomScoreEntry[]): Promise<void>;
```

### `PublishContext`

```typescript
export interface PublishContext {
    readonly actionId: string;
    readonly campaignSlug: string;
}
```

### `PublisherChannel`

```typescript
export type PublisherChannel = "x" | "linkedin" | "rempart" | "email" | "discord" | "github" | string;
```

### `PublisherPort`

```typescript
export interface PublisherPort {
    readonly channel: PublisherChannel;
    isConfigured(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
}
```

### `PublisherRegistry`

```typescript
export interface PublisherRegistry {
    channels(): readonly string[];
    get(channel: string): PublisherPort | null;
    pick(actionType: string, payload: Record<string, unknown> | null | undefined): PublisherPort | null;
}
```

### `PublisherRegistryInput`

```typescript
export interface PublisherRegistryInput {
    readonly discord?: PublisherPort;
    readonly email?: PublisherPort;
    readonly extras?: Readonly<Record<string, PublisherPort>>;
    readonly github?: PublisherPort;
    readonly linkedin?: PublisherPort;
    readonly rempart?: PublisherPort;
    readonly x?: PublisherPort;
}
```

### `PublishInput`

```typescript
export interface PublishInput {
    readonly context: PublishContext;
    readonly payload: Record<string, unknown>;
    readonly persona?: AgentPersona;
}
```

### `PublishResult`

```typescript
export interface PublishResult {
    readonly channel: string;
    readonly error?: string;
    readonly partial_failure_tweets?: number[];
    readonly posted_at?: string;
    readonly posted_id?: string;
    readonly posted_url?: string;
    readonly reason?: string;
    readonly status: PublishStatus;
}
```

### `publishSignal`

```typescript
export function publishSignal(brainPort: SignalBrainPort, cycle: CycleSnapshot, axiomId: AxiomId, score: number, rationale: string): Promise<void>;
```

### `PublishStatus`

```typescript
export type PublishStatus = "published" | "dlq" | "failed" | "partial";
```

### `QualityBreakdown`

```typescript
export interface QualityBreakdown {
    readonly contributions: readonly QualityContribution[];
    readonly score: number;
}
```

### `QualityContribution`

```typescript
export interface QualityContribution {
    readonly delta: number;
    readonly reason: string;
    readonly signal: string;
}
```

### `QualityInputs`

```typescript
export interface QualityInputs {
    readonly alertsSent?: number;
    readonly customScore?: number;
    readonly errorsEncountered?: number;
    readonly invoicesProcessed?: number;
    readonly lessons?: readonly unknown[];
    readonly postsPublished?: number;
    readonly postsRejectedByHITL?: number;
    readonly threatsBlocked?: number;
}
```

### `queryReflexionMemory`

```typescript
export function queryReflexionMemory(query: ReflexionQuery, querier: (q: string, filters?: Record<string, unknown>) => Promise<ReflexionEntry[]>): Promise<ReflexionEntry[]>;
```

### `QueueArchetype`

```typescript
export type QueueArchetype = "cron" | "event" | "interactive" | "orchestration";
```

### `RandomPort`

```typescript
export interface RandomPort {
    crypto(bytes: number): Promise<Uint8Array>;
    cryptoUuid(): string;
    next(): number;
    uuid(): string;
}
```

### `reactLoop`

```typescript
export function reactLoop(opts: ReactLoopOptions): Promise<ReactResult>;
```

### `ReactLoopLogger`

```typescript
export interface ReactLoopLogger {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
```

### `ReactLoopOptions`

```typescript
export interface ReactLoopOptions {
    allowedTools?: string[];
    executeTool: (call: ToolCall) => Promise<string>;
    finalizeAsTool?: boolean;
    finalizeToolName?: string;
    llm: LLMCompletionFn;
    logger?: ReactLoopLogger;
    loopId?: string;
    maxSteps?: number;
    maxToolCallSize?: number;
    onStep?: (step: ReactStep, meta: ReactStepMeta) => void | Promise<void>;
    signal?: AbortSignal;
    systemPrompt: string;
    task: string;
}
```

### `ReactMessage`

```typescript
export interface ReactMessage {
    content: string;
    name?: string;
    role: "system" | "user" | "assistant" | "tool";
    tool_call_id?: string;
}
```

### `ReactResult`

```typescript
export interface ReactResult {
    answer: string;
    steps: ReactStep[];
    totalSteps: number;
    truncated: boolean;
}
```

### `ReactStep`

```typescript
export interface ReactStep {
    action?: ToolCall;
    error?: string;
    index: number;
    observation?: string;
    thought: string;
}
```

### `ReactStepMeta`

```typescript
export interface ReactStepMeta {
    durationMs: number;
    iteration: number;
    loopId?: string;
}
```

### `readBlockNumber`

```typescript
export function readBlockNumber(receipt: unknown): number | null;
```

### `readExecutionModeFromEnv`

```typescript
export function readExecutionModeFromEnv(env: Record<string, string | undefined>, varName?: string): ExecutionMode;
```

### `RealClock`

```typescript
export class RealClock implements ClockPort {
    now(): number;
}
```

### `RealRandom`

```typescript
export class RealRandom implements RandomPort {
    constructor(seed?: number);
    crypto(bytes: number): Promise<Uint8Array>;
    cryptoUuid(): string;
    next(): number;
    uuid(): string;
}
```

### `rebindSubToken`

```typescript
export function rebindSubToken(opts: RebindSubTokenOptions): RebindSubTokenResult;
```

### `RebindSubTokenOptions`

```typescript
export interface RebindSubTokenOptions {
    jwk: EcP256Jwk;
    now?: () => number;
    oldSubToken: string;
    parentToken: string;
}
```

### `RebindSubTokenResult`

```typescript
export interface RebindSubTokenResult {
    expiresAt: number;
    newJti: string;
    oldJti: string;
    scope: SubTokenScope;
    subToken: string;
}
```

### `RecallChunk`

```typescript
export interface RecallChunk {
    readonly brain_id: string | null;
    readonly brain_slug: string | null;
    readonly category: string;
    readonly content: string;
    readonly created_at: string;
    readonly cross_encoder_score: number | null;
    readonly hybrid_score: number | null;
    readonly id: string;
    readonly pii_requires_encryption?: boolean | null;
    readonly score?: number | null;
    readonly score_source?: "cross_encoder" | "similarity" | "fused_relative" | (string & {}) | null;
    readonly sensitivity_label?: "public" | "internal" | "confidential" | "secret" | (string & {}) | null;
    readonly similarity: number | null;
    readonly tags: readonly string[];
}
```

### `RecalledPrior`

```typescript
export interface RecalledPrior {
    readonly content: string;
    readonly id: string;
    readonly strength: number;
}
```

### `recallEpisodicRrf`

```typescript
export function recallEpisodicRrf(entries: EpisodicMemoryEntry[], opts?: RecallRrfOptions): ScoredEntry<EpisodicMemoryEntry>[];
```

### `RecallOptions`

```typescript
export interface RecallOptions {
    readonly brainIds?: readonly string[];
    readonly minSimilarity?: number;
    readonly mode: "chunks" | "answer";
    readonly tags?: readonly string[];
    readonly tier?: "auto" | "fast" | "agentic";
    readonly topK?: number;
}
```

### `RecallResult`

```typescript
export interface RecallResult {
    readonly answer: string | null;
    readonly chunks: readonly RecallChunk[];
    readonly freshness: readonly FreshnessMarker[];
    readonly hops_used: number;
    readonly refs: readonly string[];
    readonly strategy_used: string;
}
```

### `RecallRrfOptions`

```typescript
export interface RecallRrfOptions extends RrfOptions {
    cosine?: EpisodicCosineFn;
}
```

### `ReceiptQueue`

```typescript
export interface ReceiptQueue {
    enqueue(entry: Omit<ReceiptQueueEntry, "hmac" | "attempts">, keyProvider: KeyProvider, keyId: string): Promise<void>;
    pending(): Promise<ReceiptQueueEntry[]>;
    process(adapter: TimestampPort, keyProvider: KeyProvider, keyId: string, opts?: {
        batchSize?: number;
        backoffMs?: readonly number[];
    }): Promise<{
        processed: number;
        failed: number;
        rejected: number;
    }>;
    size?(): Promise<number>;
}
```

### `ReceiptQueueEntry`

```typescript
export interface ReceiptQueueEntry {
    attempts: number;
    hmac: string;
    queuedAt: number;
    rootHash: string;
    runId: string;
}
```

### `ReceiptStatus`

```typescript
export type ReceiptStatus = "present" | "pending" | "failed";
```

### `recencyScore`

```typescript
export function recencyScore(nowMs: number, timestampMs: number, halflifeMs: number): number;
```

### `RECOGNIZED_CLAIM_KINDS`

```typescript
export const RECOGNIZED_CLAIM_KINDS: ReadonlySet<TeammateMessageClaim["kind"]>;
```

### `recommendStrategy`

```typescript
export function recommendStrategy(difficulty: DifficultyClass): string;
```

### `recomputeOutputHash`

```typescript
export function recomputeOutputHash(core: GateDecisionCore): Promise<string>;
```

### `reconstructDecisionCore`

```typescript
export function reconstructDecisionCore(d: BatteryDecision): GateDecisionCore;
```

### `reconstructInitialMessages`

```typescript
export function reconstructInitialMessages(trace: Trace, opts: ReconstructOptions): ReplayMessage[];
```

### `ReconstructOptions`

```typescript
export interface ReconstructOptions {
    originalUserMessage?: string;
    toStep: number;
}
```

### `RecordedClock`

```typescript
export class RecordedClock implements ClockPort {
    constructor(recordedTs: readonly number[]);
    clone(): RecordedClock;
    getCursor(): number;
    now(): number;
    reset(): void;
}
```

### `RecordedRandom`

```typescript
export class RecordedRandom implements RandomPort {
    constructor(recordedNext: readonly number[], recordedUuids: readonly string[], mode?: "strict" | "tolerant");
    clone(): RecordedRandom;
    crypto(bytes: number): Promise<Uint8Array>;
    cryptoUuid(): string;
    getNextCursor(): number;
    getUuidCursor(): number;
    next(): number;
    uuid(): string;
}
```

### `recordHITLDecision`

```typescript
export function recordHITLDecision(db: DbClient, hitlId: string, decision: HITLDecision, resolverUserId: string, rationale?: string): Promise<void>;
```

### `recordLlmUsage`

```typescript
export function recordLlmUsage(span: Span, usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    finishReason?: string;
    responseId?: string;
}): void;
```

### `recordOutcome`

```typescript
export function recordOutcome(span: Span, outcome: {
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
    stepCount?: number;
}): void;
```

### `RecordOutcomeOutput`

```typescript
export interface RecordOutcomeOutput {
    id: string;
    is_pending_backfill: boolean;
}

// Warning: (ae-forgotten-export) The symbol "RecordOutcomeInput" needs to be exported by the entry point index.d.ts
//
```

### `recordOutcomeSkill`

```typescript
export const recordOutcomeSkill: Skill<RecordOutcomeInput, RecordOutcomeOutput>;
```

### `recordRevocation`

```typescript
export function recordRevocation(jti: string, alreadyRevoked: boolean): void;
```

### `recordToolResult`

```typescript
export function recordToolResult(span: Span, result: {
    success: boolean;
    errorMessage?: string;
    outputSizeBytes?: number;
}): void;
```

### `recoveryEfficiency`

```typescript
export function recoveryEfficiency(toolCalls: readonly ScoredToolCall[]): number;
```

### `redisCircuitBreaker`

```typescript
export function redisCircuitBreaker(opts: RedisCircuitBreakerOptions): RiskGuard;
```

### `RedisCircuitBreakerOptions`

```typescript
export interface RedisCircuitBreakerOptions {
    failureThreshold: number;
    name: string;
```

### `RedisClientLike`

```typescript
export interface RedisClientLike {
    set(key: string, value: string, options: {
        nx: true;
        px: number;
    }): Promise<string | null>;
}
```

### `RedisNonceStore`

```typescript
export class RedisNonceStore implements NonceStore {
    constructor(redis: RedisClientLike);
    setNX(key: string, ttlMs: number): Promise<boolean>;
}

// Warning: (ae-missing-release-tag) "ReexecVerdict" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `ReexecVerdict`

```typescript
export interface ReexecVerdict<O> {
    ok: boolean;
    reason?: "policy-version-mismatch" | "output-mismatch";
    recomputed?: O;
}
```

### `ReflexionEntry`

```typescript
export interface ReflexionEntry {
    confidence: number;
    content: string;
    outcomeType: "succeeded" | "failed" | "partial";
    sourceCycleId: string;
    ttlMs?: number;
}
```

### `ReflexionQuery`

```typescript
export interface ReflexionQuery {
    agentId: string;
    limit?: number;
    outcomeType?: "succeeded" | "failed" | "partial";
}

// Warning: (ae-missing-release-tag) "RefuteFn" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RefuteFn`

```typescript
export type RefuteFn = (input: {
    stageId: string;
    artifact: string;
    angle: string;
}) => Promise<{
    refuted: boolean;
    rationale: string;
}>;
```

### `RegisteredScorer`

```typescript
export interface RegisteredScorer {
    axiomId: AxiomId | string;
    scorer: ScoringFunction;
}

// Warning: (ae-missing-release-tag) "registerW3CPropagator" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `registerW3CPropagator`

```typescript
export function registerW3CPropagator(): void;
```

### `RegistrationResult`

```typescript
export interface RegistrationResult {
    readonly claim_id: string;
    readonly errors?: readonly ComplianceError[];
    readonly manifest_id?: string;
    // Warning: (ae-forgotten-export) The symbol "RegistrationStatus" needs to be exported by the entry point index.d.ts
    //
    readonly status: RegistrationStatus;
}
```

### `RejectedCandidate`

```typescript
export interface RejectedCandidate {
    readonly candidateHash: string;
    readonly candidateIndex: number;
    readonly reason: string;
}
```

### `RelayConnection`

```typescript
export interface RelayConnection {
    close(): Promise<void>;
    isPaired(): boolean;
    readonly pairing: PairingPayload;
}
```

### `RemoteApprovalChannel`

```typescript
export interface RemoteApprovalChannel extends ApprovalChannel {
    dispose(): void;
    // Warning: (ae-forgotten-export) The symbol "RemoteHitlRecord" needs to be exported by the entry point index.d.ts
    history(): RemoteHitlRecord[];
    pending(): Array<{
        id: string;
        agentId: string;
        action: string;
        context: string;
    }>;
    resolve(id: string, approved: boolean, by: string, note?: string, scope?: "session" | "always"): boolean;
}
```

### `RemoteControlPort`

```typescript
export interface RemoteControlPort extends SessionEventSink {
    backlog(sinceSeq?: number): SessionEvent[];
    backlogOldestSeq(): number | null;
    readonly inbox: InstructionInbox;
    observerSink(): SessionEventSink;
    state(): SessionState;
    subscribe(fn: (event: SessionEvent) => void): () => void;
    readonly vetoChannel: VetoChannel;
}
```

### `RemoteControlServerHandle`

```typescript
export interface RemoteControlServerHandle {
    close(): Promise<void>;
    readonly url: string;
}

// Warning: (ae-missing-release-tag) "RemoteControlServerOptions" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RemoteControlServerOptions`

```typescript
export interface RemoteControlServerOptions {
    allowedOrigins?: string[];
    approvalChannel?: RemoteApprovalChannel;
    dpopReplayStore?: DpopReplayStore;
    host?: string;
    persistence?: PersistencePort;
    port?: number;
    publicBaseUrl?: string;
    teammateEventSink?: TeammateEventSinkPort;
    teammateInfo?: TeammateInfoPort;
    teammateSend?: TeammateSendPort;
    token?: string;
}
```

### `RempartMcpCaller`

```typescript
export type RempartMcpCaller = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
```

### `RempartPublisher`

```typescript
export class RempartPublisher implements PublisherPort {
    constructor(cfg: RempartPublisherConfig);
    readonly channel: "rempart";
    isConfigured(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
}
```

### `RempartPublisherConfig`

```typescript
export interface RempartPublisherConfig {
    readonly mcpCaller: RempartMcpCaller;
}

// Warning: (ae-forgotten-export) The symbol "RenderOptions" needs to be exported by the entry point index.d.ts
//
```

### `renderEventForChat`

```typescript
export function renderEventForChat(event: SessionEvent, opts?: RenderOptions): string | null;
```

### `renderMemoryContext`

```typescript
export function renderMemoryContext(chunks: readonly RecallChunk[]): string;
```

### `RenewalManager`

```typescript
export class RenewalManager {
    constructor(opts: RenewalManagerOptions);
    maybeRenew(): Promise<boolean>;
}
```

### `RenewalManagerOptions`

```typescript
export interface RenewalManagerOptions {
    readonly gate: CapabilityGate;
    readonly now?: () => number;
    readonly reissue: (req: RenewalRequest) => Promise<RenewedToken>;
    readonly thresholdFraction?: number;
}
```

### `RenewalRequest`

```typescript
export interface RenewalRequest {
    readonly currentToken?: string;
    readonly expiresAtEpochSeconds: number;
    readonly issuedAtEpochSeconds: number;
}
```

### `RenewedToken`

```typescript
export interface RenewedToken {
    readonly expiresAtEpochSeconds: number;
    readonly issuedAtEpochSeconds: number;
    readonly token: string;
}
```

### `repairCoherenceModel`

```typescript
export function repairCoherenceModel(raw: unknown): CoherenceModel;
```

### `RePlanner`

```typescript
export type RePlanner<TOutput = unknown> = (ctx: {
    readonly failed: NodeManifestEntry<TOutput>;
    readonly spec: DagNodeSpec;
    readonly inputs: NodeInputs;
    readonly manifest: ReadonlyArray<NodeManifestEntry<TOutput>>;
}) => Promise<DagNodeSpec[] | null>;
```

### `ReplayContext`

```typescript
export interface ReplayContext {
    readonly cache: LLMResponseCache;
    readonly clock: ClockPort;
    readonly mode: ReplayMode;
    readonly originalRunId: string;
    readonly random: RandomPort;
    readonly replayRunId: string;
}
```

### `ReplayDetectedError`

```typescript
export class ReplayDetectedError extends Error {
    constructor(idempotencyKey: string);
    readonly idempotencyKey: string;
}
```

### `replayFrom`

```typescript
export function replayFrom(runId: string, loader: ReplayLoader, runner: ReplayRunner, opts?: {
    mode?: ReplayMode;
    fromStepIndex?: number;
}): Promise<ReplayResult>;
```

### `ReplayLoader`

```typescript
export interface ReplayLoader {
    loadCacheEntries(runId: string): Promise<{
        recordedTs: number[];
        recordedNext: number[];
        recordedUuids: string[];
        cache: LLMResponseCache;
    }>;
    loadOriginalTrace(runId: string): Promise<Trace>;
}
```

### `ReplayMessage`

```typescript
export interface ReplayMessage {
    content: string;
    role: "user" | "assistant" | "tool";
    toolName?: string;
}
```

### `ReplayMode`

```typescript
export type ReplayMode = "strict" | "tolerant";
```

### `ReplayResult`

```typescript
export interface ReplayResult {
    diff?: {
        stepIndex: number;
        field: keyof TraceStep;
        original: unknown;
        replayed: unknown;
    }[];
    match: boolean;
    replayRunId: string;
    trace: Trace;
}
```

### `ReplayRunner`

```typescript
export interface ReplayRunner {
    run(ctx: ReplayContext, originalTrace: Trace): Promise<Trace>;
}
```

### `reportRunFinish`

```typescript
export function reportRunFinish(opts: {
    runId: string;
    status: "success" | "failed" | "completed";
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    errorMessage?: string;
}): Promise<void>;
```

### `reportRunStart`

```typescript
export function reportRunStart(opts: {
    agentId: string;
    runId?: string;
    model?: string;
    provider?: string;
}): Promise<{
    id: string;
} | null>;
```

### `requiredScopeForControlVerb`

```typescript
export function requiredScopeForControlVerb(v: ControlVerb): ControlScope;
```

### `resetCircuitBreaker`

```typescript
export function resetCircuitBreaker(redisUrl: string, name: string, redisClientFactory?: (url: string) => MinimalRedisClient): Promise<void>;
```

### `resolveAuthScope`

```typescript
export function resolveAuthScope(parentToken: string, presentedToken: string, now?: number, isRevoked?: (jti: string) => boolean): SubTokenScope | undefined;
```

### `resolveAuthScopeInstrumented`

```typescript
export function resolveAuthScopeInstrumented(parentToken: string, presentedToken: string, now?: number, isRevoked?: (jti: string) => boolean): SubTokenScope | undefined;

// Warning: (ae-forgotten-export) The symbol "Env" needs to be exported by the entry point index.d.ts
//
```

### `resolveBrainRoster`

```typescript
export function resolveBrainRoster(env: Env, opts?: BrainRosterOptions): BrainRoster;
```

### `ResolvedPersona`

```typescript
export interface ResolvedPersona {
    effective: AgentPersona;
    layers: Array<"defaults" | "brain" | "local">;
}
```

### `resolveForPhase`

```typescript
export function resolveForPhase(config: PhaseModelConfig, phase: OODAPhaseKind): ModelSpec;
```

### `resolvePersona`

```typescript
export function resolvePersona(opts: ResolvePersonaOptions): Promise<ResolvedPersona>;
```

### `ResolvePersonaOptions`

```typescript
export interface ResolvePersonaOptions {
    agentId: string;
    brain?: SemanticMemoryPort;
    localPath?: string;
}
```

### `resolveSchema`

```typescript
export function resolveSchema(type: string): z.ZodObject<z.ZodRawShape> | undefined;
```

### `resolveSkillsForAgent`

```typescript
export function resolveSkillsForAgent(skills: readonly SkillLedgerEntry[], opts: ResolveSkillsOptions): SkillLedgerEntry[];
```

### `ResolveSkillsOptions`

```typescript
export interface ResolveSkillsOptions {
    agentId: string;
    limit?: number;
    outcomeType: string;
}
```

### `resolveTier`

```typescript
export function resolveTier(manifest: SkillManifest): VaubanSkillTier;
```

### `resolveWriteTarget`

```typescript
export function resolveWriteTarget(roster: BrainRoster, name: string | undefined, opts?: {
    readonly envPrefixes?: readonly string[];
}): WriteTargetResolution;
```

### `ResourceLimits`

```typescript
export interface ResourceLimits {
    readonly maxHeapMb?: number;
    readonly maxStepsPerCycle?: number;
    readonly phaseTimeoutMs?: number;
}
```

### `ResourceLimitsOpts`

```typescript
export interface ResourceLimitsOpts {
    maxHeapMb: number;
    maxStepsPerCycle: number;
    onHeapExceeded?: (info: {
        rssMb: number;
        heapMb: number;
        max: number;
    }) => void;
    phaseTimeoutMs: number;
}
```

### `ResourceLimitsRunner`

```typescript
export class ResourceLimitsRunner {
    constructor(opts?: Partial<ResourceLimitsOpts>);
    checkHeap(): void;
    createPhaseAbortController(): AbortController;
    enforceStepCount(currentCount: number): void;
    readonly maxHeapMb: number;
    readonly maxStepsPerCycle: number;
    readonly phaseTimeoutMs: number;
}
```

### `restoreSessionContext`

```typescript
export function restoreSessionContext(semanticMemory: SemanticMemoryPort, sessionTag: string, limit?: number): Promise<string | null>;
```

### `ResumeWorkflowOpts`

```typescript
export interface ResumeWorkflowOpts {
    readonly leaseTtlSeconds?: number;
    readonly workerId: string;
}
```

### `retry`

```typescript
export function retry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
```

### `RETRY_AGGRESSIVE`

```typescript
export const RETRY_AGGRESSIVE: RetryConfig;
```

### `RETRY_PATIENT`

```typescript
export const RETRY_PATIENT: RetryConfig;
```

### `RETRY_TRANSIENT`

```typescript
export const RETRY_TRANSIENT: RetryConfig;
```

### `RetryConfig`

```typescript
export interface RetryConfig {
    readonly baseDelayMs: number;
    readonly exponentialBase: number;
    readonly jitter: boolean;
    readonly maxAttempts: number;
    readonly maxDelayMs: number;
    readonly retryIf?: (err: unknown) => boolean;
    readonly retryOn?: ReadonlyArray<new (...args: never[]) => Error>;
}
```

### `RetryContext`

```typescript
export class RetryContext {
    constructor(opts: RetryOptions & {
        config: RetryConfig;
    });
    get attempt(): number;
    handleError(err: unknown): Promise<void>;
    get shouldContinue(): boolean;
}
```

### `RetryExhaustedError`

```typescript
export class RetryExhaustedError extends Error {
    constructor(attempts: number, lastError: unknown);
    readonly attempts: number;
    readonly lastError: unknown;
}
```

### `RetryOptions`

```typescript
export interface RetryOptions {
    config?: RetryConfig;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
    randomFn?: () => number;
    sleepFn?: SleepFn;
}
```

### `RIGOR_PILLAR_WEIGHTS`

```typescript
export const RIGOR_PILLAR_WEIGHTS: RigorWeights;
```

### `RIGORBENCH_PILLARS_SCORED`

```typescript
export const RIGORBENCH_PILLARS_SCORED = 3;
```

### `RIGORBENCH_PILLARS_TOTAL`

```typescript
export const RIGORBENCH_PILLARS_TOTAL = 5;
```

### `RigorScoreInput`

```typescript
export interface RigorScoreInput {
    readonly evidenceCount: number;
    readonly gapCount: number;
    readonly toolCalls: readonly ScoredToolCall[];
}
```

### `RigorScoreResult`

```typescript
export interface RigorScoreResult {
    readonly composite: number;
    readonly pillars: PillarScores;
    readonly pillarsScored: number;
    readonly pillarsTotal: number;
    readonly rationale: string;
}
```

### `RigorWeights`

```typescript
export interface RigorWeights {
    readonly atomicTransitionIntegrity: number;
    readonly recoveryEfficiency: number;
    readonly verificationCoverage: number;
}
```

### `RiskGuard`

```typescript
export interface RiskGuard {
    check(ctx: OODAContext): Promise<{
        proceed: boolean;
        reason?: string;
    }>;
    readonly name: string;
}
```

### `RiskGuardState`

```typescript
export interface RiskGuardState {
    failure_count: number;
    last_failure: string | null;
    name: string;
    reset_after: string | null;
    state: "closed" | "open" | "half-open";
}
```

### `riskScore`

```typescript
export function riskScore(v: RiskVector, weights?: Partial<RiskVector>): number;
```

### `RiskVector`

```typescript
export interface RiskVector {
    blastRadius: number;
    confidence: number;
    dataSensitivity: number;
    externalSideEffect: number;
    reversibility: number;
}
```

### `ROBUSTE`

```typescript
export const ROBUSTE: Axiom;
```

### `robusteScorer`

```typescript
export const robusteScorer: ScoringFunction;
```

### `RoiPerAgent`

```typescript
export interface RoiPerAgent {
    agent_id: string;
    cost_cents: number;
    net_roi_pct: number | null;
    outcome_count: number;
    pending_ratio: number;
    period: {
        from: string;
        to: string;
    };
    value_cents: number;
    wow_delta_pct: number | null;
}
```

### `RouteDecision`

```typescript
export interface RouteDecision {
    blockedByBreaker: boolean;
    mode: EconomyMode;
    reason: string;
    tier: ModelTier;
}
```

### `RrfOptions`

```typescript
export interface RrfOptions {
    now?: () => number;
    recencyHalflifeMs?: number;
    topK?: number;
    weights?: Partial<RrfWeights>;
}
```

### `RrfScorers`

```typescript
export interface RrfScorers<T> {
    cosine: (entry: T) => number;
    importance: (entry: T) => number;
    timestamp: (entry: T) => number;
}
```

### `RrfWeights`

```typescript
export interface RrfWeights {
    cosine: number;
    importance: number;
    recency: number;
}
```

### `rthSession`

```typescript
export function rthSession(opts?: RTHSessionOptions): SessionGuard;
```

### `RTHSessionOptions`

```typescript
export interface RTHSessionOptions {
    tz?: string;
}
```

### `RuleSource`

```typescript
export type RuleSource = "declared" | "normative";

// Warning: (ae-missing-release-tag) "runConfigValidation" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `runConfigValidation`

```typescript
export function runConfigValidation(artifact: string, readFile: FileReader_2 | undefined): ConfigValidationResult;

// Warning: (ae-missing-release-tag) "runDag" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `runDag`

```typescript
export function runDag<TOutput = unknown>(input: DagRunInput<TOutput>): Promise<DagRunManifest<TOutput>>;
```

### `runDebate`

```typescript
export function runDebate(config: DebateConfig): Promise<DebateResult>;

// Warning: (ae-missing-release-tag) "runDriftGate" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `runDriftGate`

```typescript
export function runDriftGate(input: RunDriftGateInput): Promise<RunGateResult>;

// Warning: (ae-missing-release-tag) "RunDriftGateInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunDriftGateInput`

```typescript
export interface RunDriftGateInput {
    readonly adrEco: string;
    readonly artifact: string;
    readonly driftArtifact: DriftArtifact | null | undefined;
    readonly exec: ExecFn | undefined;
    readonly intent: FrozenIntent | null | undefined;
    readonly keyid: string;
    readonly primaryEnvelope: GateVerdictEnvelope;
    readonly sign: SignFn;
}
```

### `runExpireJob`

```typescript
export function runExpireJob(store: HITLPort & {
    _expireOverdue?: () => Promise<void>;
}, intervalMs?: number): NodeJS.Timeout;

// Warning: (ae-missing-release-tag) "runGate" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `runGate`

```typescript
export function runGate(input: RunGateInput): Promise<RunGateResult>;

// Warning: (ae-missing-release-tag) "RunGateAdversaryInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunGateAdversaryInput`

```typescript
export interface RunGateAdversaryInput {
    readonly config: AdversaryConfigInput;
    readonly refute: RefuteFn;
}

// Warning: (ae-missing-release-tag) "RunGateInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunGateInput`

```typescript
export interface RunGateInput extends RunGateUnsignedInput {
    readonly keyid: string;
    readonly sign: SignFn;
}

// Warning: (ae-missing-release-tag) "RunGateResult" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunGateResult`

```typescript
export interface RunGateResult {
    readonly accepted: boolean;
    readonly envelope: GateVerdictEnvelope;
    readonly reasons: readonly string[];
}

// Warning: (ae-missing-release-tag) "runGateUnsigned" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `runGateUnsigned`

```typescript
export function runGateUnsigned(input: RunGateUnsignedInput): Promise<RunGateUnsignedResult>;

// Warning: (ae-missing-release-tag) "RunGateUnsignedInput" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunGateUnsignedInput`

```typescript
export interface RunGateUnsignedInput {
    readonly adrEco: string;
    readonly adversary?: RunGateAdversaryInput;
    readonly anchors: readonly AnchorSpecInput[];
    readonly artifact: string;
    readonly attempt: number;
    readonly chainHead?: string;
    readonly commit: string;
    readonly engineVerdicts?: ReadonlyMap<string, EngineVerdict>;
    readonly exec?: ExecFn;
    readonly gitExec?: ExecFn;
    readonly grounded?: GroundedTestResult;
    readonly policyDigest?: string;
    readonly producerId: string;
    readonly readFile?: FileReader_2;
    readonly runId: string;
    readonly stageId: string;
    readonly twinLenses?: readonly BatteryLens<string>[];
}

// Warning: (ae-missing-release-tag) "RunGateUnsignedResult" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunGateUnsignedResult`

```typescript
export interface RunGateUnsignedResult {
    readonly accepted: boolean;
    readonly envelope: UnsignedGateVerdictEnvelope;
    readonly reasons: readonly string[];
}

// Warning: (ae-missing-release-tag) "runGroundedTests" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `runGroundedTests`

```typescript
export function runGroundedTests(artifact: string, exec: ExecFn | undefined, envelopeCommit?: string, gitExec?: ExecFn | undefined): GroundedTestResult;
```

### `RunJournalPort`

```typescript
export interface RunJournalPort {
    append(msg: LogMessage, meta?: JournalAppendMeta): Promise<number>;
    readonly degraded: boolean;
    read(range: {
        from: number;
        to: number;
    }): Promise<JournalStep[]>;
    search(query: string, opts?: {
        topK?: number;
    }): Promise<JournalStep[]>;
}
```

### `runPostGuards`

```typescript
export function runPostGuards<TOutput>(guards: readonly GuardrailDef<unknown, TOutput>[], output: TOutput, ctx: OODAContext): Promise<GuardrailViolation | null>;
```

### `runPreGuards`

```typescript
export function runPreGuards<TInput>(guards: readonly GuardrailDef<TInput, unknown>[], input: TInput, ctx: OODAContext): Promise<GuardrailViolation | null>;
```

### `RunsClient`

```typescript
export interface RunsClient {
    getAnomalies(agentId: string): Promise<Anomaly[]>;
    getCircuitBreakers(): Promise<CircuitBreakerSnapshot[]>;
    getHealth(agentId: string, window?: "24h" | "7d" | "30d"): Promise<AgentHealth>;
    subscribeToRun(runId: string, opts: Omit<SubscribeToRunOptions, "baseUrl" | "getToken">): Promise<SubscribeHandle>;
}
```

### `RunsClientOptions`

```typescript
export interface RunsClientOptions {
    baseUrl: string;
    getToken?: () => Promise<string>;
}

// Warning: (ae-forgotten-export) The symbol "RunSqlQueryInput" needs to be exported by the entry point index.d.ts
//
```

### `runSqlQuery`

```typescript
export const runSqlQuery: Skill<RunSqlQueryInput, RunSqlQueryOutput>;
```

### `RunSqlQueryOutput`

```typescript
export interface RunSqlQueryOutput {
    rowCount: number;
    rows: object[];
}

// Warning: (ae-missing-release-tag) "RunStatePort" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `RunStatePort`

```typescript
export interface RunStatePort {
    forkAt(toStep: number): readonly TraceStep[];
    headHash(): string;
    readPrefix(toStep?: number): readonly TraceStep[];
}
```

### `RunStep`

```typescript
export interface RunStep {
    duration_ms?: number | null;
    error_message?: string | null;
    finished_at?: string | null;
    id: string;
    leaf_hash_poseidon?: string | null;
    mcp_call_hash?: string | null;
    otel_span_id?: string | null;
    otel_trace_id?: string | null;
    parent_step_id?: string | null;
    payload?: Record<string, unknown> | null;
    phase?: string | null;
    retrieval_proof_hash?: string | null;
    run_id: string;
    started_at: string;
    status: "pending" | "done" | "error" | "skipped";
    step_index: number;
    type: "retrieval" | "decision" | "execution" | "feedback" | "observation";
}
```

### `RunStreamEvent`

```typescript
export interface RunStreamEvent {
    data: RunStep | {
        status: string;
        duration_ms?: number;
    } | {
        error: string;
    } | undefined;
    id?: string;
    name: RunStreamEventName;
}
```

### `RunStreamEventName`

```typescript
export type RunStreamEventName = "step_existing" | "step_new" | "run_complete" | "ping" | "error";
```

### `runTwoPhaseOrient`

```typescript
export function runTwoPhaseOrient<C, O, R>(config: TwoPhaseOrientConfig<C, O, R>, context: C): Promise<TwoPhaseOrientResult<O, R>>;
```

### `runVerifierBattery`

```typescript
export function runVerifierBattery<TOutput>(input: unknown, candidates: readonly TOutput[], lenses: readonly BatteryLens<TOutput>[], opts: RunVerifierBatteryOptions): Promise<BatteryDecision<TOutput>>;
```

### `RunVerifierBatteryOptions`

```typescript
export interface RunVerifierBatteryOptions extends VerifierCtx {
    readonly adrEco: string;
    readonly runId: string;
    readonly signal?: AbortSignal;
    readonly voteThreshold?: number;
}
```

### `SandboxExecutor`

```typescript
export interface SandboxExecutor {
    run(job: SandboxJob): Promise<SandboxResult>;
}
```

### `SandboxJob`

```typescript
export interface SandboxJob {
    command: string[];
    cpuQuota?: number;
    cwd?: string;
    env?: Record<string, string>;
    image: string;
    memoryMb?: number;
    networkMode?: "none" | "outbound" | "bridge";
    readOnlyRoot?: boolean;
    stdin?: string;
    timeoutMs: number;
}
```

### `SandboxResult`

```typescript
export interface SandboxResult {
    durationMs: number;
    exitCode: number;
    stderr: string;
    stdout: string;
    timedOut: boolean;
}
```

### `SanitizedItem`

```typescript
export interface SanitizedItem<T> {
    item: T;
    kept: boolean;
    reason?: string;
}
```

### `sanitizeExternalInput`

```typescript
export function sanitizeExternalInput<T extends {
    content: string;
}>(items: T[], opts?: SanitizeConfig): SanitizedItem<T>[];
```

### `savePersonaToBrain`

```typescript
export function savePersonaToBrain(brain: SemanticMemoryPort, agentId: string, persona: AgentPersona): Promise<string | null>;
```

### `savePersonaToFile`

```typescript
export function savePersonaToFile(path: string, persona: AgentPersona): Promise<void>;
```

### `scopeAllows`

```typescript
export function scopeAllows(scope: MeshCapabilityScope, action: string): boolean;
```

### `scopeCovers`

```typescript
export function scopeCovers(granted: SubTokenScope, required: SubTokenScope): boolean;
```

### `scopeToSdkPermissions`

```typescript
export function scopeToSdkPermissions(scope: CcScope): MappedSdkPermissions;
```

### `ScoreComponents`

```typescript
export interface ScoreComponents {
    cosine: number;
    importance: number;
    recency: number;
}
```

### `ScoredEntry`

```typescript
export interface ScoredEntry<T> {
    components: ScoreComponents;
    entry: T;
    score: number;
}
```

### `ScoredToolCall`

```typescript
export interface ScoredToolCall {
    readonly args: unknown;
    readonly name: string;
    readonly observedExitCode?: number;
}
```

### `scoreEntries`

```typescript
export function scoreEntries<T>(entries: T[], scorers: RrfScorers<T>, opts?: RrfOptions): ScoredEntry<T>[];
```

### `scoreRigor`

```typescript
export function scoreRigor(input: RigorScoreInput): RigorScoreResult;
```

### `ScorerRegistry`

```typescript
export class ScorerRegistry {
    constructor();
    get(axiomId: AxiomId | string): ScoringFunction | undefined;
    list(): string[];
    register(axiomId: AxiomId | string, scorer: ScoringFunction): void;
    scoreAll(cycle: CycleSnapshot): Promise<Map<string, ScoringResult>>;
}
```

### `ScoringFunction`

```typescript
export type ScoringFunction = (cycle: CycleSnapshot) => Promise<ScoringResult>;
```

### `ScoringResult`

```typescript
export interface ScoringResult {
    rationale: string;
    score: number;
    signals: SignalPoint[];
}
```

### `SdkAgentLoop`

```typescript
export class SdkAgentLoop {
    constructor(config: SdkAgentLoopConfig);
    get permissions(): SdkPermissions;
    run(userMessage: string): Promise<SdkAgentLoopRunResult>;
}
```

### `SdkAgentLoopConfig`

```typescript
export interface SdkAgentLoopConfig {
    agentId: string;
    agentVersion: string;
    approvalChannel?: ApprovalChannel;
    approvalPollIntervalMs?: number;
    approvalTimeoutMs?: number;
    capabilityGate?: CapabilityGate;
    client: Anthropic;
    costPerToolCallUsd?: number;
    maxSteps?: number;
    maxTokens?: number;
    model?: string;
    onToolDenied?: (event: {
        toolName: string;
        reason: string;
        budgetUsed: number;
    }) => void;
    permissions: SdkPermissions;
    renewalManager?: RenewalManager;
    systemPrompt: string;
    tools: SdkToolRegistry;
    tracer?: Tracer;
}
```

### `SdkAgentLoopRunResult`

```typescript
export interface SdkAgentLoopRunResult {
    finalMessage: string;
    stopReason: "complete" | "budget_exhausted" | "tool_denied" | "user_cancelled" | "max_tokens" | "error";
    traceId: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
```

### `SdkCapability`

```typescript
export type SdkCapability = "bash" | "fileIO" | "web" | "mcp";
```

### `SdkEscalationLevel`

```typescript
export type SdkEscalationLevel = "L1_autonomous" | "L2_async_review" | "L3_hitl_required";
```

### `SdkPermissions`

```typescript
export interface SdkPermissions {
    readonly bash: BashMode;
    readonly fileIO: FileIOMode;
    readonly mcp: readonly string[];
    readonly web: boolean;
}
```

### `SdkToolRegistry`

```typescript
export type SdkToolRegistry = ToolRegistry;
```

### `SealedSprintClaim`

```typescript
export interface SealedSprintClaim {
    readonly anchor_id?: string;
    readonly sealed_at: Date;
    readonly sealed_by_agent: string;
    readonly sprint_id: string;
    readonly verification_evidence_hash: string;
}
```

### `SECRET_PATTERN`

```typescript
export const SECRET_PATTERN: RegExp;
```

### `SecretNotFoundError`

```typescript
export class SecretNotFoundError extends Error {
    constructor(secretName: string);
    readonly secretName: string;
}
```

### `SecretsAccessor`

```typescript
export interface SecretsAccessor {
    readonly accessedSecrets: ReadonlySet<string>;
    get(name: string, defaultValue?: string): string;
    has(name: string): boolean;
}
```

### `SelectionPolicy`

```typescript
export type SelectionPolicy = "argmax" | "mob";
```

### `selectTier`

```typescript
export function selectTier(query: string): "fast" | "agentic";
```

### `SemanticCoherenceConfig`

```typescript
export interface SemanticCoherenceConfig {
    similarityThreshold?: number;
    windowSize?: number;
}
```

### `SemanticCoherenceTracker`

```typescript
export class SemanticCoherenceTracker {
    constructor(embedFn: EmbedFn, config?: SemanticCoherenceConfig);
    observe(output: string): Promise<SemanticCoherenceVerdict>;
    reset(): void;
}
```

### `SemanticCoherenceVerdict`

```typescript
export interface SemanticCoherenceVerdict {
    isSemanticStall: boolean;
    meanCosine: number;
    windowSize: number;
}
```

### `SemanticMemoryPort`

```typescript
export interface SemanticMemoryPort {
    archive(entry: BrainEntryInput): Promise<BrainEntry | null>;
    query(q: string, filters?: BrainQueryFilters): Promise<BrainEntry[]>;
    recall?(query: string, opts: RecallOptions): Promise<RecallResult>;
}

// Warning: (ae-forgotten-export) The symbol "SendEmailInput" needs to be exported by the entry point index.d.ts
//
```

### `sendEmail`

```typescript
export const sendEmail: Skill<SendEmailInput, SendEmailOutput>;
```

### `SendEmailOutput`

```typescript
export interface SendEmailOutput {
    delivered: boolean;
    message_id: string | null;
    provider: "smtp" | "resend" | "replay";
}
```

### `sendHITLApprovalRequestSlack`

```typescript
export function sendHITLApprovalRequestSlack(opts: SendHITLSlackOpts): Promise<SlackApprovalResult>;
```

### `sendHITLApprovalRequestTelegram`

```typescript
export function sendHITLApprovalRequestTelegram(opts: SendHITLTelegramOpts): Promise<TelegramApprovalResult>;
```

### `SendHITLSlackOpts`

```typescript
export interface SendHITLSlackOpts {
    // Warning: (ae-forgotten-export) The symbol "SlackChannelConfig_2" needs to be exported by the entry point index.d.ts
    //
    channel: SlackChannelConfig_2;
    costDisplayUsd?: number;
    hitlPort: HITLPort;
    request: HITLRequest;
}
```

### `SendHITLTelegramOpts`

```typescript
export interface SendHITLTelegramOpts {
    // Warning: (ae-forgotten-export) The symbol "TelegramChannelConfig_2" needs to be exported by the entry point index.d.ts
    //
    channel: TelegramChannelConfig_2;
    hitlPort: HITLPort;
    request: HITLRequest;
}
```

### `SendSignalOpts`

```typescript
export interface SendSignalOpts {
    readonly payload?: unknown;
}
```

### `SensitiveValue`

```typescript
export class SensitiveValue<T> {
    constructor(value: T, label?: string);
    get label(): string;
    reveal(): T;
    toJSON(): never;
    toString(): string;
}
```

### `SEPOLIA_EXPLORER_BASE`

```typescript
export const SEPOLIA_EXPLORER_BASE = "https://sepolia.starkscan.co/tx";
```

### `serializeTrajectory`

```typescript
export function serializeTrajectory(exp: TrajectoryExport): string;
```

### `SessionEvent`

```typescript
export type SessionEvent = z.infer<typeof SessionEventSchema>;
```

### `SessionEventSchema`

```typescript
export const SessionEventSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    data: z.ZodObject<{
        runId: z.ZodString;
        agentId: z.ZodString;
        agentVersion: z.ZodOptional<z.ZodString>;
        task: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodString;
        origin: z.ZodOptional<z.ZodEnum<["local", "remote"]>>;
        steerId: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    }, {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"RUN_STARTED">;
}, "strip", z.ZodTypeAny, {
    type: "RUN_STARTED";
    id: string;
    data: {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "RUN_STARTED";
    id: string;
    data: {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        stepIndex: z.ZodNumber;
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    }, {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"STEP_STARTED">;
}, "strip", z.ZodTypeAny, {
    type: "STEP_STARTED";
    id: string;
    data: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "STEP_STARTED";
    id: string;
    data: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        text: string;
    }, {
        text: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"TEXT_MESSAGE_CONTENT">;
}, "strip", z.ZodTypeAny, {
    type: "TEXT_MESSAGE_CONTENT";
    id: string;
    data: {
        text: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "TEXT_MESSAGE_CONTENT";
    id: string;
    data: {
        text: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        content: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        content: string;
    }, {
        content: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"TEXT_MESSAGE_END">;
}, "strip", z.ZodTypeAny, {
    type: "TEXT_MESSAGE_END";
    id: string;
    data: {
        content: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "TEXT_MESSAGE_END";
    id: string;
    data: {
        content: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        callId: z.ZodString;
        toolName: z.ZodString;
        argsPreview: z.ZodString;
        rationale: z.ZodOptional<z.ZodString>;
        vetoWindowMs: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    }, {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_TOOL_INTENT">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_TOOL_INTENT";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_TOOL_INTENT";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        callId: z.ZodString;
        toolName: z.ZodString;
        argsPreview: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        callId: string;
        toolName: string;
        argsPreview: string;
    }, {
        callId: string;
        toolName: string;
        argsPreview: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"TOOL_CALL_START">;
}, "strip", z.ZodTypeAny, {
    type: "TOOL_CALL_START";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "TOOL_CALL_START";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        callId: z.ZodString;
        toolName: z.ZodString;
        ok: z.ZodBoolean;
        resultPreview: z.ZodString;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    }, {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"TOOL_CALL_END">;
}, "strip", z.ZodTypeAny, {
    type: "TOOL_CALL_END";
    id: string;
    data: {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "TOOL_CALL_END";
    id: string;
    data: {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        requestId: z.ZodString;
        action: z.ZodString;
        context: z.ZodString;
        expiresAt: z.ZodOptional<z.ZodString>;
        risk: z.ZodOptional<z.ZodObject<{
            score: z.ZodNumber;
            reversibility: z.ZodNumber;
            blastRadius: z.ZodNumber;
            dataSensitivity: z.ZodNumber;
            externalSideEffect: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        }, {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        }>>;
    }, "strict", z.ZodTypeAny, {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    }, {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_HITL_REQUEST">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_HITL_REQUEST";
    id: string;
    data: {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_HITL_REQUEST";
    id: string;
    data: {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        requestId: z.ZodString;
        approved: z.ZodBoolean;
        by: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        approved: boolean;
        requestId: string;
        by: string;
    }, {
        approved: boolean;
        requestId: string;
        by: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_HITL_RESOLVED">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_HITL_RESOLVED";
    id: string;
    data: {
        approved: boolean;
        requestId: string;
        by: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_HITL_RESOLVED";
    id: string;
    data: {
        approved: boolean;
        requestId: string;
        by: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        text: z.ZodString;
        source: z.ZodString;
        whisper: z.ZodDefault<z.ZodBoolean>;
        steerId: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        source: string;
        text: string;
        whisper: boolean;
        steerId?: string | undefined;
    }, {
        source: string;
        text: string;
        steerId?: string | undefined;
        whisper?: boolean | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_INSTRUCTION_INJECTED">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_INSTRUCTION_INJECTED";
    id: string;
    data: {
        source: string;
        text: string;
        whisper: boolean;
        steerId?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_INSTRUCTION_INJECTED";
    id: string;
    data: {
        source: string;
        text: string;
        steerId?: string | undefined;
        whisper?: boolean | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        envelopeId: z.ZodString;
        claimKind: z.ZodEnum<["inform", "ask", "list_targets"]>;
        fromRunId: z.ZodString;
        fromInstallId: z.ZodOptional<z.ZodString>;
        fromName: z.ZodOptional<z.ZodString>;
        capability: z.ZodOptional<z.ZodString>;
        replyTo: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        envelopeId: string;
        claimKind: "inform" | "ask" | "list_targets";
        fromRunId: string;
        fromInstallId?: string | undefined;
        fromName?: string | undefined;
        capability?: string | undefined;
        replyTo?: string | undefined;
    }, {
        envelopeId: string;
        claimKind: "inform" | "ask" | "list_targets";
        fromRunId: string;
        fromInstallId?: string | undefined;
        fromName?: string | undefined;
        capability?: string | undefined;
        replyTo?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_TEAMMATE_DELIVERY">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_TEAMMATE_DELIVERY";
    id: string;
    data: {
        envelopeId: string;
        claimKind: "inform" | "ask" | "list_targets";
        fromRunId: string;
        fromInstallId?: string | undefined;
        fromName?: string | undefined;
        capability?: string | undefined;
        replyTo?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_TEAMMATE_DELIVERY";
    id: string;
    data: {
        envelopeId: string;
        claimKind: "inform" | "ask" | "list_targets";
        fromRunId: string;
        fromInstallId?: string | undefined;
        fromName?: string | undefined;
        capability?: string | undefined;
        replyTo?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        runId: z.ZodString;
        stopReason: z.ZodString;
        stepCount: z.ZodNumber;
        costUsd: z.ZodNumber;
        finishedAt: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    }, {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"RUN_FINISHED">;
}, "strip", z.ZodTypeAny, {
    type: "RUN_FINISHED";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "RUN_FINISHED";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        runId: z.ZodString;
        stepCount: z.ZodNumber;
        costUsd: z.ZodNumber;
        elapsedMs: z.ZodNumber;
        pendingHitl: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    }, {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"STATE_SNAPSHOT">;
}, "strip", z.ZodTypeAny, {
    type: "STATE_SNAPSHOT";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "STATE_SNAPSHOT";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        steerId: z.ZodString;
        accepted: z.ZodBoolean;
        verdict: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        steerId: string;
        accepted: boolean;
        verdict?: string | undefined;
    }, {
        steerId: string;
        accepted: boolean;
        verdict?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_CONTROL_ACK">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_CONTROL_ACK";
    id: string;
    data: {
        steerId: string;
        accepted: boolean;
        verdict?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_CONTROL_ACK";
    id: string;
    data: {
        steerId: string;
        accepted: boolean;
        verdict?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        installId: z.ZodString;
        name: z.ZodString;
        cert: z.ZodObject<{
            v: z.ZodLiteral<1>;
            fleetId: z.ZodString;
            rootPubkey: z.ZodString;
            signingPubkey: z.ZodString;
            installId: z.ZodString;
            installPubkey: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            issuedAt: z.ZodNumber;
            notAfter: z.ZodNumber;
            sig: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        }, {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        }>;
    }, "strict", z.ZodTypeAny, {
        name: string;
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
    }, {
        name: string;
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_POD_STARTED">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_POD_STARTED";
    id: string;
    data: {
        name: string;
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_POD_STARTED";
    id: string;
    data: {
        name: string;
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        installId: z.ZodString;
        cert: z.ZodObject<{
            v: z.ZodLiteral<1>;
            fleetId: z.ZodString;
            rootPubkey: z.ZodString;
            signingPubkey: z.ZodString;
            installId: z.ZodString;
            installPubkey: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            issuedAt: z.ZodNumber;
            notAfter: z.ZodNumber;
            sig: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        }, {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        }>;
        signingKeyCert: z.ZodOptional<z.ZodObject<{
            v: z.ZodLiteral<1>;
            fleetId: z.ZodString;
            rootPubkey: z.ZodString;
            signingPubkey: z.ZodString;
            issuedAt: z.ZodNumber;
            notAfter: z.ZodNumber;
            sig: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            issuedAt: number;
            notAfter: number;
            sig?: string | undefined;
        }, {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            issuedAt: number;
            notAfter: number;
            sig?: string | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
        signingKeyCert?: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            issuedAt: number;
            notAfter: number;
            sig?: string | undefined;
        } | undefined;
    }, {
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
        signingKeyCert?: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            issuedAt: number;
            notAfter: number;
            sig?: string | undefined;
        } | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_FLEET_CERT_RENEWED">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_FLEET_CERT_RENEWED";
    id: string;
    data: {
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
        signingKeyCert?: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            issuedAt: number;
            notAfter: number;
            sig?: string | undefined;
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_FLEET_CERT_RENEWED";
    id: string;
    data: {
        installId: string;
        cert: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            installId: string;
            installPubkey: string;
            issuedAt: number;
            notAfter: number;
            name?: string | undefined;
            sig?: string | undefined;
        };
        signingKeyCert?: {
            v: 1;
            fleetId: string;
            rootPubkey: string;
            signingPubkey: string;
            issuedAt: number;
            notAfter: number;
            sig?: string | undefined;
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        stage: z.ZodEnum<["requested", "approved", "cert_minted", "committed", "reconciling", "announced"]>;
        detail: z.ZodOptional<z.ZodString>;
        failed: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        stage: "approved" | "requested" | "cert_minted" | "committed" | "reconciling" | "announced";
        failed?: boolean | undefined;
        detail?: string | undefined;
    }, {
        stage: "approved" | "requested" | "cert_minted" | "committed" | "reconciling" | "announced";
        failed?: boolean | undefined;
        detail?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_POD_START_PROGRESS">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_POD_START_PROGRESS";
    id: string;
    data: {
        stage: "approved" | "requested" | "cert_minted" | "committed" | "reconciling" | "announced";
        failed?: boolean | undefined;
        detail?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_POD_START_PROGRESS";
    id: string;
    data: {
        stage: "approved" | "requested" | "cert_minted" | "committed" | "reconciling" | "announced";
        failed?: boolean | undefined;
        detail?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        action: z.ZodEnum<["team-list", "team-send", "delegate", "coordinate", "start"]>;
        target: z.ZodOptional<z.ZodString>;
        outcome: z.ZodEnum<["resolved", "delivered", "no-route", "executed"]>;
        detail: z.ZodOptional<z.ZodString>;
        roster: z.ZodOptional<z.ZodObject<{
            rows: z.ZodArray<z.ZodObject<{
                address: z.ZodString;
                runId: z.ZodString;
                name: z.ZodString;
                peerLabel: z.ZodOptional<z.ZodString>;
                reachable: z.ZodOptional<z.ZodBoolean>;
            }, "strict", z.ZodTypeAny, {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }, {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }>, "many">;
            liveSessions: z.ZodArray<z.ZodObject<{
                runId: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
            }, "strict", z.ZodTypeAny, {
                runId: string;
                name?: string | undefined;
            }, {
                runId: string;
                name?: string | undefined;
            }>, "many">;
        }, "strip", z.ZodTypeAny, {
            rows: {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }[];
            liveSessions: {
                runId: string;
                name?: string | undefined;
            }[];
        }, {
            rows: {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }[];
            liveSessions: {
                runId: string;
                name?: string | undefined;
            }[];
        }>>;
    }, "strict", z.ZodTypeAny, {
        outcome: "executed" | "resolved" | "delivered" | "no-route";
        action: "team-list" | "team-send" | "delegate" | "coordinate" | "start";
        detail?: string | undefined;
        target?: string | undefined;
        roster?: {
            rows: {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }[];
            liveSessions: {
                runId: string;
                name?: string | undefined;
            }[];
        } | undefined;
    }, {
        outcome: "executed" | "resolved" | "delivered" | "no-route";
        action: "team-list" | "team-send" | "delegate" | "coordinate" | "start";
        detail?: string | undefined;
        target?: string | undefined;
        roster?: {
            rows: {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }[];
            liveSessions: {
                runId: string;
                name?: string | undefined;
            }[];
        } | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_TEAM_ACTION_RESULT">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_TEAM_ACTION_RESULT";
    id: string;
    data: {
        outcome: "executed" | "resolved" | "delivered" | "no-route";
        action: "team-list" | "team-send" | "delegate" | "coordinate" | "start";
        detail?: string | undefined;
        target?: string | undefined;
        roster?: {
            rows: {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }[];
            liveSessions: {
                runId: string;
                name?: string | undefined;
            }[];
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_TEAM_ACTION_RESULT";
    id: string;
    data: {
        outcome: "executed" | "resolved" | "delivered" | "no-route";
        action: "team-list" | "team-send" | "delegate" | "coordinate" | "start";
        detail?: string | undefined;
        target?: string | undefined;
        roster?: {
            rows: {
                runId: string;
                name: string;
                address: string;
                peerLabel?: string | undefined;
                reachable?: boolean | undefined;
            }[];
            liveSessions: {
                runId: string;
                name?: string | undefined;
            }[];
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        scope: z.ZodEnum<["session", "always"]>;
        tool: z.ZodString;
        pattern: z.ZodString;
        by: z.ZodString;
        requestedScope: z.ZodOptional<z.ZodEnum<["session", "always"]>>;
        downgradeReason: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        tool: string;
        by: string;
        scope: "session" | "always";
        pattern: string;
        requestedScope?: "session" | "always" | undefined;
        downgradeReason?: string | undefined;
    }, {
        tool: string;
        by: string;
        scope: "session" | "always";
        pattern: string;
        requestedScope?: "session" | "always" | undefined;
        downgradeReason?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_REMOTE_GRANT">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_REMOTE_GRANT";
    id: string;
    data: {
        tool: string;
        by: string;
        scope: "session" | "always";
        pattern: string;
        requestedScope?: "session" | "always" | undefined;
        downgradeReason?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_REMOTE_GRANT";
    id: string;
    data: {
        tool: string;
        by: string;
        scope: "session" | "always";
        pattern: string;
        requestedScope?: "session" | "always" | undefined;
        downgradeReason?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        reason: z.ZodEnum<["grant", "coalesced"]>;
        tool: z.ZodString;
        pattern: z.ZodOptional<z.ZodString>;
        scope: z.ZodOptional<z.ZodEnum<["session", "always"]>>;
        approved: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        reason: "grant" | "coalesced";
        tool: string;
        approved: boolean;
        scope?: "session" | "always" | undefined;
        pattern?: string | undefined;
    }, {
        reason: "grant" | "coalesced";
        tool: string;
        approved: boolean;
        scope?: "session" | "always" | undefined;
        pattern?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"CUSTOM_AUTO_VERDICT">;
}, "strip", z.ZodTypeAny, {
    type: "CUSTOM_AUTO_VERDICT";
    id: string;
    data: {
        reason: "grant" | "coalesced";
        tool: string;
        approved: boolean;
        scope?: "session" | "always" | undefined;
        pattern?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "CUSTOM_AUTO_VERDICT";
    id: string;
    data: {
        reason: "grant" | "coalesced";
        tool: string;
        approved: boolean;
        scope?: "session" | "always" | undefined;
        pattern?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        runId: z.ZodString;
        agentId: z.ZodString;
        agentVersion: z.ZodOptional<z.ZodString>;
        task: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodString;
        origin: z.ZodOptional<z.ZodEnum<["local", "remote"]>>;
        steerId: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    }, {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"run.start">;
}, "strip", z.ZodTypeAny, {
    type: "run.start";
    id: string;
    data: {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "run.start";
    id: string;
    data: {
        agentId: string;
        runId: string;
        startedAt: string;
        agentVersion?: string | undefined;
        task?: string | undefined;
        origin?: "local" | "remote" | undefined;
        steerId?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        stepIndex: z.ZodNumber;
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    }, {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"run.step">;
}, "strip", z.ZodTypeAny, {
    type: "run.step";
    id: string;
    data: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "run.step";
    id: string;
    data: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        stepIndex: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        text: string;
    }, {
        text: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"assistant.delta">;
}, "strip", z.ZodTypeAny, {
    type: "assistant.delta";
    id: string;
    data: {
        text: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "assistant.delta";
    id: string;
    data: {
        text: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        content: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        content: string;
    }, {
        content: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"assistant.message">;
}, "strip", z.ZodTypeAny, {
    type: "assistant.message";
    id: string;
    data: {
        content: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "assistant.message";
    id: string;
    data: {
        content: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        callId: z.ZodString;
        toolName: z.ZodString;
        argsPreview: z.ZodString;
        rationale: z.ZodOptional<z.ZodString>;
        vetoWindowMs: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    }, {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"tool.intent">;
}, "strip", z.ZodTypeAny, {
    type: "tool.intent";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "tool.intent";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
        vetoWindowMs: number;
        rationale?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        callId: z.ZodString;
        toolName: z.ZodString;
        argsPreview: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        callId: string;
        toolName: string;
        argsPreview: string;
    }, {
        callId: string;
        toolName: string;
        argsPreview: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"tool.call.start">;
}, "strip", z.ZodTypeAny, {
    type: "tool.call.start";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "tool.call.start";
    id: string;
    data: {
        callId: string;
        toolName: string;
        argsPreview: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        callId: z.ZodString;
        toolName: z.ZodString;
        ok: z.ZodBoolean;
        resultPreview: z.ZodString;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    }, {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"tool.call.end">;
}, "strip", z.ZodTypeAny, {
    type: "tool.call.end";
    id: string;
    data: {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "tool.call.end";
    id: string;
    data: {
        callId: string;
        toolName: string;
        ok: boolean;
        resultPreview: string;
        durationMs?: number | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        requestId: z.ZodString;
        action: z.ZodString;
        context: z.ZodString;
        expiresAt: z.ZodOptional<z.ZodString>;
        risk: z.ZodOptional<z.ZodObject<{
            score: z.ZodNumber;
            reversibility: z.ZodNumber;
            blastRadius: z.ZodNumber;
            dataSensitivity: z.ZodNumber;
            externalSideEffect: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        }, {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        }>>;
    }, "strict", z.ZodTypeAny, {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    }, {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"hitl.request">;
}, "strip", z.ZodTypeAny, {
    type: "hitl.request";
    id: string;
    data: {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "hitl.request";
    id: string;
    data: {
        requestId: string;
        action: string;
        context: string;
        expiresAt?: string | undefined;
        risk?: {
            reversibility: number;
            blastRadius: number;
            dataSensitivity: number;
            externalSideEffect: number;
            score: number;
        } | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        requestId: z.ZodString;
        approved: z.ZodBoolean;
        by: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        approved: boolean;
        requestId: string;
        by: string;
    }, {
        approved: boolean;
        requestId: string;
        by: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"hitl.resolved">;
}, "strip", z.ZodTypeAny, {
    type: "hitl.resolved";
    id: string;
    data: {
        approved: boolean;
        requestId: string;
        by: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "hitl.resolved";
    id: string;
    data: {
        approved: boolean;
        requestId: string;
        by: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        text: z.ZodString;
        source: z.ZodString;
        whisper: z.ZodDefault<z.ZodBoolean>;
        steerId: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        source: string;
        text: string;
        whisper: boolean;
        steerId?: string | undefined;
    }, {
        source: string;
        text: string;
        steerId?: string | undefined;
        whisper?: boolean | undefined;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"instruction.injected">;
}, "strip", z.ZodTypeAny, {
    type: "instruction.injected";
    id: string;
    data: {
        source: string;
        text: string;
        whisper: boolean;
        steerId?: string | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "instruction.injected";
    id: string;
    data: {
        source: string;
        text: string;
        steerId?: string | undefined;
        whisper?: boolean | undefined;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        runId: z.ZodString;
        stopReason: z.ZodString;
        stepCount: z.ZodNumber;
        costUsd: z.ZodNumber;
        finishedAt: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    }, {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"run.finished">;
}, "strip", z.ZodTypeAny, {
    type: "run.finished";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "run.finished";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stopReason: string;
        stepCount: number;
        finishedAt: string;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>, z.ZodObject<{
    data: z.ZodObject<{
        runId: z.ZodString;
        stepCount: z.ZodNumber;
        costUsd: z.ZodNumber;
        elapsedMs: z.ZodNumber;
        pendingHitl: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    }, {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    }>;
    id: z.ZodString;
    seq: z.ZodNumber;
    ts: z.ZodString;
    sig: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"state">;
}, "strip", z.ZodTypeAny, {
    type: "state";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}, {
    type: "state";
    id: string;
    data: {
        runId: string;
        costUsd: number;
        stepCount: number;
        elapsedMs: number;
        pendingHitl: number;
    };
    seq: number;
    ts: string;
    sig?: string | undefined;
}>]>;
```

### `SessionEventSink`

```typescript
export interface SessionEventSink {
    emit(event: SessionEvent): void;
}
```

### `SessionEventType`

```typescript
export type SessionEventType = SessionEvent["type"];
```

### `SessionGuard`

```typescript
export interface SessionGuard {
    isActive(at: Date): Promise<boolean>;
    readonly name: string;
}
```

### `SessionOrigin`

```typescript
export interface SessionOrigin {
    attach(ref: SessionRef): Promise<AttachedSession>;
    readonly kind: SessionOriginKind;
    start(req: SessionStartRequest): Promise<StartedSession>;
}
```

### `SessionOriginError`

```typescript
export class SessionOriginError extends Error {
    constructor(kind: string, reason: string);
    readonly kind: string;
    readonly reason: string;
}
```

### `SessionOriginKind`

```typescript
export type SessionOriginKind = "local" | "daemon" | "gateway" | "pod";
```

### `SessionRef`

```typescript
export interface SessionRef {
    readonly installId?: string;
    readonly runId: string;
}
```

### `SessionStartGrant`

```typescript
export interface SessionStartGrant {
    readonly by: string;
    readonly tools?: readonly string[];
}
```

### `SessionStartRequest`

```typescript
export interface SessionStartRequest {
    readonly grant: SessionStartGrant;
    readonly kind: SessionOriginKind;
    readonly work: SessionStartWork;
}
```

### `SessionStartWork`

```typescript
export interface SessionStartWork {
    readonly name?: string;
    readonly repo?: string;
    readonly task: string;
}
```

### `SessionState`

```typescript
export interface SessionState {
    agentId: string | null;
    costUsd: number;
    elapsedMs: number;
    pendingHitl: number;
    phase: SessionStatus;
    runId: string | null;
    status: "idle" | "running" | "finished";
    stepCount: number;
}
```

### `SessionStatus`

```typescript
export type SessionStatus = "idle" | "thinking" | "tool-call" | "blocked" | "awaiting-hitl" | "stopped";
```

### `SettlementReceipt`

```typescript
export interface SettlementReceipt {
    amount: string;
    blockNumber: number;
    blockTime: string;
    decimals: number;
    from: string;
    network: string;
    proofCommitment?: string;
    proofUrl?: string;
    to: string;
    token: string;
    txHash: string;
}
```

### `sha256`

```typescript
export function sha256(input: string | Uint8Array): Promise<string>;
```

### `shouldLearn`

```typescript
export function shouldLearn(trigger: LearningTrigger): boolean;
```

### `shouldRetry`

```typescript
export function shouldRetry(config: RetryConfig, err: unknown, attempt: number): boolean;
```

### `SignalBrainPort`

```typescript
export interface SignalBrainPort {
    episodic?: EpisodicMemoryPort;
}
```

### `SignalPoint`

```typescript
export interface SignalPoint {
    evidence: string;
    label: string;
    weight: number;
}
```

### `SIGNED_INDEX_SPEC_VERSION`

```typescript
export const SIGNED_INDEX_SPEC_VERSION: 1;
```

### `SignedReceipt`

```typescript
export interface SignedReceipt {
    algorithm: "sha-256";
    certChain?: string[];
    hashedMessage: string;
    signature: string;
    timestamp: string;
    tsa: string;
}
```

### `SignedSkillIndex`

```typescript
export interface SignedSkillIndex {
    entries: SkillIndexEntry[];
    expires: string;
    keyId: string;
    root: string;
    signature: string;
    specVersion: typeof SIGNED_INDEX_SPEC_VERSION;
    version: number;
}
```

### `signEvent`

```typescript
export function signEvent(event: Omit<DomainEvent, "signature">, secret: string): string;
```

### `SignFn`

```typescript
export type SignFn = (canonicalMessage: string) => string;
```

### `signGateEnvelope`

```typescript
export function signGateEnvelope(env: GateVerdictEnvelope, sign: SignFn): GateVerdictEnvelope;
```

### `SignOffDecision`

```typescript
export type SignOffDecision = "approved" | "rejected";
```

### `SignOffRecord`

```typescript
export interface SignOffRecord {
    approverId: string;
    candidateId: string;
    decision: SignOffDecision;
    rationale: string;
    signedHash: string;
    timestamp: string;
}
```

### `singleShotStrategy`

```typescript
export function singleShotStrategy<TInput, TOutput>(): Strategy<TInput, TOutput>;
```

### `Skill`

```typescript
export interface Skill<I = unknown, O = unknown> {
    execute(input: I, ctx: SkillContext): Promise<O>;
    readonly inputSchema: {
        parse: (raw: unknown) => I;
    };
    readonly name: string;
}
```

### `SkillBuilderDeps`

```typescript
export interface SkillBuilderDeps {
    readonly brain?: BrainPort;
    readonly litellmApiKey?: string;
    readonly litellmUrl?: string;
    readonly logger: LoggerPort;
    readonly slackWebhookUrl?: string;
}
```

### `SkillCandidate`

```typescript
export interface SkillCandidate {
    constitutionalScore: number;
    domain: string;
    extractedFrom: string;
    id: string;
    instructions: string;
    outcomeScore: number;
    replayRoot: string;
    version: string;
}
```

### `SkillCaptureOptions`

```typescript
export interface SkillCaptureOptions {
    readonly domain: string;
    readonly enabled: boolean;
    readonly markdownSink?: (path: string, content: string) => Promise<void>;
    readonly minQuality?: number;
    readonly procedural?: ProceduralMemoryPort;
    readonly synthesize?: (traceSummary: string) => string;
}
```

### `SkillContext`

```typescript
export interface SkillContext {
    readonly db: DbClient;
    readonly dryRunMocks: Record<string, (input: unknown) => unknown>;
    readonly elapsedSeconds?: number;
    readonly executionId?: string;
    readonly isReplay: boolean;
    readonly logger: LoggerPort;
    readonly progress?: ProgressCallback;
    readonly remainingSeconds?: number;
    readonly secrets?: SecretsAccessor;
}
```

### `SkillExecutionError`

```typescript
export class SkillExecutionError extends Error {
    constructor(skillName: string, message: string, opts?: {
        status?: number;
        cause?: unknown;
    });
    readonly cause?: unknown;
    readonly skillName: string;
    readonly status?: number;
}
```

### `SkillIndexEntry`

```typescript
export interface SkillIndexEntry {
    poseidonHash: string;
    skillId: string;
    tarballSha256: string;
    version: string;
}
```

### `SkillLedgerEntry`

```typescript
export interface SkillLedgerEntry {
    agent_id: string;
    brain_entry_id: string;
    created_at: string;
    id: string;
    lifecycle_state: SkillLifecycleState;
    metrics: SkillMetrics;
    outcome_type: string;
    skill_name: string;
    skill_sha256: string;
    source_run_ids: string[];
}
```

### `SkillLifecycleState`

```typescript
export type SkillLifecycleState = "active" | "archived" | "deprecated";
```

### `SkillManifest`

```typescript
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
```

### `SkillManifestSchema`

```typescript
export const SkillManifestSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    license: z.ZodOptional<z.ZodString>;
    compatibility: z.ZodOptional<z.ZodString>;
    "allowed-tools": z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodObject<{
        version: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        category: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        tags: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>>;
        author: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-required": z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-mode": z.ZodOptional<z.ZodOptional<z.ZodEnum<["all", "at-least-one"]>>>;
        vauban: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            tier: z.ZodOptional<z.ZodOptional<z.ZodEnum<["official", "verified", "unverified"]>>>;
            subagent: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            "model-hint": z.ZodOptional<z.ZodOptional<z.ZodString>>;
            proof: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                poseidon_hash: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                tsa_token: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                starknet_tx: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                anchored_at: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            }, "strict", z.ZodTypeAny, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }>>>;
            biscuit: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                required_caps: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
                max_scope: z.ZodOptional<z.ZodOptional<z.ZodEnum<["project", "session", "global"]>>>;
            }, "strict", z.ZodTypeAny, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }>>>;
            audit_status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["approved", "review", "rejected"]>>>;
            observability_metric: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, "strict", z.ZodTypeAny, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }>>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        version: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        category: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        tags: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>>;
        author: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-required": z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-mode": z.ZodOptional<z.ZodOptional<z.ZodEnum<["all", "at-least-one"]>>>;
        vauban: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            tier: z.ZodOptional<z.ZodOptional<z.ZodEnum<["official", "verified", "unverified"]>>>;
            subagent: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            "model-hint": z.ZodOptional<z.ZodOptional<z.ZodString>>;
            proof: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                poseidon_hash: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                tsa_token: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                starknet_tx: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                anchored_at: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            }, "strict", z.ZodTypeAny, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }>>>;
            biscuit: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                required_caps: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
                max_scope: z.ZodOptional<z.ZodOptional<z.ZodEnum<["project", "session", "global"]>>>;
            }, "strict", z.ZodTypeAny, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }>>>;
            audit_status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["approved", "review", "rejected"]>>>;
            observability_metric: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, "strict", z.ZodTypeAny, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }>>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        version: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        category: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        tags: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>>;
        author: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-required": z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-mode": z.ZodOptional<z.ZodOptional<z.ZodEnum<["all", "at-least-one"]>>>;
        vauban: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            tier: z.ZodOptional<z.ZodOptional<z.ZodEnum<["official", "verified", "unverified"]>>>;
            subagent: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            "model-hint": z.ZodOptional<z.ZodOptional<z.ZodString>>;
            proof: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                poseidon_hash: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                tsa_token: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                starknet_tx: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                anchored_at: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            }, "strict", z.ZodTypeAny, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }>>>;
            biscuit: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                required_caps: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
                max_scope: z.ZodOptional<z.ZodOptional<z.ZodEnum<["project", "session", "global"]>>>;
            }, "strict", z.ZodTypeAny, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }>>>;
            audit_status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["approved", "review", "rejected"]>>>;
            observability_metric: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, "strict", z.ZodTypeAny, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }>>>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "strict", z.ZodTypeAny, {
    name: string;
    description: string;
    metadata?: z.objectOutputType<{
        version: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        category: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        tags: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>>;
        author: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-required": z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-mode": z.ZodOptional<z.ZodOptional<z.ZodEnum<["all", "at-least-one"]>>>;
        vauban: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            tier: z.ZodOptional<z.ZodOptional<z.ZodEnum<["official", "verified", "unverified"]>>>;
            subagent: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            "model-hint": z.ZodOptional<z.ZodOptional<z.ZodString>>;
            proof: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                poseidon_hash: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                tsa_token: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                starknet_tx: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                anchored_at: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            }, "strict", z.ZodTypeAny, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }>>>;
            biscuit: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                required_caps: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
                max_scope: z.ZodOptional<z.ZodOptional<z.ZodEnum<["project", "session", "global"]>>>;
            }, "strict", z.ZodTypeAny, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }>>>;
            audit_status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["approved", "review", "rejected"]>>>;
            observability_metric: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, "strict", z.ZodTypeAny, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }>>>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    license?: string | undefined;
    compatibility?: string | undefined;
    "allowed-tools"?: string | undefined;
}, {
    name: string;
    description: string;
    metadata?: z.objectInputType<{
        version: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        category: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        tags: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>>;
        author: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-required": z.ZodOptional<z.ZodOptional<z.ZodString>>;
        "env-mode": z.ZodOptional<z.ZodOptional<z.ZodEnum<["all", "at-least-one"]>>>;
        vauban: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            tier: z.ZodOptional<z.ZodOptional<z.ZodEnum<["official", "verified", "unverified"]>>>;
            subagent: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            "model-hint": z.ZodOptional<z.ZodOptional<z.ZodString>>;
            proof: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                poseidon_hash: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                tsa_token: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                starknet_tx: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                anchored_at: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            }, "strict", z.ZodTypeAny, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }, {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            }>>>;
            biscuit: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                required_caps: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
                max_scope: z.ZodOptional<z.ZodOptional<z.ZodEnum<["project", "session", "global"]>>>;
            }, "strict", z.ZodTypeAny, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }, {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            }>>>;
            audit_status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["approved", "review", "rejected"]>>>;
            observability_metric: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, "strict", z.ZodTypeAny, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }, {
            proof?: {
                poseidon_hash?: string | undefined;
                tsa_token?: string | undefined;
                starknet_tx?: string | undefined;
                anchored_at?: string | undefined;
            } | undefined;
            tier?: "verified" | "unverified" | "official" | undefined;
            subagent?: string | undefined;
            "model-hint"?: string | undefined;
            biscuit?: {
                required_caps?: string[] | undefined;
                max_scope?: "session" | "project" | "global" | undefined;
            } | undefined;
            audit_status?: "rejected" | "approved" | "review" | undefined;
            observability_metric?: string | undefined;
        }>>>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    license?: string | undefined;
    compatibility?: string | undefined;
    "allowed-tools"?: string | undefined;
}>;
```

### `SkillMdParseError`

```typescript
export class SkillMdParseError extends Error {
    constructor(filePath: string, reason: string);
    readonly filePath: string;
}
```

### `SkillMdValidationError`

```typescript
export class SkillMdValidationError extends Error {
    constructor(filePath: string, issues: ReadonlyArray<{
        path: string;
        message: string;
    }>);
    readonly filePath: string;
    readonly issues: ReadonlyArray<{
        path: string;
        message: string;
    }>;
}
```

### `SkillMetrics`

```typescript
export interface SkillMetrics {
    [key: string]: unknown;
    consistency_score?: number;
    creator_model?: string;
    execution_count?: number;
    last_verified?: string;
    mutationSource?: "manual" | "auto";
    pinned?: boolean;
    success_rate?: number;
}
```

### `SkillNotConfiguredError`

```typescript
export class SkillNotConfiguredError extends Error {
    constructor(skillName: string, missingEnv: readonly string[]);
    readonly missingEnv: readonly string[];
    readonly skillName: string;
}
```

### `SkillRegistry`

```typescript
export type SkillRegistry = Record<string, Skill>;
```

### `SkillRegistryBundle`

```typescript
export interface SkillRegistryBundle {
    baseNames: readonly string[];
    extraNames: readonly string[];
    registry: SkillRegistry;
}
```

### `skillSafetyAllow`

```typescript
export function skillSafetyAllow(parsed: ParsedSkillFile, knownTools: ReadonlySet<string>): boolean;
```

### `skillSafetyDeny`

```typescript
export function skillSafetyDeny(parsed: ParsedSkillFile, knownTools: ReadonlySet<string>): string[];
```

### `skillSafetyLens`

```typescript
export function skillSafetyLens(opts: {
    knownTools: ReadonlySet<string>;
    name?: string;
}): BatteryLens<ParsedSkillFile>;
```

### `SkillValueResult`

```typescript
export interface SkillValueResult {
    skillId: string;
    skillValue: number;
    totalOutcomeDelta: number;
    usageCount: number;
    windowEnd: string;
    windowStart: string;
}
```

### `SkillVersion`

```typescript
export interface SkillVersion {
    createdAt: Date;
    mutationType: "initial" | "reflexion" | "ab_winner" | "manual";
    parentSkillId: string | null;
    replayRoot: string;
    skillId: string;
    version: string;
}
```

### `SlackApprovalResult`

```typescript
export interface SlackApprovalResult {
    approvalId: string;
    messageTs: string;
}
```

### `SlackChannel`

```typescript
export class SlackChannel implements MessagingChannelPort {
    constructor(config: SlackChannelConfig);
    sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
    sendMessage(target: string, text: string): Promise<void>;
}
```

### `SlackChannelConfig`

```typescript
export interface SlackChannelConfig {
    webhookUrl: string;
}

// Warning: (ae-forgotten-export) The symbol "SlackNotifyInput" needs to be exported by the entry point index.d.ts
//
```

### `slackNotify`

```typescript
export const slackNotify: Skill<SlackNotifyInput, SlackNotifyOutput>;
```

### `SlackNotifyOutput`

```typescript
export interface SlackNotifyOutput {
    delivered: boolean;
    ts: string | null;
}
```

### `SlackTriggerContext`

```typescript
export interface SlackTriggerContext {
    channelId: string;
    userId: string;
}
```

### `SleepFn`

```typescript
export type SleepFn = (ms: number) => Promise<void>;
```

### `SolvencyClaim`

```typescript
export interface SolvencyClaim {
    readonly assets_ge_liabilities: boolean;
    readonly oracle_quorum?: number;
    readonly portfolio_id: PortfolioId;
    readonly proof_grade: ProofGrade;
    readonly stark_proof?: string;
    readonly timestamp: Date;
}
```

### `SOTA`

```typescript
export const SOTA: Axiom;
```

### `sotaScorer`

```typescript
export const sotaScorer: ScoringFunction;
```

### `SprintInput`

```typescript
export interface SprintInput {
    readonly end_date?: string;
    readonly goal?: string;
    readonly name: string;
    readonly project_slug: string;
    readonly start_date?: string;
}
```

### `SprintRef`

```typescript
export interface SprintRef {
    readonly created_at: Date;
    readonly name: string;
    readonly project_slug: string;
    readonly sprint_id: string;
}
```

### `sqlitePathForSession`

```typescript
export function sqlitePathForSession(sessionId: string, baseDir?: string): string;
```

### `SqlitePersistenceOptions`

```typescript
export interface SqlitePersistenceOptions {
    dbPath: string;
    readOnly?: boolean;
}
```

### `SqlitePersistencePort`

```typescript
export class SqlitePersistencePort implements PersistencePort {
    constructor(opts: SqlitePersistenceOptions);
    clearAll(): Promise<void>;
    close(): Promise<void>;
    getMaxSeq(): Promise<number>;
    get isClosed(): boolean;
    loadEvents(sinceSeq?: number): Promise<SessionEvent[]>;
    loadRevocations(): Promise<string[]>;
    saveEvent(event: SessionEvent): Promise<void>;
    saveRevocation(jti: string): Promise<void>;
}
```

### `SqlReadOnlyViolation`

```typescript
export class SqlReadOnlyViolation extends Error {
    constructor(query: string);
    readonly query: string;
}

// Warning: (ae-forgotten-export) The symbol "StarknetBalanceInput" needs to be exported by the entry point index.d.ts
//
```

### `starknetBalance`

```typescript
export const starknetBalance: Skill<StarknetBalanceInput, StarknetBalanceOutput>;
```

### `StarknetBalanceOutput`

```typescript
export interface StarknetBalanceOutput {
    address: string;
    balance_wei: string;
    token: "STRK" | "ETH" | "VAULT";
}
```

### `StarknetSepoliaPayAdapter`

```typescript
export class StarknetSepoliaPayAdapter implements PayPort {
    constructor(opts?: StarknetSepoliaPayAdapterOptions);
    pay(req: PayRequest): Promise<PayResult>;
    waitForAcceptance(txHash: string, opts?: {
        timeoutMs?: number;
    }): Promise<PayResult>;
}
```

### `StarknetSepoliaPayAdapterOptions`

```typescript
export interface StarknetSepoliaPayAdapterOptions {
    accountFactory?: (provider: RpcProvider, address: string, privateKey: string) => Account;
    pollIntervalMs?: number;
    providerFactory?: (rpcUrl: string) => RpcProvider;
    rpcUrl?: string;
    strkContract?: string;
}
```

### `StartedSession`

```typescript
export interface StartedSession {
    readonly announced: boolean;
    readonly installId?: string;
    readonly kind: SessionOriginKind;
    readonly name?: string;
    readonly runId: string;
    readonly toolsEnforced: boolean;
}
```

### `StartWorkflowOpts`

```typescript
export interface StartWorkflowOpts {
    readonly idempotencyKey?: string;
    readonly input: unknown;
    readonly manifestHash?: string;
    readonly tenantId: string;
    readonly workflowName: string;
    readonly workflowVersion: string;
}
```

### `stdoutTelemetrySink`

```typescript
export function stdoutTelemetrySink(opts?: StdoutTelemetrySinkOptions): TelemetrySink;
```

### `StdoutTelemetrySinkOptions`

```typescript
export interface StdoutTelemetrySinkOptions {
    json?: boolean;
    stream?: NodeJS.WritableStream;
}
```

### `StepCountExceededError`

```typescript
export class StepCountExceededError extends Error {
    constructor(currentCount: number, max: number);
    readonly code = "OODA_STEP_COUNT_EXCEEDED";
}
```

### `StepEvent`

```typescript
export interface StepEvent {
    readonly costUsd?: number;
    readonly cycleEventId?: string;
    readonly cycleIndex: number;
    readonly durationMs: number;
    readonly model?: string;
    readonly phase: OODAPhaseKind;
    readonly runId: string;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
}

// Warning: (ae-missing-release-tag) "StepJournal" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `StepJournal`

```typescript
export interface StepJournal<TOutput = unknown> {
    recall(runId: string, nodeId: string): Promise<NodeManifestEntry<TOutput> | undefined>;
    record(runId: string, entry: NodeManifestEntry<TOutput>): Promise<void>;
}
```

### `StepKind`

```typescript
export type StepKind = "tool_call" | "sleep" | "wait_signal" | "await_block" | "await_event" | "submit_tx" | "human" | "ctx_now" | "ctx_random" | "ctx_uuid" | "child_workflow";
```

### `StepOpts`

```typescript
export interface StepOpts {
    readonly backoffMs?: number;
    readonly idempotencyKey?: string;
    readonly maxAttempts?: number;
    readonly timeoutMs?: number;
}
```

### `StepResult`

```typescript
export interface StepResult {
    durationMs: number;
    error?: string;
    output?: unknown;
    status: "completed" | "failed" | "skipped";
    stepIndex: number;
}
```

### `StepStatus`

```typescript
export type StepStatus = "pending" | "running" | "done" | "failed";
```

### `storeReflexion`

```typescript
export function storeReflexion(entry: ReflexionEntry, agentId: string, archiver: (input: {
    content: string;
    category?: string;
    tags?: string[];
    confidence?: number;
    metadata?: Record<string, unknown>;
}) => Promise<unknown>): Promise<void>;
```

### `Strategy`

```typescript
export interface Strategy<TInput, TOutput> {
    readonly name: string;
    run(input: TInput, generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>, ctx?: ComputeContext): Promise<StrategyResult<TOutput>>;
}
```

### `StrategyAgentContext`

```typescript
export interface StrategyAgentContext {
    readonly agentId: string;
    readonly allowedTools?: readonly string[];
    readonly hooks?: AgentHooks;
    readonly llm?: LLMProviderPort;
    readonly llmFn?: StrategyLLMCompletionFn;
    readonly logger: LoggerPort;
    readonly maxSteps: number;
    readonly runId: string;
    readonly signal?: AbortSignal;
    readonly systemPrompt: string;
    readonly task: string;
    readonly tools: ToolRegistry;
}
```

### `StrategyLLMCompletionFn`

```typescript
export type StrategyLLMCompletionFn = (messages: readonly StrategyMessage[]) => Promise<StrategyLLMResponse>;
```

### `StrategyLLMResponse`

```typescript
export interface StrategyLLMResponse {
    readonly content: string;
    readonly model: string;
    readonly provider: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly toolCalls?: readonly StrategyToolCall[];
}
```

### `StrategyMessage`

```typescript
export interface StrategyMessage {
    readonly content: string;
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly toolCallId?: string;
    readonly toolName?: string;
}
```

### `StrategyResult`

```typescript
export interface StrategyResult<T> {
    metadata: {
        strategy: string;
        candidates: number;
        verifier_scores: number[];
        cost: {
            calls: number;
        };
        latency_ms: number;
    };
    result: T;
}
```

### `StrategyRunClaim`

```typescript
export interface StrategyRunClaim {
    readonly integrity_proven: boolean;
    readonly proof_commitment: string;
    readonly sprint_id: string;
    readonly strategy_id: string;
    readonly timestamp: Date;
}
```

### `StrategyRunInput`

```typescript
export interface StrategyRunInput {
    readonly code_commit: string;
    readonly dataset_hash: string;
    readonly sprint_id: string;
    readonly strategy_id: string;
}
```

### `StrategyStepEvent`

```typescript
export interface StrategyStepEvent extends StepEvent {
    readonly strategy: AgentStrategyName;
}
```

### `StrategyToolCall`

```typescript
export interface StrategyToolCall {
    readonly arguments: Record<string, unknown>;
    readonly id: string;
    readonly name: string;
}
```

### `StreamDelta`

```typescript
export interface StreamDelta {
    delta: string;
    usage?: ChatUsage;
}
```

### `StressLedger`

```typescript
export class StressLedger {
    clear(): void;
    export(): ImmuneMemoryEntry[];
    record(embedding: number[], label: string): ImmuneMemoryEntry;
    search(embedding: number[], threshold?: number): ImmuneMatch[];
    get size(): number;
}
```

### `STRICT_PII_DETECTOR`

```typescript
export const STRICT_PII_DETECTOR: PIIDetector;
```

### `STRK_SEPOLIA_CONTRACT`

```typescript
export const STRK_SEPOLIA_CONTRACT = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
```

### `StructuredOutputError`

```typescript
export class StructuredOutputError extends Error {
    constructor(message: string, zodError: ZodError);
    readonly zodError: ZodError;
}
```

### `structuredOutputGuard`

```typescript
export function structuredOutputGuard<T>(schema: ZodSchema<T>, opts?: {
    name?: string;
    criticality?: "hard" | "soft";
}): BatteryLens<string>;
```

### `StructuredOutputOptions`

```typescript
export interface StructuredOutputOptions<T> {
    fn: (input: {
        messages: Array<{
            role: string;
            content: string;
        }>;
    }, ctx: OODAContext) => Promise<string>;
    maxRetries?: number;
    schema: ZodSchema<T>;
}
```

### `StructuredOutputResult`

```typescript
export interface StructuredOutputResult<T> {
    parsed: T;
    rawMessages: Array<{
        role: string;
        content: string;
    }>;
    retries: number;
}
```

### `StructuredOutputVerdict`

```typescript
export interface StructuredOutputVerdict<T> {
    readonly rationale: string;
    readonly repaired: boolean;
    readonly score: 1 | 0.5 | 0;
    readonly value: T | null;
}
```

### `SubscribeHandle`

```typescript
export interface SubscribeHandle {
    close: () => void;
}
```

### `subscribeToRun`

```typescript
export function subscribeToRun(runId: string, opts: SubscribeToRunOptions): Promise<SubscribeHandle>;
```

### `SubscribeToRunOptions`

```typescript
export interface SubscribeToRunOptions {
    baseUrl: string;
    getToken?: () => Promise<string>;
    lastEventId?: string;
    onComplete?: (data: {
        status: string;
        duration_ms?: number;
    }) => void;
    onError?: (err: Error) => void;
    onStep?: (step: RunStep, event: "step_existing" | "step_new") => void;
    signal?: AbortSignal;
}
```

### `Subscription`

```typescript
export interface Subscription {
    unsubscribe(): Promise<void>;
}
```

### `SubTokenClaims`

```typescript
export interface SubTokenClaims {
    cnf?: {
        jkt: string;
    };
    exp: number;
    jti: string;
    scope: SubTokenScope;
    v: 1;
}
```

### `SubTokenScope`

```typescript
export type SubTokenScope = "read-only" | "approve-only" | "full";
```

### `SUPPORTED_JURISDICTIONS_V0`

```typescript
export const SUPPORTED_JURISDICTIONS_V0: Jurisdiction[];
```

### `SwapParams`

```typescript
export interface SwapParams {
    readonly amount: string;
    readonly deadline: number;
    readonly max_slippage_bps: number;
    readonly token_in: TokenAddress;
    readonly token_out: TokenAddress;
}
```

### `SwapResult`

```typescript
export interface SwapResult {
    readonly actual_slippage_bps: number;
    readonly amount_out: string;
    readonly executed_at: Date;
    readonly tx_hash: string;
}
```

### `T0StableMemoryBlock`

```typescript
export interface T0StableMemoryBlock {
    readonly assembledAt: string;
    readonly entryCount: number;
    readonly text: string;
}
```

### `T0StableMemoryBlockOptions`

```typescript
export interface T0StableMemoryBlockOptions {
    categories?: string[];
    limitPerCategory?: number;
    maxChars?: number;
    maxEntryChars?: number;
    tags?: string[];
}
```

### `TaskFeatures`

```typescript
export interface TaskFeatures {
    contextLength: number;
    hasCrossReference: boolean;
    hasMultipleSteps: boolean;
    hasNumerics: boolean;
    inputLength: number;
    requiresCreativity: boolean;
    requiresReasoning: boolean;
}
```

### `TaskRef`

```typescript
export interface TaskRef {
    readonly project: string;
    readonly ref: string;
    readonly sprint: string;
    readonly task_id: string;
}
```

### `TaskStatus`

```typescript
export type TaskStatus = "todo" | "in_progress" | "done" | "blocked" | "rejected";
```

### `TEAM_ACTION_VERBS`

```typescript
export const TEAM_ACTION_VERBS: ReadonlySet<ControlVerb>;
```

### `TeamActionBodyError`

```typescript
export class TeamActionBodyError extends Error {
    constructor(verb: string, reason: string);
    readonly reason: string;
    readonly verb: string;
}
```

### `TeamActionRequest`

```typescript
export type TeamActionRequest = TeamListRequest | TeamSendRequest | TeamDelegateRequest | TeamCoordinateRequest | TeamStartRequest;
```

### `TeamActionVerb`

```typescript
export type TeamActionVerb = "team-list" | "team-send" | "delegate" | "coordinate" | "start";
```

### `TeamCoordinateRequest`

```typescript
export interface TeamCoordinateRequest {
    readonly branches: readonly {
        readonly task: string;
    }[];
}
```

### `TeamDelegateRequest`

```typescript
export interface TeamDelegateRequest {
    readonly grant?: {
        readonly tools?: readonly string[];
    };
    readonly task: string;
}
```

### `TeamListRequest`

```typescript
export interface TeamListRequest {
    readonly filter?: string;
}
```

### `TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2`

```typescript
export const TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2 = "2.1.0";
```

### `TeammateBodyTooLargeError`

```typescript
export class TeammateBodyTooLargeError extends Error {
    constructor(actualBytes: number, maxBytes: number);
    readonly actualBytes: number;
    readonly maxBytes: number;
}
```

### `TeammateEnvelope`

```typescript
export type TeammateEnvelope = TeammateEnvelopeV1 | TeammateEnvelopeV2;
```

### `TeammateEnvelopeInputError`

```typescript
export class TeammateEnvelopeInputError extends Error {
    constructor(reason: string);
}
```

### `TeammateEnvelopePorts`

```typescript
export interface TeammateEnvelopePorts {
    readonly clock: ClockPort;
    readonly sign: SignFn;
}
```

### `TeammateEnvelopeV1`

```typescript
export interface TeammateEnvelopeV1 {
    readonly body: string;
    readonly claim: TeammateMessageClaim;
    readonly fromRunId: string;
    readonly id: string;
    readonly replyTo?: string;
    readonly sentAt: number;
    readonly sig?: string;
    readonly toRunId: string;
    readonly v: 1;
}
```

### `TeammateEnvelopeV2`

```typescript
export interface TeammateEnvelopeV2 {
    readonly body: string;
    readonly claim: TeammateMessageClaim;
    readonly correlationId: string;
    readonly fromInstallId?: string;
    readonly fromRunId: string;
    readonly id: string;
    readonly replyTo?: string;
    readonly schemaVersion: string;
    readonly sentAt: number;
    readonly sig?: string;
    readonly steerId?: string;
    readonly toInstallId?: string;
    readonly toRunId: string;
    readonly toSessionId?: string;
    readonly v: 2;
}
```

### `TeammateEnvelopeVerification`

```typescript
export interface TeammateEnvelopeVerification {
    readonly reason?: string;
    readonly valid: boolean;
}
```

### `TeammateEventPushOutcome`

```typescript
export interface TeammateEventPushOutcome {
    readonly accepted: boolean;
    readonly errorName?: string;
}
```

### `TeammateEventSinkPort`

```typescript
export interface TeammateEventSinkPort {
    receivePushedEvent(event: unknown): Promise<TeammateEventPushOutcome>;
}
```

### `TeammateInfoPeer`

```typescript
export interface TeammateInfoPeer {
    readonly label?: string;
    readonly pairedAt: string;
    readonly peerId: string;
}
```

### `TeammateInfoPort`

```typescript
export interface TeammateInfoPort {
    snapshot(): Promise<TeammateInfoSnapshot>;
}
```

### `TeammateInfoSession`

```typescript
export interface TeammateInfoSession {
    readonly runIds: readonly string[];
    readonly sessionId: string;
    readonly task?: string;
}
```

### `TeammateInfoSnapshot`

```typescript
export interface TeammateInfoSnapshot {
    readonly peers: readonly TeammateInfoPeer[];
    readonly pendingAsksCount: number;
    readonly sessions: readonly TeammateInfoSession[];
}
```

### `TeammateMessageClaim`

```typescript
export interface TeammateMessageClaim {
    readonly capability?: string;
    readonly kind: "inform" | "ask" | "list_targets" | "control";
}
```

### `TeammateSendOutcome`

```typescript
export interface TeammateSendOutcome {
    readonly accepted: boolean;
    readonly errorName?: string;
    readonly targets?: readonly TeammateTargetInfo[];
}
```

### `TeammateSendPort`

```typescript
export interface TeammateSendPort {
    deliverCrossInstall(envelope: unknown): Promise<TeammateSendOutcome>;
}
```

### `TeammateTargetInfo`

```typescript
export interface TeammateTargetInfo {
    readonly name: string;
    readonly runId: string;
}
```

### `TeamSendRequest`

```typescript
export interface TeamSendRequest {
    readonly body: string;
    readonly kind: "ask" | "inform";
    readonly toTarget: string;
}
```

### `TeamStartRequest`

```typescript
export interface TeamStartRequest {
    readonly grant?: {
        readonly tools?: readonly string[];
    };
    readonly name?: string;
    readonly origin: SessionOriginKind;
    readonly repo?: string;
    readonly task: string;
}
```

### `teeSink`

```typescript
export function teeSink(...sinks: SessionEventSink[]): SessionEventSink;
```

### `TelegramApprovalResult`

```typescript
export interface TelegramApprovalResult {
    approvalId: string;
    messageId: number;
}
```

### `TelegramChannel`

```typescript
export class TelegramChannel implements MessagingChannelPort {
    constructor(config: TelegramChannelConfig);
    sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
    sendMessage(target: string, text: string): Promise<void>;
}
```

### `TelegramChannelConfig`

```typescript
export interface TelegramChannelConfig {
    botToken: string;
    defaultChatId?: string;
}

// Warning: (ae-forgotten-export) The symbol "TelegramNotifyInput" needs to be exported by the entry point index.d.ts
//
```

### `telegramNotify`

```typescript
export const telegramNotify: Skill<TelegramNotifyInput, TelegramNotifyOutput>;
```

### `TelegramNotifyOutput`

```typescript
export interface TelegramNotifyOutput {
    delivered: boolean;
    message_id: number | null;
}
```

### `TelegramRateLimitError`

```typescript
export class TelegramRateLimitError extends Error {
    constructor(retryAfterSeconds?: number | undefined);
    readonly retryAfterSeconds?: number | undefined;
}
```

### `TelegramTriggerContext`

```typescript
export interface TelegramTriggerContext {
    chatId: string;
    from?: {
        username?: string;
    };
}
```

### `TelemetryBusOptions`

```typescript
export interface TelemetryBusOptions {
    logger?: TelemetryLogger;
    maxQueueDepth?: number;
    nonBlocking?: boolean;
    sinks: readonly TelemetrySink[];
}
```

### `TelemetryCounters`

```typescript
export interface TelemetryCounters {
    readonly dispatched: number;
    readonly dropped: number;
    readonly sinkErrors: number;
}
```

### `TelemetryLogger`

```typescript
export interface TelemetryLogger {
    error(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
}
```

### `TelemetryRunFinish`

```typescript
export interface TelemetryRunFinish {
    errorMessage?: string;
    finishedAt: string;
    outcome?: {
        type: string;
        valueCents: number;
        quality?: number;
        confidence?: number;
        metadata?: Record<string, unknown>;
    };
    status: TelemetryRunStatus;
    stopReason?: string;
    totalCostUsd?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalToolCalls?: number;
}
```

### `TelemetryRunStart`

```typescript
export interface TelemetryRunStart {
    agentId: string;
    agentVersion: string;
    model: string;
    provider: string;
    runId: string;
    startedAt: string;
    tenantId?: string;
    traceId?: string;
}
```

### `TelemetryRunStatus`

```typescript
export type TelemetryRunStatus = "success" | "failed" | "skipped" | "timeout" | "incoherent";
```

### `TelemetryRunStep`

```typescript
export interface TelemetryRunStep {
    costUsd: number;
    durationMs?: number;
    inputTokens: number;
    kind: string;
    metadata?: Record<string, unknown>;
    outputTokens: number;
    status: "completed" | "failed" | "skipped";
    stepIndex: number;
    toolCalls?: number;
}
```

### `TelemetrySink`

```typescript
export interface TelemetrySink {
    finish(runId: string, event: TelemetryRunFinish): Promise<void>;
    flush?(): Promise<void>;
    readonly name: string;
    start(event: TelemetryRunStart): Promise<string | void>;
    step(runId: string, delta: TelemetryRunStep): Promise<void>;
}
```

### `TelemetrySinkError`

```typescript
export class TelemetrySinkError extends Error {
    constructor(message: string, sinkName: string, cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly sinkName: string;
}
```

### `TenantContext`

```typescript
export interface TenantContext {
    readonly glacisMode: "verified" | "degraded_verified" | "unverified";
    readonly jurisdictions: Jurisdiction[];
    readonly tenantId: string;
    readonly verifiedHuman: boolean;
}
```

### `TenantContextPort`

```typescript
export interface TenantContextPort {
    enterDegradedMode(tenantId: string, reason: string): Promise<void>;
    getCumulativeDegradedTime(tenantId: string, windowDays?: number): Promise<number>;
    // Warning: (ae-forgotten-export) The symbol "TenantContext_2" needs to be exported by the entry point index.d.ts
    getCurrent(tenantId: string): Promise<TenantContext_2 | null>;
    getDegradedMetrics(tenantId: string): Promise<DegradedMetrics>;
    getKek(tenantId: string): Promise<string>;
    restoreVerified(tenantId: string, glacisAttestation: {
        txRef: string;
        nullifierRoot: string;
        blockNumber: number;
    }): Promise<void>;
}
```

### `TenantNotFoundError`

```typescript
export class TenantNotFoundError extends Error {
    constructor(tenantId: string);
    readonly tenantId: string;
}
```

### `Tier`

```typescript
export type Tier = "XS" | "S" | "M" | "L" | "XL";
```

### `TierPolicy`

```typescript
export interface TierPolicy {
    tiersFor(category: string, mode: "degraded" | "full"): ModelTier[];
}
```

### `TimestampPort`

```typescript
export interface TimestampPort {
    request(rootHash: string): Promise<SignedReceipt>;
    verify(receipt: SignedReceipt, rootHash: string): Promise<{
        valid: boolean;
        reason?: string;
    }>;
}
```

### `toApprovalRisk`

```typescript
export function toApprovalRisk(v: RiskVector): ApprovalRisk;
```

### `toCanonicalEventType`

```typescript
export function toCanonicalEventType(type: string): string;
```

### `toDiscoveryEntry`

```typescript
export function toDiscoveryEntry(parsed: ParsedSkillFile): {
    name: string;
    description: string;
    tier: VaubanSkillTier;
};
```

### `tokenJaccard`

```typescript
export function tokenJaccard(a: string, b: string): number;
```

### `ToolCall`

```typescript
export interface ToolCall {
    args: Record<string, unknown>;
    tool: string;
}
```

### `ToolError`

```typescript
export interface ToolError {
    code: ToolErrorCode;
    message: string;
    toolName: string;
}
```

### `ToolErrorCode`

```typescript
export type ToolErrorCode = "not_found" | "validation_failed" | "execution_failed" | "duplicate_name";
```

### `ToolRegistry`

```typescript
export interface ToolRegistry {
    clear(): void;
    execute(name: string, args: unknown): Promise<ToolResult>;
    get(name: string): AgentTool | undefined;
    has(name: string): boolean;
    listMCPDefinitions(): MCPToolDefinition[];
    listNames(): string[];
    register<T extends z.ZodTypeAny>(tool: AgentTool<T>): ToolResult<void>;
    readonly size: number;
    unregister(name: string): boolean;
}

// Warning: (ae-internal-missing-underscore) The name "ToolRegistryImpl" should be prefixed with an underscore because the declaration is marked as @internal
//
```

### `ToolResult`

```typescript
export type ToolResult<T = unknown> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: ToolError;
};
```

### `toolSpan`

```typescript
export function toolSpan(tracer: Tracer, toolName: string, args: unknown): Span;
```

### `toRegistrationJson`

```typescript
export function toRegistrationJson(doc: Erc8004Registration): string;
```

### `toSdkEscalationLevel`

```typescript
export function toSdkEscalationLevel(level: EscalationLevel): SdkEscalationLevel;
```

### `ToTConfig`

```typescript
export interface ToTConfig {
    branchFactor: number;
    evaluateState?: (state: unknown) => number;
    maxCalls: number;
    maxDepth: number;
    pruneThreshold: number;
    searchPolicy: ToTSearchPolicy;
}
```

### `ToTSearchPolicy`

```typescript
export type ToTSearchPolicy = "bfs" | "dfs";
```

### `Trace`

```typescript
export interface Trace {
    agentId: string;
    agentSignature?: string;
    agentVersion: string;
    completedAt: number;
    config: Record<string, unknown>;
    configHash: string;
    receipt?: SignedReceipt;
    receiptRetryAt?: number;
    receiptStatus?: ReceiptStatus;
    rootHash: string;
    runId: string;
    schemaVersion: typeof TRACE_SCHEMA_VERSION;
    startedAt: number;
    status: "completed" | "failed" | "skipped";
    steps: TraceStep[];
    totalSteps: number;
}
```

### `TRACE_SCHEMA_VERSION`

```typescript
export const TRACE_SCHEMA_VERSION: "1.0.0";
```

### `tracedMcpClient`

```typescript
export function tracedMcpClient(client: MCPClientLike): MCPClientLike;
```

### `tracedPort`

```typescript
export function tracedPort<T extends object>(impl: T, options: TracedPortOptions): T;
```

### `TracedPortOptions`

```typescript
export interface TracedPortOptions {
    attributeHook?: (ctx: {
        span: Span;
        method: string;
        args: readonly unknown[];
        result?: unknown;
    }) => void;
    portName: string;
    tracerName?: string;
}
```

### `TraceReplayError`

```typescript
export class TraceReplayError extends Error {
    constructor(msg: string);
}
```

### `TraceStep`

```typescript
export interface TraceStep {
    costUsd?: number;
    durationMs: number;
    guardName?: string;
    index: number;
    inputHash: string;
    inputOriginalHmac?: string;
    model?: {
        provider: string;
        name: string;
        version: string;
    };
    outputHash: string;
    outputOriginalHmac?: string;
    phase: "observe" | "orient" | "decide" | "act" | "feedback" | "guard" | "hitl";
    policy: "include" | "redact" | "hmac" | "hash-only";
    prevStepHash: string;
    runId: string;
    stepHash: string;
    storedInput?: unknown;
    storedOutput?: unknown;
    timestamp: number;
    tokens?: {
        input: number;
        output: number;
        cacheRead?: number;
    };
    toolName?: string;
    type: "llm_call" | "tool_call" | "guard_check" | "phase_transition" | "hitl_gate";
}
```

### `TraceStepSink`

```typescript
export interface TraceStepSink {
    feed(step: BatteryTraceStep): Promise<TraceStep>;
}

// Warning: (ae-missing-release-tag) "traceToMermaid" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `traceToMermaid`

```typescript
export function traceToMermaid(steps: readonly TraceStep[]): string;
```

### `Trade`

```typescript
export interface Trade {
    agent_run_id: string | null;
    alpaca_order_id: string;
    entry_at: string;
    entry_price_cents: number;
    exit_at: string | null;
    exit_price_cents: number | null;
    exit_reason: "stop" | "target" | "timeout" | "manual" | null;
    id: string;
    outcome_id: string;
    pnl_cents: number | null;
    quantity: number;
    side: "BUY" | "SELL";
    slippage_bps: number | null;
    symbol: string;
    trading_mode: "paper" | "live";
}
```

### `TradeClaim`

```typescript
export interface TradeClaim {
    readonly anchor_id?: string;
    readonly executed: boolean;
    readonly hmac_signature: string;
    readonly timestamp: Date;
    readonly trade_id: string;
}
```

### `TradeRecord`

```typescript
export interface TradeRecord {
    readonly id: string;
    readonly price: string;
    readonly qty: string;
    readonly side: "buy" | "sell";
    readonly ts: Date;
}
```

### `TradingNQConfig`

```typescript
export interface TradingNQConfig {
    thresholds: {
        conviction_min: number;
        kelly_cap: number;
        kelly_bootstrap_fraction: number;
        bootstrap_trade_threshold: number;
        hitl_timeout_ms: number;
        stop_loss_atr_multiple: number;
        target_atr_multiple: number;
        trade_timeout_minutes: number;
    };
}
```

### `TrajectoryConfidenceConfig`

```typescript
export interface TrajectoryConfidenceConfig {
    alpha?: number;
    initial?: number;
    tau?: number;
}
```

### `TrajectoryConfidenceState`

```typescript
export interface TrajectoryConfidenceState {
    observations: number;
    peak: number;
    trough: number;
    value: number;
}
```

### `TrajectoryConfidenceTracker`

```typescript
export class TrajectoryConfidenceTracker {
    constructor(config?: TrajectoryConfidenceConfig);
    isInterruptRecommended(): boolean;
    observe(stepConfidence: number): TrajectoryConfidenceState;
    reset(): void;
    snapshot(): TrajectoryConfidenceState;
}
```

### `TrajectoryExport`

```typescript
export interface TrajectoryExport {
    format: TrajectoryFormat;
    steps: TrajectoryStep[];
    totalCost: number;
    totalTokens: number;
}
```

### `TrajectoryFormat`

```typescript
export type TrajectoryFormat = "jsonl" | "openai-dpo";
```

### `TrajectoryOptions`

```typescript
export interface TrajectoryOptions {
    format: TrajectoryFormat;
    maxSteps?: number;
    minTokens?: number;
}
```

### `TrajectoryStep`

```typescript
export interface TrajectoryStep {
    costUsd?: number;
    durationMs?: number;
    input?: unknown;
    inputTokens?: number;
    label: "positive" | "negative" | "neutral";
    model?: string;
    output?: unknown;
    outputTokens?: number;
    phase: string;
    provider?: string;
    runId: string;
    stepIndex: number;
    timestamp?: string;
    type: string;
}
```

### `TransferParams`

```typescript
export interface TransferParams {
    readonly amount: string;
    readonly recipient: string;
    readonly token: TokenAddress;
}
```

### `TransferResult`

```typescript
export interface TransferResult {
    readonly amount: string;
    readonly recipient: string;
    readonly tx_hash: string;
}
```

### `TransportMeta`

```typescript
export interface TransportMeta {
    readonly jws_signature: string;
    // Warning: (ae-forgotten-export) The symbol "Protocol" needs to be exported by the entry point index.d.ts
    //
    readonly protocol: Protocol;
    readonly version: string;
}
```

### `treeOfThoughtsStrategy`

```typescript
export function treeOfThoughtsStrategy<TInput, TOutput>(config?: Partial<ToTConfig>): Strategy<TInput, TOutput>;
```

### `triggerFromSlack`

```typescript
export function triggerFromSlack(agents: AgentsClient, pipelines: PipelinesClient, ctx: SlackTriggerContext, command: string, args: string[]): Promise<MessagingTriggerResult>;
```

### `triggerFromTelegram`

```typescript
export function triggerFromTelegram(agents: AgentsClient, pipelines: PipelinesClient, ctx: TelegramTriggerContext, command: string, args: string[]): Promise<MessagingTriggerResult>;
```

### `tripCircuitBreaker`

```typescript
export function tripCircuitBreaker(redisUrl: string, name: string, redisClientFactory?: (url: string) => MinimalRedisClient): Promise<void>;
```

### `tryParseJsonToolCallFallback`

```typescript
export function tryParseJsonToolCallFallback(content: string): {
    name: string;
    arguments: Record<string, unknown>;
} | null;
```

### `tryPersistEvent`

```typescript
export function tryPersistEvent(persistence: PersistencePort | undefined, event: SessionEvent): Promise<void>;
```

### `Turn`

```typescript
export interface Turn {
    readonly content: string;
    readonly meta?: {
        readonly timestamp?: number;
        readonly tokensIn?: number;
        readonly tokensOut?: number;
        readonly model?: string;
        readonly provider?: string;
        readonly displayContent?: string;
    };
    readonly role: "user" | "assistant";
}
```

### `TwoPhaseOrientConfig`

```typescript
export interface TwoPhaseOrientConfig<C, O, R> {
    act: (orientation: O, context: C) => Promise<R>;
    maxActRetries?: number;
    orient: (context: C) => Promise<O>;
}
```

### `TwoPhaseOrientError`

```typescript
export class TwoPhaseOrientError extends Error {
    constructor(phase: "orient" | "act", cause: unknown, retriesUsed: number, message: string);
    readonly cause: unknown;
    readonly phase: "orient" | "act";
    readonly retriesUsed: number;
}
```

### `TwoPhaseOrientResult`

```typescript
export interface TwoPhaseOrientResult<O, R> {
    orientation: O;
    result: R;
    retriesUsed: number;
}
```

### `UndeterministicSideEffectError`

```typescript
export class UndeterministicSideEffectError extends Error {
    constructor(url: string, method: string);
}
```

### `UnknownSourceError`

```typescript
export class UnknownSourceError extends Error {
    constructor(source: string);
    readonly source: string;
}
```

### `UnreachedBrain`

```typescript
export interface UnreachedBrain {
    readonly brain: string;
    readonly reason: string;
}

// Warning: (ae-missing-release-tag) "UnsignedGateVerdictEnvelope" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `UnsignedGateVerdictEnvelope`

```typescript
export type UnsignedGateVerdictEnvelope = Omit<GateVerdictEnvelope, "sig" | "keyid">;
```

### `UntrustedIndexCode`

```typescript
export type UntrustedIndexCode = "unsupported-spec-version" | "wrong-key" | "root-mismatch" | "bad-signature" | "expired" | "no-entry" | "sha-mismatch";
```

### `UntrustedIndexError`

```typescript
export class UntrustedIndexError extends Error {
    constructor(code: UntrustedIndexCode, message?: string);
    readonly code: UntrustedIndexCode;
}
```

### `updateCoherenceModel`

```typescript
export function updateCoherenceModel(model: CoherenceModel, episode: CoherenceEpisode): CoherenceModel;
```

### `UsageEvent`

```typescript
export interface UsageEvent {
    context: Record<string, unknown>;
    skillId: string;
    timestamp: string;
}
```

### `ValidatedDpop`

```typescript
export interface ValidatedDpop {
    claims: DpopClaims;
    jkt: string;
    valid: true;
}
```

### `ValidateDpopOptions`

```typescript
export interface ValidateDpopOptions {
    accessToken?: string;
    expectedHtm: string;
    expectedHtu: string;
    expectedJkt: string;
    isReplayed?: (jti: string) => boolean;
    maxAgeSec?: number;
    now?: () => number;
    recordJti?: (jti: string, expiresAtMs: number) => void;
}
```

### `validateDpopProof`

```typescript
export function validateDpopProof(dpopJwt: string, opts: ValidateDpopOptions): Promise<DpopValidationResult>;
```

### `validateErc8004Registration`

```typescript
export function validateErc8004Registration(doc: unknown): string[];
```

### `validateEvent`

```typescript
export function validateEvent(type: string, payload: unknown): {
    valid: boolean;
    error?: string;
};
```

### `validateGoldenFixtures`

```typescript
export function validateGoldenFixtures(ledger: StressLedger): {
    passed: boolean;
    results: Array<{
        label: string;
        matched: boolean;
        similarity: number;
    }>;
};
```

### `validateOutcome`

```typescript
export function validateOutcome(outcome: {
    valueCents: number;
}, currentBalance: MeterBalance, opts?: OutcomeGateOptions): OutcomeGateResult;
```

### `validatePersona`

```typescript
export function validatePersona(input: unknown): AgentPersona;

// Warning: (ae-missing-release-tag) "validateTestCommand" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `validateTestCommand`

```typescript
export function validateTestCommand(cmd: string, cwd: string): ParsedTestCommand;
```

### `validateTransition`

```typescript
export function validateTransition(from: HITLState, to: HITLState): void;
```

### `VaubanAuditStatus`

```typescript
export const VaubanAuditStatus: z.ZodEnum<["approved", "review", "rejected"]>;
```

### `VaubanAuditStatus`

```typescript
export type VaubanAuditStatus = z.infer<typeof VaubanAuditStatus>;
```

### `VaubanBiscuitScope`

```typescript
export const VaubanBiscuitScope: z.ZodEnum<["project", "session", "global"]>;
```

### `VaubanBiscuitScope`

```typescript
export type VaubanBiscuitScope = z.infer<typeof VaubanBiscuitScope>;
```

### `VaubanSDKOptions`

```typescript
export interface VaubanSDKOptions {
    agentId: string;
    agentName?: string;
    agentVersion: string;
    apiKey: string;
    capabilities?: string[];
    collectorUrl?: string;
    debug?: boolean;
    orgId: string;
    registryUrl?: string;
    repoUrl?: string;
}
```

### `VaubanSkillTier`

```typescript
export const VaubanSkillTier: z.ZodEnum<["official", "verified", "unverified"]>;
```

### `VaubanSkillTier`

```typescript
export type VaubanSkillTier = z.infer<typeof VaubanSkillTier>;
```

### `VCRCassette`

```typescript
export interface VCRCassette {
    body: string;
    headers: Record<string, string>;
    method: string;
    requestBody: string | null;
    status: number;
    statusText: string;
    timestamp: number;
    url: string;
}
```

### `VCRMode`

```typescript
export type VCRMode = "record" | "replay";
```

### `VCRStats`

```typescript
export interface VCRStats {
    hits: number;
    misses: number;
    recorded: number;
}
```

### `verificationCoverage`

```typescript
export function verificationCoverage(evidenceCount: number, gapCount: number): number;
```

### `VerificationEvidence`

```typescript
export interface VerificationEvidence {
    readonly evidence_hash: string;
    readonly evidence_text: string;
    readonly passed: boolean;
}
```

### `Verifier`

```typescript
export interface Verifier<TOutput = unknown> {
    evaluate(output: TOutput): Promise<VerifierResult> | VerifierResult;
    readonly name: string;
}
```

### `VERIFIER_BATTERY_GUARD`

```typescript
export const VERIFIER_BATTERY_GUARD = "verifier-battery";
```

### `VerifierCtx`

```typescript
export interface VerifierCtx {
    readonly clock: ClockPort;
    readonly random?: RandomPort;
    readonly recorded?: boolean;
}
```

### `VerifierExample`

```typescript
export interface VerifierExample {
    domain: string;
    expectedOutput: string;
    input: string;
}
```

### `VerifierResult`

```typescript
export interface VerifierResult {
    rationale: string;
    score: number;
}

// Warning: (ae-missing-release-tag) "VerifierVerdict" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `VerifierVerdict`

```typescript
export interface VerifierVerdict<TOutput = unknown> {
    readonly accepted: TOutput | null;
    readonly acceptedIndex: number;
    readonly acceptedScore?: number;
    readonly reason: string;
}
```

### `verifyChain`

```typescript
export function verifyChain(trace: Trace, chain: ProofChain): Promise<VerifyChainResult>;
```

### `VerifyChainResult`

```typescript
export type VerifyChainResult = {
    valid: true;
    receiptStatus?: "present" | "pending" | "failed";
} | {
    valid: false;
    tamperedAt: number;
    reason: string;
    receiptStatus?: "present" | "pending" | "failed";
};
```

### `VerifyContext`

```typescript
export type VerifyContext = "runtime" | "skill_ingestion";
```

### `verifyControlClaim`

```typescript
export function verifyControlClaim(envelope: TeammateEnvelope, grant: ControlScope | undefined, opts: VerifyControlClaimOptions): Promise<ControlClaimVerdict>;
```

### `VerifyControlClaimOptions`

```typescript
export interface VerifyControlClaimOptions {
    readonly clock: ClockPort;
}

// Warning: (ae-missing-release-tag) "verifyDecisionReexecution" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `verifyDecisionReexecution`

```typescript
export function verifyDecisionReexecution<I, O>(claim: DecisionClaim_2<I, O>, policy: DeterministicPolicy<I, O>, expectedPolicyVersion: string): ReexecVerdict<O>;
```

### `verifyEntryAgainstRoot`

```typescript
export function verifyEntryAgainstRoot(entry: SkillIndexEntry, proof: string[], root: string): boolean;
```

### `verifyEvent`

```typescript
export function verifyEvent(event: DomainEvent, secret: string, opts?: VerifyEventOptions): Promise<true>;
```

### `VerifyEventOptions`

```typescript
export interface VerifyEventOptions {
    maxClockSkewMs?: number;
    nonceStore?: NonceStore;
    requireNonceStore?: boolean;
}
```

### `VerifyFn`

```typescript
export type VerifyFn = (canonicalMessage: string, sigHex: string) => boolean;
```

### `verifyGateEnvelope`

```typescript
export function verifyGateEnvelope(env: GateVerdictEnvelope, verify: VerifyFn): Promise<EnvelopeVerification>;
```

### `verifyMemoryProvenance`

```typescript
export function verifyMemoryProvenance(entry: MemoryContent, att: MemoryAttestation, verify: VerifyFn, opts?: {
    trustedPubkeys?: Iterable<string>;
}): MemoryProvenanceResult;
```

### `verifyMessageClaim`

```typescript
export function verifyMessageClaim(envelope: TeammateEnvelope, senderAttenuatedTools: readonly string[], opts: VerifyMessageClaimOptions): Promise<MessageClaimVerdict>;
```

### `VerifyMessageClaimOptions`

```typescript
export interface VerifyMessageClaimOptions {
    readonly clock: ClockPort;
}
```

### `verifyProofClaim`

```typescript
export function verifyProofClaim(claim: ProofClaim, verifyClaim: VerifyFn, traceBytes?: string): ProofClaimVerification;
```

### `verifySignedIndex`

```typescript
export function verifySignedIndex(index: SignedSkillIndex, verify: VerifyFn, opts?: {
    now?: Date;
    expectedKeyId?: string;
}): IndexVerifyResult;
```

### `verifySubToken`

```typescript
export function verifySubToken(parentToken: string, token: string, now?: number): VerifySubTokenResult;
```

### `verifySubTokenInstrumented`

```typescript
export function verifySubTokenInstrumented(parentToken: string, token: string, now?: number): VerifySubTokenResult;
```

### `VerifySubTokenResult`

```typescript
export interface VerifySubTokenResult {
    cnf?: {
        jkt: string;
    };
    jti?: string;
    reason?: string;
    scope?: SubTokenScope;
    valid: boolean;
}
```

### `verifyTeammateEnvelopeSignature`

```typescript
export function verifyTeammateEnvelopeSignature(env: TeammateEnvelope, verify: VerifyFn): TeammateEnvelopeVerification;
```

### `VetoChannel`

```typescript
export interface VetoChannel {
    await(callId: string, windowMs: number): Promise<VetoSignal | null>;
    pendingCount(): number;
    submit(signal: VetoSignal): void;
}
```

### `VetoSignal`

```typescript
export interface VetoSignal {
    at: string;
    by: string;
    callId: string;
    reason?: string;
}
```

### `VFActionContext`

```typescript
export interface VFActionContext {
    readonly legalBasis?: string;
    readonly runId: string;
    readonly tenantId: string;
}
```

### `VFAnchoringForbiddenError`

```typescript
export class VFAnchoringForbiddenError extends Error {
    constructor(message: string, reason: "per_trade_anchor_forbidden" | "batch_anchor_missing", cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly reason: "per_trade_anchor_forbidden" | "batch_anchor_missing";
}
```

### `VFinanceActionPort`

```typescript
export interface VFinanceActionPort {
    getMarketSignal(symbol: Symbol_2, ctx: VFActionContext): Promise<MarketSignal>;
    getSolvencyProof(portfolioId: PortfolioId, proofGrade: ProofGrade, ctx: VFActionContext): Promise<SolvencyClaim>;
    recordTrade(trade: TradeRecord, ctx: VFActionContext): Promise<TradeClaim>;
    submitStrategyRun(strategy: StrategyRunInput, ctx: VFActionContext): Promise<StrategyRunClaim>;
}
```

### `VFOracleQuorumError`

```typescript
export class VFOracleQuorumError extends Error {
    constructor(required_quorum: number, available_oracles: number, cause?: unknown | undefined);
    readonly available_oracles: number;
    readonly cause?: unknown | undefined;
    readonly required_quorum: number;
}
```

### `VFProofGenerationError`

```typescript
export class VFProofGenerationError extends Error {
    constructor(portfolio_id: PortfolioId, proof_type: "stark_range" | "commitment", cause?: unknown | undefined);
    readonly cause?: unknown | undefined;
    readonly portfolio_id: PortfolioId;
    readonly proof_type: "stark_range" | "commitment";
}
```

### `VFProofGradeMismatchError`

```typescript
export class VFProofGradeMismatchError extends Error {
    constructor(message: string, expected_grade: ProofGrade, actual_grade: ProofGrade, cause?: unknown | undefined);
    readonly actual_grade: ProofGrade;
    readonly cause?: unknown | undefined;
    readonly expected_grade: ProofGrade;
}
```

### `waitForHITLApproval`

```typescript
export function waitForHITLApproval(db: DbClient, args: HITLGateArgs, options?: HITLGateOptions): Promise<HITLGateVerdict>;

// Warning: (ae-forgotten-export) The symbol "WebSearchInput" needs to be exported by the entry point index.d.ts
//
```

### `webSearch`

```typescript
export const webSearch: Skill<WebSearchInput, WebSearchOutput>;
```

### `WebSearchOutput`

```typescript
export interface WebSearchOutput {
    provider: "brave" | "tavily" | "replay";
    results: WebSearchResult[];
}
```

### `WebSearchResult`

```typescript
export interface WebSearchResult {
    snippet: string;
    title: string;
    url: string;
}
```

### `withBrainContext`

```typescript
export function withBrainContext<TObs, TOrient>(options: BrainContextOptions<TObs>, orientFn: (input: OrientInputWithBrain<TObs>, ctx: OODAContext) => Promise<TOrient>): (input: TObs, ctx: OODAContext) => Promise<TOrient>;
```

### `withCompute`

```typescript
export function withCompute<TInput, TOutput>(input: TInput, options: WithComputeOptions<TInput, TOutput>): Promise<WithComputeResult<TOutput>>;
```

### `WithComputeOptions`

```typescript
export interface WithComputeOptions<TInput, TOutput> {
    // Warning: (ae-forgotten-export) The symbol "ComputeBudget" needs to be exported by the entry point index.d.ts
    budget?: ComputeBudget;
    deadline?: number;
    generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>;
    signal?: AbortSignal;
    strategy: Strategy<TInput, TOutput>;
}
```

### `WithComputeResult`

```typescript
export type WithComputeResult<TOutput> = StrategyResult<TOutput>;

// Warning: (ae-missing-release-tag) "withDelegationAttribute" is part of the package's API, but it is missing a release tag (@alpha, @beta, @public, or @internal)
//
```

### `withDelegationAttribute`

```typescript
export function withDelegationAttribute(span: Span, parentRunId: string): void;
```

### `WithdrawParams`

```typescript
export interface WithdrawParams {
    readonly shares: string;
    readonly vault_address: VaultAddress;
}
```

### `WithdrawResult`

```typescript
export interface WithdrawResult {
    readonly amount_withdrawn: string;
    readonly tx_hash: string;
}

// Warning: (ae-forgotten-export) The symbol "CacheEntry" needs to be exported by the entry point index.d.ts
//
```

### `withIdempotency`

```typescript
export function withIdempotency<T>(call: () => Promise<T>, key: string, opts?: WithIdempotencyOptions, store?: Map<string, CacheEntry<unknown>>): Promise<T>;
```

### `WithIdempotencyOptions`

```typescript
export interface WithIdempotencyOptions {
    ttlMs?: number;
}
```

### `withPaymentReceipt`

```typescript
export function withPaymentReceipt(claim: ProofClaim, receipt: SettlementReceipt, signClaim?: SignFn): ProofClaim;
```

### `withStructuredOutput`

```typescript
export function withStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<StructuredOutputResult<T>>;
```

### `WorkflowContext`

```typescript
export interface WorkflowContext {
    readonly abortSignal: AbortSignal;
    awaitEvent<T = unknown>(filter: EventFilter): Promise<T>;
    awaitStarknetBlock(blockHeight: number): Promise<void>;
    cancel(reason: string): Promise<void>;
    childWorkflow<TInput, TOutput>(name: string, input: TInput, opts?: ChildWorkflowOpts): Promise<TOutput>;
    now(): Promise<Date>;
    random(): Promise<number>;
    readonly runId: string;
    sleepFor(durationMs: number): Promise<void>;
    sleepUntil(t: Date): Promise<void>;
    step<T>(name: string, fn: () => Promise<T>, opts?: StepOpts): Promise<T>;
    readonly tenantId: string;
    uuid(): Promise<string>;
    waitForSignal<T = unknown>(name: string, timeoutMs?: number): Promise<T>;
    readonly workflowName: string;
    readonly workflowVersion: string;
}
```

### `WorkflowHandler`

```typescript
export type WorkflowHandler<TInput = unknown, TOutput = unknown> = (ctx: WorkflowContext, input: TInput) => Promise<TOutput>;
```

### `WorkflowLeaseConflictError`

```typescript
export class WorkflowLeaseConflictError extends Error {
    constructor(runId: string, currentOwner: string);
    readonly currentOwner: string;
    readonly runId: string;
}
```

### `WorkflowNonDeterminismError`

```typescript
export class WorkflowNonDeterminismError extends Error {
    constructor(runId: string, stepIndex: number, expected: string, actual: string);
    readonly actual: string;
    readonly expected: string;
    readonly runId: string;
    readonly stepIndex: number;
}
```

### `WorkflowNotFoundError`

```typescript
export class WorkflowNotFoundError extends Error {
    constructor(runId: string);
    readonly runId: string;
}
```

### `WorkflowProgressEvent`

```typescript
export type WorkflowProgressEvent<TOutput = unknown> = {
    readonly type: "workflow_started";
    readonly runId: string;
    readonly nodeCount: number;
    readonly at: number;
} | {
    readonly type: "node_ready";
    readonly runId: string;
    readonly nodeId: string;
    readonly at: number;
} | {
    readonly type: "node_running";
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly samples: number;
    readonly at: number;
} | {
    readonly type: "node_verified";
    readonly runId: string;
    readonly nodeId: string;
    readonly accepted: boolean;
    readonly at: number;
} | {
    readonly type: "node_resumed";
    readonly runId: string;
    readonly nodeId: string;
    readonly at: number;
} | {
    readonly type: "node_done";
    readonly runId: string;
    readonly nodeId: string;
    readonly output?: TOutput | null;
    readonly at: number;
} | {
    readonly type: "node_failed";
    readonly runId: string;
    readonly nodeId: string;
    readonly reason: string;
    readonly at: number;
} | {
    readonly type: "node_deferred";
    readonly runId: string;
    readonly nodeId: string;
    readonly reason: string;
    readonly at: number;
} | {
    readonly type: "node_replanned";
    readonly runId: string;
    readonly nodeId: string;
    readonly childCount: number;
    readonly at: number;
} | {
    readonly type: "workflow_settled";
    readonly runId: string;
    readonly status: "DONE" | "FAILED" | "CANCELLED";
    readonly total: number;
    readonly done: number;
    readonly deferred: number;
    readonly failed: number;
    readonly at: number;
};
```

### `WorkflowProgressSink`

```typescript
export interface WorkflowProgressSink<TOutput = unknown> {
    emit(event: WorkflowProgressEvent<TOutput>): void;
}
```

### `WorkflowRun`

```typescript
export interface WorkflowRun<TOutput = unknown> {
    readonly error?: string;
    readonly finished_at?: Date;
    readonly input: unknown;
    readonly lease_expires_at?: Date;
    readonly lease_owner?: string;
    readonly manifest_hash?: string;
    readonly output?: TOutput;
    readonly run_id: string;
    readonly started_at: Date;
    readonly status: WorkflowStatus;
    readonly tenant_id: string;
    readonly wake_at?: Date;
    readonly workflow_name: string;
    readonly workflow_version: string;
}
```

### `WorkflowRuntimePort`

```typescript
export interface WorkflowRuntimePort {
    cancel(runId: string, reason: string): Promise<void>;
    executeNext(opts: ResumeWorkflowOpts): Promise<WorkflowRun | null>;
    getJournal(runId: string): Promise<JournalEntry[]>;
    getStatus(runId: string): Promise<WorkflowRun | null>;
    migrateRun(runId: string, fromVersion: string, toVersion: string, migrator: JournalMigrator): Promise<MigrationResult>;
    register<TInput, TOutput>(name: string, version: string, handler: WorkflowHandler<TInput, TOutput>): void;
    sendSignal(runId: string, signalName: string, opts?: SendSignalOpts): Promise<void>;
    start(opts: StartWorkflowOpts): Promise<string>;
    startWorker(opts?: {
        workerId?: string;
        pollIntervalMs?: number;
        maxConcurrent?: number;
    }): Promise<void>;
    stopWorker(): Promise<void>;
    waitForCompletion<TOutput>(runId: string, opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    }): Promise<WorkflowRun<TOutput>>;
}
```

### `WorkflowSignalTimeoutError`

```typescript
export class WorkflowSignalTimeoutError extends Error {
    constructor(runId: string, signalName: string, timeoutMs: number);
    readonly runId: string;
    readonly signalName: string;
    readonly timeoutMs: number;
}
```

### `WorkflowStatus`

```typescript
export type WorkflowStatus = "PENDING" | "RUNNING" | "SLEEPING" | "WAITING_SIGNAL" | "AWAITING_BLOCK" | "AWAITING_EVENT" | "DONE" | "FAILED" | "CANCELLED";
```

### `WorkflowVersionMismatchError`

```typescript
export class WorkflowVersionMismatchError extends Error {
    constructor(runId: string, expected: string, actual: string);
    readonly actual: string;
    readonly expected: string;
    readonly runId: string;
}
```

### `WorkingMemoryEntry`

```typescript
export interface WorkingMemoryEntry {
    agentTag?: string;
    content: unknown;
    id: string;
    importance: number;
    lastAccessedAt: number;
    pinned?: boolean;
    size?: number;
}
```

### `WorkingMemoryPort`

```typescript
export interface WorkingMemoryPort {
    delete(runId: string, key: string): Promise<void>;
    get(runId: string, key: string): Promise<unknown>;
    list(runId: string): Promise<WorkingMemorySlot[]>;
    set(runId: string, key: string, value: unknown, opts?: WorkingMemorySetOptions): Promise<void>;
}
```

### `WorkingMemorySetOptions`

```typescript
export interface WorkingMemorySetOptions {
    importanceScore?: number;
    pinned?: boolean;
    ttlMs?: number;
}
```

### `WorkingMemorySlot`

```typescript
export interface WorkingMemorySlot {
    content: unknown;
    createdAt: string;
    importanceScore: number;
    pinned: boolean;
    slotId: string;
}
```

### `WorldStateHashTracker`

```typescript
export class WorldStateHashTracker {
    observe(toolName: string, args: unknown, outputSummary: string, stepIndex: number): {
        isCollision: boolean;
        hash: string;
        previousStep?: number;
    };
    recent(n?: number): ReadonlyArray<{
        step: number;
        tool: string;
        hash: string;
    }>;
    get size(): number;
}
```

### `WriteTargetResolution`

```typescript
export type WriteTargetResolution = {
    readonly ok: true;
    readonly target: BrainTarget;
} | {
    readonly ok: false;
    readonly error: string;
};
```

### `XPublisher`

```typescript
export class XPublisher implements PublisherPort {
    constructor(cfg: XPublisherConfig, opts?: XPublisherOptions);
    readonly channel: "x";
    isConfigured(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
}
```

### `XPublisherConfig`

```typescript
export interface XPublisherConfig {
    readonly accessToken: string;
    readonly accessTokenSecret: string;
    readonly apiKey: string;
    readonly apiKeySecret: string;
    readonly bearerToken: string;
}
```

### `XPublisherOptions`

```typescript
export interface XPublisherOptions {
    readonly random?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}

// Warning: (ae-forgotten-export) The symbol "XTweetMetricsInput" needs to be exported by the entry point index.d.ts
//
```

### `xTweetMetrics`

```typescript
export const xTweetMetrics: Skill<XTweetMetricsInput, XTweetMetricsOutput>;
```

### `XTweetMetricsOutput`

```typescript
export interface XTweetMetricsOutput {
    bookmarks: number;
    impressions: number;
    likes: number;
    quotes: number;
    replies: number;
    retweets: number;
    tweet_id: string;
}
```

### `zodToJsonSchema`

```typescript
export function zodToJsonSchema(schema: z.ZodTypeAny): MCPToolDefinition["inputSchema"];

// Warnings were encountered during analysis:
//
// src/events/catalogue.ts:65:30 - (ae-forgotten-export) The symbol "AgentStartedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:66:32 - (ae-forgotten-export) The symbol "AgentCompletedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:67:29 - (ae-forgotten-export) The symbol "AgentFailedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:70:7 - (ae-forgotten-export) The symbol "AgentHitlRequestedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:74:7 - (ae-forgotten-export) The symbol "AgentHitlResolvedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:76:34 - (ae-forgotten-export) The symbol "IncidentSloBurnV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:77:34 - (ae-forgotten-export) The symbol "IncidentDetectedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:80:7 - (ae-forgotten-export) The symbol "ForgeInboxReplyClassifiedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:84:7 - (ae-forgotten-export) The symbol "ForgeLeadQualifiedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:88:7 - (ae-forgotten-export) The symbol "ForgeOutreachSentV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:92:7 - (ae-forgotten-export) The symbol "ForgePolicyTriggeredV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:96:7 - (ae-forgotten-export) The symbol "VaubanVaultRebalanceProposedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:100:7 - (ae-forgotten-export) The symbol "VaubanVaultRebalancedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:104:7 - (ae-forgotten-export) The symbol "GlacisIdentityVerifiedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:108:7 - (ae-forgotten-export) The symbol "CitadelSprintClosedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:112:7 - (ae-forgotten-export) The symbol "CitadelSprintAnalyzedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:116:7 - (ae-forgotten-export) The symbol "BrainSkillExtractedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:118:33 - (ae-forgotten-export) The symbol "CcCostRecordedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:121:7 - (ae-forgotten-export) The symbol "CcCostAnomalyDetectedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:123:35 - (ae-forgotten-export) The symbol "TenantProvisionedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:126:7 - (ae-forgotten-export) The symbol "TenantBudgetExceededV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:130:7 - (ae-forgotten-export) The symbol "VaubanVaultAnalyzedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:134:7 - (ae-forgotten-export) The symbol "VaubanGoalCheckedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:138:7 - (ae-forgotten-export) The symbol "VaubanRebalancingCheckedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:142:7 - (ae-forgotten-export) The symbol "VaubanTaxCheckedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:146:7 - (ae-forgotten-export) The symbol "VaubanVaultCompoundedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:150:7 - (ae-forgotten-export) The symbol "VaubanFinanceForecastGeneratedV1" needs to be exported by the entry point index.d.ts
// src/events/catalogue.ts:154:7 - (ae-forgotten-export) The symbol "VaubanFinanceTradeExecutedV1" needs to be exported by the entry point index.d.ts
// src/provable-planner/action-gate.ts:29:3 - (ae-forgotten-export) The symbol "GateDecisionCore_2" needs to be exported by the entry point index.d.ts
```

---

## Breaking-Change Policy

- **Patch (x.y.Z)**: bug fixes, documentation, no API surface change.
- **Minor (x.Y.z)**: new optional exports or optional parameters added.
- **Major (X.y.z)**: removed exports, renamed exports, non-backward-compatible signature changes.

CI gate: `api-extractor run` (check mode) diffs the committed `etc/*.api.md` baseline on every PR.
Any drift without a committed baseline update FAILS the PR. Update via `pnpm api:extract` and commit.
