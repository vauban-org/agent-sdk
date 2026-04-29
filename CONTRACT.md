# @vauban-org/agent-sdk — Public API v0.2.0

Semver: **0.2.0** | Status: **public-experimental** | Breaking changes require major bump.

Classification: **public-experimental** until 1.0.0. Minor bumps add optional
exports; major bumps are required for removals or semantic shifts. See the
"Breaking-change policy" section at the bottom.

---

## Exports

### 1. AgentLoop

Multi-provider loop (Anthropic → Groq cascade). Owns budget tracking, context compaction, coherence detection, and HITL gating.

```typescript
class AgentLoop {
  constructor(config: AgentLoopConfig);
  run(userMessage: string): Promise<AgentLoopRunResult>;
}

interface AgentLoopConfig {
  agentId: string;
  agentVersion: string;
  systemPrompt: string;
  provider: ProviderRouter;
  tools: ToolRegistry;
  budget: AgentBudgetState;
  approvalChannel?: ApprovalChannel;
  tracker?: { recordStep(d: StepDelta): Promise<void> };
  tracer?: Tracer;               // injected for tests
  approvalPollIntervalMs?: number; // default 500
  approvalTimeoutMs?: number;      // default 60_000
}

interface AgentLoopRunResult {
  finalMessage: string;
  stopReason: "complete" | "budget_exhausted" | "incoherent" | "user_cancelled" | "error";
  budgetFinal: AgentBudgetState;
  traceId: string;
}
```

---

### 2. SdkAgentLoop

Anthropic-direct loop with typed tool-use, permission enforcement, and HITL gating. Single provider; no Groq fallback.

```typescript
class SdkAgentLoop {
  constructor(config: SdkAgentLoopConfig);
  get permissions(): SdkPermissions;
  run(userMessage: string): Promise<SdkAgentLoopRunResult>;
}

interface SdkAgentLoopConfig {
  agentId: string;
  agentVersion: string;
  systemPrompt: string;
  client: Anthropic;              // injected Anthropic SDK client
  model?: string;                 // default "claude-opus-4-7"
  maxTokens?: number;             // default 16_000
  permissions: SdkPermissions;
  tools: SdkToolRegistry;
  approvalChannel?: ApprovalChannel;
  maxSteps?: number;              // default 25
  tracer?: Tracer;
}

interface SdkAgentLoopRunResult {
  finalMessage: string;
  stopReason: "complete" | "budget_exhausted" | "tool_denied" | "user_cancelled" | "max_tokens" | "error";
  usage: { inputTokens: number; outputTokens: number };
  traceId: string;
}
```

---

### 3. AgentRegistry + AgentDescriptor (new in 0.1.0)

Plugin registration for agent descriptors. Phase 2 will add workspace auto-discovery.

```typescript
interface AgentDescriptor {
  id: string;                    // kebab-case slug, e.g. "market-radar"
  version: string;               // semver, e.g. "0.2.0"
  loop: "minimal" | "sdk";
  schedule?: string;             // cron expression
  featureFlag?: string;          // env var name gate
  budget_monthly_usd: number;
  description: string;
  handler: AgentHandler;         // (ctx: AgentContext, input: string) => Promise<AgentResult>
}

class AgentRegistry {
  register(desc: AgentDescriptor): void;
  get(id: string): AgentDescriptor | undefined;
  list(): AgentDescriptor[];
  unregister(id: string): boolean;
  discover(workspaceRoot: string): Promise<AgentDescriptor[]>; // stub in 0.1.0
  get size(): number;
}

const agentRegistry: AgentRegistry; // process-level singleton
```

---

### 4. BudgetState + CoherenceDetector

Per-run budget accounting and loop/stall detection.

```typescript
function createBudgetState(overrides?: Partial<AgentBudgetState>): AgentBudgetState;
function createCoherenceDetector(config?: {
  loopDetectionWindow?: number;  // default 3
  stallThreshold?: number;       // default 5
}): CoherenceDetector;

interface AgentBudgetState {
  stepCount: number;
  maxSteps: number;
  tokensBudget: { input: number; output: number; usedInput: number; usedOutput: number };
  contextWindow: { maxTokens: number; currentTokens: number };
  compactionTrigger: number;
  coherenceScore: number;        // 0..1
}

interface CoherenceDetector {
  check(
    recentToolCalls: Array<{ name: string; args: unknown }>,
    stepsWithoutTool: number,
  ): { isLoop: boolean; isStall: boolean; score: number };
}
```

---

### 5. ProviderRouter

Anthropic → Groq cascade with rate-limit fallback and queue-retry hook.

