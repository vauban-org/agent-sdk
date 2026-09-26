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

// Human resolves via webhook/bot handler. `by` MUST be a structured,
// individual identity ("<channel>:<id>") — see "Approver identity (`by`)"
// below. This is illustrative; the Slack/Telegram callback handlers below
// build this string themselves from the inbound payload.
await store.resolve(approvalId, "approved", "telegram:123456789");

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

## Approver identity (`by`)

`HITLPort.resolve(id, decision, by)`'s `by` parameter is a **structured,
individual approver identity**, not a channel label. It has the shape:

```
"<channel>:<id>"
```

e.g. `"slack:U0123ABC"` or `"telegram:123456789"`. `id` is the channel's
stable, opaque/numeric user id — **never** a display name or `@username`
alone, since those can be renamed and are not suitable evidence for a
non-repudiation audit trail (this product's HITL approval flow is sold
against the AI Act's art. 12 record-keeping and art. 14 human-oversight
requirements).

Prior to this note, the Slack and Telegram callback handlers
(`src/hitl/slack.ts`, `src/hitl/telegram.ts`) passed the bare channel
constant (`"slack"` / `"telegram"`) as `by`. That meant the audit trail
could say *which channel* an approval came through but never *which human*
clicked the button — a correctness defect for a product whose value
proposition is non-repudiation. Both adapters now:

1. Extract the individual identifier from the inbound payload — Slack's
   `interaction.user.id`, Telegram's `callback_query.from.id` — and encode
   it as `"slack:<id>"` / `"telegram:<id>"` via the `formatApprover()`
   helper exported from `src/ports/hitl.ts`.
2. **Fail closed** when that id is absent from the payload: `resolve()` is
   never called, the attempt is logged, and the channel is told the
   approval could not be attributed to an individual (instead of silently
   recording it under the channel name). See the `*.test.ts` files next to
   each adapter for the exact behaviour.

`HITLPort.resolve()`'s signature (`by: string`) is unchanged — this is a
documented convention for the string's content, not a type-level guarantee.
Adapters other than Slack/Telegram (Discord, or any future channel) MUST
follow the same `"<channel>:<id>"` + fail-closed convention.

### Known limitation

The identity carried in `by` is the identity of the messaging account that
clicked the button (a Slack workspace member id, a Telegram user id), as
attested by that platform's webhook payload and — for Slack — its
HMAC-signed request. It is **not** a cryptographic signature made by the
approver themselves (e.g. no per-user key, no WebAuthn/passkey assertion).
A compromised Slack/Telegram account, or a platform-side spoof of the
payload, would still be attributed to that account. Strengthening this
further (per-approver cryptographic signing) is a separate, larger piece of
work and is out of scope here.

Separately, Telegram's webhook has no equivalent of Slack's HMAC request
signature unless the deployer explicitly configures
`TelegramCallbackHandlerOpts.callbackSecret` (`x-telegram-hmac-sha256`) —
and that header is not something Telegram's own Bot API sends by default;
it depends on the reverse proxy / bot framework in front of the webhook
adding it. A Telegram HITL webhook deployed without that secret configured
accepts unauthenticated callback payloads. This is a distinct defect from
the approver-identity one fixed here and is tracked separately.
