---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Platform Clients

**Module:** `@vauban-org/agent-sdk` (clients sub-package) · **Since:** 0.8.2 (sprint-524:quick-9)

## Purpose

The SDK ships REST client helpers so agents can communicate with Command Center, Brain, and peer agents without re-implementing HTTP boilerplate. These clients are thin wrappers — no state, no circuit breaking (use `EconomyRouter` or `circuitBreaker` from the resilience module for that).

---

## Available clients

```typescript
import {
  createAgentsClient,
  createPipelinesClient,
} from "@vauban-org/agent-sdk";
import type {
  AgentsClient,
  AgentsClientOptions,
  AgentExecuteInput,
  AgentExecuteResult,
  PipelinesClient,
  PipelinesClientOptions,
  PipelineRunInput,
  PipelineRunResult,
} from "@vauban-org/agent-sdk";
```

All imports come from `"@vauban-org/agent-sdk"` (no subpath required).

---

## PipelinesClient

Trigger and poll Command Center pipelines.

```typescript
import { createPipelinesClient } from "@vauban-org/agent-sdk";
import type { PipelinesClientOptions } from "@vauban-org/agent-sdk";

const pipelines = createPipelinesClient({
  baseUrl: process.env["CC_API_URL"]!,
  getToken: async () => process.env["CC_SERVICE_TOKEN"]!,
} satisfies PipelinesClientOptions);

// Trigger a pipeline
const run = await pipelines.run({ name: "vault-guardian", payload: { vaultId: "usdc-main" } });
console.log(run.runId, run.statusUrl);

// Poll status
const status = await pipelines.status(run.pipelineId);
console.log(status.status);  // string — e.g. "completed" | "running" | "failed"

// List available pipelines
const { pipelines: list } = await pipelines.list();
console.log(list.map((p) => p.name));
```

---

## AgentsClient

Execute peer agents registered in Command Center.

```typescript
import { createAgentsClient } from "@vauban-org/agent-sdk";
import type { AgentsClientOptions, AgentExecuteInput } from "@vauban-org/agent-sdk";

const agents = createAgentsClient({
  baseUrl: process.env["CC_API_URL"]!,
  getToken: async () => process.env["CC_SERVICE_TOKEN"]!,
} satisfies AgentsClientOptions);

const result = await agents.execute({
  agentId: "ARCHITECT",
  taskType: "architecture-review",
  description: "Review the new event bus design",
  archiveToBrain: true,
} satisfies AgentExecuteInput);

console.log(result.runId, result.runUrl);

// List the agent registry
const { agents: registry } = await agents.listRegistry();
```

---

## MessagingAdapters

The SDK ships a lightweight command-parsing bridge for Telegram/Slack slash commands that dispatches to `AgentsClient` or `PipelinesClient`:

```typescript
import type {
  TelegramTriggerContext,
  SlackTriggerContext,
  MessagingTriggerResult,
} from "@vauban-org/agent-sdk";
```

See `src/clients/messaging-adapters.ts` for the full slash-command parse API (`/run`, `/pipeline`, `/status`).

---

## Resilience (co-use)

Platform clients have no built-in retry or circuit breaking. Wrap them with SDK resilience primitives:

```typescript
import { circuitBreaker, idempotent } from "@vauban-org/agent-sdk";

const protectedPipelines = circuitBreaker(pipelines.trigger.bind(pipelines), {
  threshold: 3,
  timeout: 30_000,
});

// With idempotency key to prevent duplicate pipeline triggers
const safeTrigger = idempotent(protectedPipelines, {
  cache: myIdempotencyCache,
  keyFn: (pipelineId, payload) => `trigger:${pipelineId}:${JSON.stringify(payload)}`,
});
```

---

## Starknet / DataOps clients

For Starknet-specific data queries, the SDK ships optional data access helpers:

```typescript
// These require `starknet` peerDep (optional)
import { createVoyagerClient } from "@vauban-org/agent-sdk";
import { createStarkscanClient } from "@vauban-org/agent-sdk";
```

These are read-only data clients. All write operations to Starknet go through the `starknet-mcp` server, never directly from agents.