```typescript
function createProviderRouter(opts?: ProviderRouterOptions): ProviderRouter;

interface ProviderRouter {
  complete(request: ProviderRouterRequest): Promise<ProviderRouterResponse>;
}

interface ProviderRouterRequest {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  maxTokens?: number;
}

interface ProviderRouterResponse {
  content: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  latencyMs: number;
}

class ProviderRouterError extends Error {
  cause?: unknown;
}
```

---

### 6. ApprovalChannel + InMemoryApprovalStore

Transport-agnostic HITL contract + in-process store.

```typescript
interface ApprovalChannel {
  send(req: ApprovalRequest): Promise<string>;   // returns opaque request id
  poll(id: string): Promise<Approval | null>;
  cancel(id: string): Promise<void>;
}

interface ApprovalRequest {
  agentId: string;
  action: string;
  context: string;
  timeoutMs: number;
}

interface Approval {
  approved: boolean;
  rationale?: string;
  by: string;
  at: string;   // ISO 8601
}

class InMemoryApprovalStore implements ApprovalStore {
  create(entry: PendingApproval): Promise<void>;
  get(id: string): Promise<PendingApproval | null>;
  resolve(id: string, verdict: Approval): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  expireOverdue(now?: number): Promise<number>;
  listAll(): Promise<readonly PendingApproval[]>;
}
```

---

### 7. Utility helpers

```typescript
// Safety
function sanitizeExternalInput<T extends { content: string }>(
  items: T[],
  opts?: SanitizeConfig,
): SanitizedItem<T>[];

function keepSafeOnly<T extends { content: string }>(items: T[], opts?: SanitizeConfig): T[];

// OTel
function recordOutcome(span: Span, outcome: {
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  stepCount?: number;
}): void;

function getTracer(name?: string): Tracer;

// Tracking
function createAgentRunTracker(db: DbClient): AgentRunTracker;

interface DbClient {
  query<T extends object>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// Durable
function createBullMQRunner(config: BullMQRunnerConfig): BullMQRunner;

// Registry helpers
const AGENT_IDS: Readonly<Record<AgentType, string>>;
function getAgentId(agent: AgentType): string;

// Permissions
function mapScopesToSdkPermissions(scopes: readonly string[]): SdkPermissions;
function permitsCapability(permissions: SdkPermissions, capability: SdkCapability): boolean;
```

---

### 8. Ports (new in 0.2.0) — host-injected dependencies

Contracts that distinguish agent code from host wiring. Agent plugins
depend only on these interfaces; the Command Center host provides
concrete implementations at boot via each agent's `setXxxDeps()` setter.

Classification: **public-experimental** — shape may evolve before 1.0.0.
Consumers must depend on the exported interfaces, not on structural
equivalence with concrete host types.

```typescript
// LoggerPort — Pino-compatible subset. LogObject | string, optional msg.
interface LoggerPort {
  debug(objOrMsg: object | string, msg?: string): void;
  info(objOrMsg: object | string, msg?: string): void;
  warn(objOrMsg: object | string, msg?: string): void;
  error(objOrMsg: object | string, msg?: string): void;
  child?(bindings: Record<string, unknown>): LoggerPort;
}
const noopLogger: LoggerPort;  // for tests

// BrainPort — archival + optional retrieval
interface BrainPort {
  archiveKnowledge(entry: BrainEntryInput): Promise<BrainEntry | null>;
  queryKnowledge?(query: string, filters?: BrainQueryFilters): Promise<BrainEntry[]>;
}

interface BrainEntryInput {
  content: string;
  content_type?: string;
  author?: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  metadata?: Record<string, unknown>;
  brain_id?: string;
}

interface BrainEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

// OutcomePort — fire-and-forget post-run hook
interface OutcomePort {
  recordOutcomeAsync(run: AgentRunRef): void;
}

interface AgentRunRef {
  id: string;
  agent_id: string;
  run_id?: string;
  outcome_id?: string | null;
}

// DbPort — alias for DbClient (same minimal pg interface). Kept for naming symmetry.
type DbPort = DbClient;
```

Exit plan: ports are interfaces, so any host (CC, Brain, a third-party
agent runtime) may implement them. Migrating off these contracts means
swapping the concrete wiring, not refactoring consumers — consumers
remain stable.

---

## Breaking-change policy

- **Patch** (0.1.x): bug fixes, no interface changes.
- **Minor** (0.x.0): new exports, optional fields added. Existing callers unaffected.
- **Major** (x.0.0): removed or renamed exports, required field changes, semantic shifts.

All breaking changes must update this file before merge.
