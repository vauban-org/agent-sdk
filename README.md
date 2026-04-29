# @vauban-org/agent-sdk

Vauban agent primitives extracted from Command Center. Provides the core loop, budget tracking, provider routing, HITL approval, permissions, durable execution, and telemetry building blocks.

## Quickstart

```typescript
import {
  AgentLoop,
  createBudgetState,
  createProviderRouter,
} from "@vauban-org/agent-sdk";

const router = createProviderRouter({
  groqApiKey: process.env.GROQ_API_KEY,
});

const loop = new AgentLoop({
  agentId: "my-agent",
  agentVersion: "0.1.0",
  systemPrompt: "You are a helpful assistant.",
  provider: router,
  tools: myToolRegistry,
  budget: createBudgetState({ maxSteps: 10 }),
});

const result = await loop.run("Summarise the latest market news.");
console.log(result.finalMessage);
```

## Public API

See [CONTRACT.md](./CONTRACT.md) for all signatures and the breaking-change policy.

| Export | Description |
|--------|-------------|
| `AgentLoop` | Multi-provider loop (Anthropic + Groq cascade) |
| `SdkAgentLoop` | Anthropic-direct loop with permission enforcement |
| `AgentRegistry` | Plugin registration + descriptor validation |
| `createBudgetState` | Per-run budget counters |
| `createCoherenceDetector` | Loop/stall detection |
| `createProviderRouter` | Anthropic → Groq fallback router |
| `InMemoryApprovalStore` | In-process HITL approval store |
| `sanitizeExternalInput` | Prompt injection defence |
| `keepSafeOnly` | Filter + return clean items |
| `recordOutcome` | OTel span finalisation helper |
| `createAgentRunTracker` | DB-backed token/cost accounting |
| `createBullMQRunner` | BullMQ queue/worker/DLQ factory |
| `AGENT_IDS` | Stable UUIDs per agent archetype |
| `mapScopesToSdkPermissions` | JWT scope → SdkPermissions |

## Architecture

```
@vauban-org/agent-sdk
├── loop/          AgentLoop (minimal-loop) + SdkAgentLoop (sdk-loop)
├── budget/        AgentBudgetState, CoherenceDetector, compactToolLog
├── router/        ProviderRouter (Anthropic + Groq)
├── hitl/          ApprovalChannel interface + InMemoryApprovalStore
├── permissions/   SdkPermissions, mapScopesToSdkPermissions
├── safety/        sanitizeExternalInput, keepSafeOnly
├── tracking/      OTel gen-ai spans + AgentRunTracker
├── durable/       BullMQRunner (queues, workers, DLQ, flow)
└── registry/      AgentRegistry + AGENT_IDS
```

## Trading-NQ Paper Validation (Required Before Live)

Before flipping `TRADING_MODE=live`:

1. Run 3 weeks of `TRADING_MODE=paper` cycles in production env
2. Verify `net_roi_pct` stable (median > 0 across 21 days)
3. Verify `slippage_bps` tolerable (P95 < 5 bps)
4. Founder + RSO sign-off (per `governance/founder-authority.md`)

## Workspace dep (Command Center)

```json
"@vauban-org/agent-sdk": "workspace:*"
```
