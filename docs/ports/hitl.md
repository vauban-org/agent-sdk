---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Port: HITLPort

**Module:** `@vauban-org/agent-sdk` · **Since:** 0.16.0 (plan v6 §1.7 + §3.4)

## Purpose

`HITLPort` is the stateful Human-In-The-Loop lifecycle contract. It manages the HITL state machine — from `pending` through `approved`/`rejected` to `executed`. State lives in the store (Postgres in production) **not** in the messaging channel. Channels are transports; state is the port's responsibility.

## State machine

```
pending → approved → executed
pending → rejected → executed
pending → expired          (terminal — no further transitions)
```

Attempting an illegal transition (e.g. `expired → approved`) throws `InvalidStateTransitionError`.

## Interface definition

```typescript
import type { HITLPort, HITLRequest, HITLState } from "@vauban-org/agent-sdk";
import {
  InvalidStateTransitionError,
  HITLNotFoundError,
  validateTransition,
  runExpireJob,
} from "@vauban-org/agent-sdk";

type HITLState = "pending" | "approved" | "rejected" | "expired" | "executed";

interface HITLRequest {
  id: string;
  agentSource: string;
  question: string;
  context: Record<string, unknown>;
  options: string[];
  deadline: string;          // ISO 8601
  channel: "telegram" | "slack" | "discord";
  tenantId?: string;
}

interface HITLPort {
  request(req: HITLRequest): Promise<string>;          // returns approvalId
  getState(id: string): Promise<HITLState>;
  await(id: string, timeoutMs?: number): Promise<HITLState>;
  resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void>;
  expire(id: string): Promise<void>;
}
```

## Available adapters

| Adapter | Import | Use case |
|---------|--------|---------|
| `MemoryHITLStateStore` | `@vauban-org/agent-sdk` | Tests, local dev |
| `PostgresHITLStateStore` | `@vauban-org/agent-sdk` | Production |

## Usage example

```typescript
import {
  MemoryHITLStateStore,
  runExpireJob,
} from "@vauban-org/agent-sdk";
import type { HITLPort, HITLRequest } from "@vauban-org/agent-sdk";

const store: HITLPort = new MemoryHITLStateStore();

// Start background expiry job (60s interval by default)
const expireTimer = runExpireJob(store);

// Agent requests approval
const approvalId = await store.request({
  id: crypto.randomUUID(),
  agentSource: "treasury-agent",
  question: "Approve swap of 10,000 USDC to ETH?",
  context: { estimatedCostCents: 250, route: "uniswap-v3" },
  options: ["approve", "reject"],
  deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  channel: "telegram",
});

// Human resolves via webhook/bot handler
await store.resolve(approvalId, "approved", "operator@example.com");

// Agent polls or awaits resolution
const finalState = await store.await(approvalId, 10_000);
console.log(finalState); // "approved"

// Cleanup
clearInterval(expireTimer);
```

## HITL slack/telegram helpers

The SDK also ships channel-specific HITL sending helpers:

```typescript
import { sendHITLApprovalRequestSlack } from "@vauban-org/agent-sdk";
import { sendHITLApprovalRequestTelegram } from "@vauban-org/agent-sdk";
import { createNodeSlackCallbackHandler } from "@vauban-org/agent-sdk";
```

See `@vauban-org/agent-sdk/hitl/slack` and `@vauban-org/agent-sdk/hitl/telegram` subpaths for the full helper API.
