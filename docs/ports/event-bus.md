---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Port: EventBusPort

**Module:** `@vauban-org/agent-sdk` · **Since:** extended in sprint-615 (ADR-ECO-017)

## Purpose

`EventBusPort` is the agent-to-agent pub/sub abstraction over CloudEvents 1.0 + Redis Streams (ADR-007). It provides:

- At-least-once delivery with consumer-side dedup via CloudEvent `id` (UUIDv7)
- MAXLEN ~10,000 per stream (backpressure via truncation)
- Poison pill: 3 consecutive `XAUTOCLAIM` failures → auto-move to DLQ
- Cross-product events via `DomainEvent` (ADR-ECO-017 HMAC-SHA256 authentication)

## Interface definition

```typescript
import type {
  EventBusPort,
  CloudEvent,
  DomainEvent,
  EventSource,
  Subscription,
} from "@vauban-org/agent-sdk";

type EventSource =
  | "forge" | "vauban" | "vauban-finance" | "brain"
  | "citadel" | "glacis" | "cc" | "tenant";

interface CloudEvent {
  id: string;               // UUIDv7 — doubles as idempotency key
  specversion: "1.0";
  source: string;
  type: string;
  time: string;             // ISO 8601
  datacontenttype?: string;
  data?: unknown;
  traceparent?: string;
  correlationid?: string;
  partitionkey?: string;
  dataschemaversion?: number;
}

interface DomainEvent<T = unknown> {
  type: string;             // `<source>.<entity>.<action_past_tense>`
  source: EventSource;      // enum — receivers reject unknown sources
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;   // UUIDv7 — dual role: anti-replay + Inbox dedup
  timestamp: string;        // ISO 8601
  schemaVersion: string;    // semver
  payload: T;
  signature: string;        // HMAC-SHA256, set by signEvent()
}

interface Subscription {
  unsubscribe(): Promise<void>;
}

interface EventBusPort {
  publish(event: CloudEvent, stream: string): Promise<void>;
  publishWithIdempotency<T>(event: Omit<DomainEvent<T>, "signature">, key: string): Promise<void>;
  subscribe(stream: string, consumerGroup: string, handler: (e: CloudEvent) => Promise<void>): Promise<() => void>;
  subscribeDomain<T>(eventType: string, handler: (e: DomainEvent<T>) => Promise<void>, opts?: { groupId?: string; dlq?: string }): Subscription;
  replayFrom(streamKey: string, fromId: string): AsyncIterable<DomainEvent>;
  dlq(): { depth(): Promise<number>; replay(eventId: string): Promise<void> };
  pendingCount(stream: string, consumerGroup: string): Promise<number>;
}
```

## Cross-product events (ADR-ECO-017)

All cross-product events **must** be signed and verified via SDK helpers. Direct `crypto.createHmac` outside the SDK is forbidden (CI lint rule `no-direct-hmac-outside-sdk`).

```typescript
import { signEvent, verifyEvent, InMemoryNonceStore } from "@vauban-org/agent-sdk";
import type { DomainEvent } from "@vauban-org/agent-sdk";

// Signing (producer side)
const unsigned: Omit<DomainEvent, "signature"> = {
  type: "cc.cost.recorded",
  source: "cc",
  correlationId: crypto.randomUUID(),
  idempotencyKey: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  schemaVersion: "1.0.0",
  payload: { agentId: "treasury", costUsd: 0.0014 },
};

const signed = signEvent(unsigned, process.env["EVENT_SIGNING_KEY_CC"]!);

// Verification (consumer side)
const nonceStore = new InMemoryNonceStore();
await verifyEvent(signed, {
  getKey: (source) => process.env[`EVENT_SIGNING_KEY_${source.toUpperCase()}`] ?? null,
  nonceStore,
  clockSkewMs: 300_000,
});
```

Verification rejects with typed errors: `InvalidSignatureError`, `ClockSkewError`, `ReplayDetectedError`, `UnknownSourceError`.

## Event naming convention

Per ADR-ECO-017: `<source>.<entity>.<action_past_tense>` — source verb always past tense (events are facts).

```
cc.cost.recorded         ✅
brain.knowledge.archived ✅
forge.agent.started      ✅
forge.start-agent        ❌ (imperative, wrong)
```

Sources must be one of the `EventSource` enum values. Unknown sources trigger `UnknownSourceError` on the consumer side.

## Publishing with EconomyRouter integration

```typescript
import { EconomyRouter } from "@vauban-org/agent-sdk";

// EconomyRouter publishes cc.cost.recorded automatically when eventBus is provided
const router = new EconomyRouter({
  tiers: [ /* ... */ ],
  hourlyBudgetUsd: 1.0,
  monthlyBudgetUsd: 10.0,
  defaultTier: "cheap",
  eventBus: myEventBusImplementation,
});

router.recordCycle("treasury-agent", 0.0014, { input: 500, output: 200 });
// → publishes cc.cost.recorded to "cc.cost" stream
```
