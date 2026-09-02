---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# @vauban-org/agent-sdk — Quickstart

**Version:** 0.17.x (Vague 1.B) · **Node:** >=20 · **Package manager:** pnpm

## Install

```bash
pnpm add @vauban-org/agent-sdk
```

## First OODA agent in under 10 minutes

```typescript
import { createSimpleAgent, LiteLLMAdapter, ConsoleChannel } from "@vauban-org/agent-sdk";
import type { AgentFactoryDeps } from "@vauban-org/agent-sdk";
import { noopLogger } from "@vauban-org/agent-sdk";

const deps: AgentFactoryDeps = {
  executionMode: "dry-run",
  logger: noopLogger,
  db: null as unknown as AgentFactoryDeps["db"],
  skills: {},
  brain: undefined,
  messaging: new ConsoleChannel(),
};

const agent = await createSimpleAgent(deps, {
  agentId: "kpi-monitor",
  intervalMs: 60_000,
  observe: async () => ({ latencyMs: 42 }),
  orient: async (obs) => ({ slow: obs.latencyMs > 200 }),
  decide: async (orient) => ({
    actions: orient.slow ? [{ type: "alert", payload: { msg: "latency high" } }] : [],
    rationale: orient.slow ? "Latency exceeded threshold" : "All good",
  }),
  act: async (decision) => ({
    executed: decision.actions.map((a) => ({ type: a.type, success: true, details: "" })),
  }),
  feedback: async (result) => ({ count: result.executed.length }),
});

await agent.start();
```

That is all. The OODA loop (Observe → Orient → Decide → Act → Feedback) runs every `intervalMs` milliseconds.

## Next steps

| Topic | Doc |
|-------|-----|
| Choose your LLM provider | [byom.md](byom.md) |
| Port contracts (LLM, Messaging, HITL, EventBus…) | [ports/](ports/llm-provider.md) |
| Tier templates (Simple, Reasoning, Complex) | [templates.md](templates.md) |
| Cost routing & circuit-breaker | [economy.md](economy.md) |
| Platform sub-package | [platforms.md](platforms.md) |
| Migration from 0.15 | [migration/0.15-to-0.17.md](migration/0.15-to-0.17.md) |
| Contributing | [contributing.md](contributing.md) |
