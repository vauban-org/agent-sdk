---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Tier Templates

**Module:** `@vauban-org/agent-sdk` · **Since:** 0.20.0 (Vague 1.B.7, sprint-616)

Three templates are promoted from Forge to the SDK. Each maps to a tier in the OODA agent taxonomy:

| Tier | Template | Pattern |
|------|----------|---------|
| T1 — Rule-based | `createSimpleAgent` | observe → orient (rules) → decide (thresholds) → act → feedback |
| T2 — Reasoning | `createReasoningAgent` | observe → orient (LLM + Reflexion) → decide (LLM) → act → feedback |
| T3 — Complex | `createComplexAgent` | observe → orient (LLM + Debate) → decide (plan) → act → reflect → feedback |

All three return an `OODAAgent` via `createAgentFromConfig` under the hood.

---

## `createSimpleAgent` — Tier 1

For agents that don't need LLM reasoning: validators, KPI monitors, staking monitors, invoice processing.

```typescript
import {
  createSimpleAgent,
  ConsoleChannel,
  noopLogger,
} from "@vauban-org/agent-sdk";
import type {
  SimpleAgentOptions,
  SimpleDecision,
  SimpleExecutionResult,
  AgentFactoryDeps,
} from "@vauban-org/agent-sdk";

type Observation = { memoryUsagePct: number };
type Orientation = { critical: boolean };
type Feedback = { alertsSent: number };

const deps: Partial<AgentFactoryDeps> = {
  executionMode: "live",
  logger: noopLogger,
  messaging: new ConsoleChannel(),
  db: null as unknown as AgentFactoryDeps["db"],
  skills: {},
};

const agent = await createSimpleAgent<Observation, Orientation, Feedback>(
  deps as AgentFactoryDeps,
  {
    agentId: "memory-monitor",
    intervalMs: 30_000,
    observe: async () => ({ memoryUsagePct: process.memoryUsage().heapUsed / 1e9 }),
    orient: async (obs) => ({ critical: obs.memoryUsagePct > 0.85 }),
    decide: async (orient): Promise<SimpleDecision> => ({
      actions: orient.critical ? [{ type: "gc", payload: {} }] : [],
      rationale: orient.critical ? "Memory above 85%" : "Within bounds",
    }),
    act: async (decision): Promise<SimpleExecutionResult> => ({
      executed: decision.actions.map((a) => ({ type: a.type, success: true, details: "" })),
    }),
    feedback: async (result): Promise<Feedback> => ({ alertsSent: result.executed.length }),
  } satisfies SimpleAgentOptions<Observation, Orientation, Feedback>
);

await agent.start();
```

---

## `createReasoningAgent` — Tier 2

For agents that need LLM reasoning but not multi-agent debate: CFO IA, lead qualifier, churn predictor.

```typescript
import { createReasoningAgent } from "@vauban-org/agent-sdk";
import type {
  ReasoningAgentOptions,
  AgentFactoryDeps,
} from "@vauban-org/agent-sdk";

type Obs = { revenueData: number[] };
type Orient = { trend: string };
type Decision = { recommendation: string };
type Action = { sent: boolean };
type Feedback = { ok: boolean };

const agent = await createReasoningAgent<Obs, Orient, Decision, Action, Feedback>(
  deps as AgentFactoryDeps,
  {
    agentId: "cfo-agent",
    intervalMs: 3_600_000,
    observe: async () => ({ revenueData: [100, 120, 115] }),
    orient: async (obs, ctx) => {
      const response = await ctx.deps.llm?.complete({
        messages: [{ role: "user", content: `Analyze revenue: ${JSON.stringify(obs.revenueData)}` }],
      });
      return { trend: response?.content ?? "unknown" };
    },
    decide: async (orient, ctx) => {
      const response = await ctx.deps.llm?.complete({
        messages: [{ role: "user", content: `Recommend based on: ${orient.trend}` }],
      });
      return { recommendation: response?.content ?? "hold" };
    },
    act: async (decision) => {
      console.log("Recommendation:", decision.recommendation);
      return { sent: true };
    },
    feedback: async (result) => ({ ok: result.sent }),
  } satisfies ReasoningAgentOptions<Obs, Orient, Decision, Action, Feedback>
);
```

`ReasoningAgentConfig` also accepts `thinkingBudget` for Anthropic extended thinking support via `ctx.deps.llm`.

---

## `createComplexAgent` — Tier 3

For orchestrators, treasury agents, DevOps agents, security auditors — multi-agent coordination with optional HITL gate.

```typescript
import { createComplexAgent } from "@vauban-org/agent-sdk";
import type { ComplexAgentOptions, AgentFactoryDeps } from "@vauban-org/agent-sdk";

type Obs = { pendingSwaps: Array<{ id: string; amountUsdc: number }> };
type Orient = { riskScore: number; recommendation: string };
type Decision = { steps: string[] };
type Action = { executed: string[] };
type Feedback = { success: boolean };

const agent = await createComplexAgent<Obs, Orient, Decision, Action, Feedback>(
  deps as AgentFactoryDeps,
  {
    agentId: "treasury-agent",
    intervalMs: 900_000,
    hitlEscalationLevel: "L2",       // HITL gate on act phase
    observe: async () => ({ pendingSwaps: [] }),
    orient: async (_obs, ctx) => {
      const res = await ctx.deps.llm?.complete({
        messages: [{ role: "user", content: "Assess treasury risk..." }],
      });
      return { riskScore: 0.3, recommendation: res?.content ?? "" };
    },
    decide: async (orient) => ({
      steps: orient.riskScore > 0.7 ? ["pause", "alert"] : ["proceed"],
    }),
    act: async (decision) => ({ executed: decision.steps }),
    feedback: async (result) => ({ success: result.executed.length > 0 }),
  } satisfies ComplexAgentOptions<Obs, Orient, Decision, Action, Feedback>
);
```

`ComplexAgentOptions` supports an optional `reflect` phase (self-critique with Reflexion memory) between `act` and `feedback`.

---

## Choosing a tier

```
No LLM needed?         → T1 SimpleAgent
LLM + self-reasoning?  → T2 ReasoningAgent
Multi-agent / HITL?    → T3 ComplexAgent
```

All tiers support: `sessionGuards`, `riskGuards`, `outcomeMapping`, and auto-registration via `registryDescriptor` when `deps.registry` is set.
