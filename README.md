# @vauban-org/agent-sdk

[![npm](https://img.shields.io/npm/v/@vauban-org/agent-sdk?color=0ea5e9&label=npm)](https://www.npmjs.com/package/@vauban-org/agent-sdk)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://www.typescriptlang.org/)

Multi-turn agents take unpredictable paths through tools and memory. This SDK gives you a typed, composable runtime: four execution strategies, tiered conversation memory, HITL approval gates, a multi-channel publisher registry, and a content quality gate.

## Why

- LLM loops are stateful. Without explicit memory management, context windows fill up silently and degrade output quality.
- Approval workflows live in Slack threads and spreadsheets. The HITL gate brings them into the execution path.
- Publishing to X, LinkedIn, email, and Discord each has different rate limits and format constraints. The publisher registry normalises them behind one interface.
- Content policy violations are caught at review time, not before. The quality gate runs inline.

## Install

```bash
npm install @vauban-org/agent-sdk
```

## 60-second quickstart

```typescript
import { Agent, createBudgetState, createProviderRouter } from "@vauban-org/agent-sdk";

const router = createProviderRouter({ groqApiKey: process.env.GROQ_API_KEY });

const agent = new Agent({
  strategy: "ooda",
  systemPrompt: "You are a helpful assistant.",
  provider: router,
  tools: myTools,
  budget: createBudgetState({ maxSteps: 20 }),
});

const result = await agent.run("Analyse the latest market data.");
console.log(result.finalMessage);
```

## Strategies

Four strategies ship out of the box. All hooks (HITL, attestation, `onStep`) work uniformly across all four.

| Strategy | Behaviour | When to pick it |
|----------|-----------|-----------------|
| `"ooda"` | Observe, orient, decide, act loop (default) | General-purpose agentic tasks |
| `"react"` | Reason out loud before each tool call | Debugging, interpretability |
| `"plan"` | Plan upfront, then execute sequentially | Tasks with known, stable sub-steps |
| `"one-shot"` | Single LLM call, no loop | Low-latency, simple completions |

`AgentLoop` remains available as a deprecated shim: it maps to `Agent` with `strategy: "ooda"`.

## Tiered memory (ConversationContext)

`ConversationContext` keeps a working-memory window of recent turns and compacts older turns via LLM summary when the window fills.

```typescript
import { ConversationContext } from "@vauban-org/agent-sdk";

const ctx = new ConversationContext({ workingMemorySize: 6 });
ctx.addTurn({ role: "user", content: "..." });
ctx.addTurn({ role: "assistant", content: "..." });

// Compact at 70% fill: older turns become a rolling LLM summary
await ctx.maybeCompact(model, llmFn, 0.70);

// Snapshot for persistence across process restarts
const snap = ctx.toJSON();
const ctx2 = ConversationContext.fromJSON(snap);
```

With Brain integration (optional), compaction summaries are archived to long-term memory and restored at startup:

```typescript
import { createBrainCompactionLlmFn, restoreSessionContext } from "@vauban-org/agent-sdk";

const brainLlmFn = createBrainCompactionLlmFn(brainMemory, localLlmFn, sessionTag);
const priorContext = await restoreSessionContext(brainMemory, sessionTag);
// priorContext injects as ## Long-term context in the system prompt
```

## HITL approval gates

Pause execution and route a request to any notification channel before the agent continues.

```typescript
import { Agent, InMemoryApprovalStore, createBudgetState } from "@vauban-org/agent-sdk";

const agent = new Agent({
  strategy: "ooda",
  provider: router,
  tools: myTools,
  budget: createBudgetState({ maxSteps: 20 }),
  hitl: {
    approvalStore: new InMemoryApprovalStore(),
    notifyFn: async (request) => {
      // send to Slack, Telegram, Discord — your call
    },
  },
});
```

## Publisher registry

One interface for X (threads, 280-char enforced), LinkedIn (3000-char, auto-retry 429), email, Discord, and GitHub.

```typescript
import { createPublisherRegistry } from "@vauban-org/agent-sdk/publishers";

const publishers = createPublisherRegistry({
  x: new XPublisher(),
  linkedin: new LinkedInPublisher(),
  email: new EmailPublisher(),
  discord: new DiscordPublisher(),
  github: new GitHubPublisher(),
});

await publishers.publish("x", payload, context);
```

## Quality gate

Evaluate a content payload against a persona's content policy before it reaches a publisher.

```typescript
import { evaluateQualityGate } from "@vauban-org/agent-sdk/marketing";

const result = evaluateQualityGate({
  persona,   // single source of content-policy rules
  payload,   // { text, thread?, hashtags?, mentions? }
});

if (!result.passed) {
  console.log(result.violations); // forbidden_pattern matches
  console.log(result.warnings);   // must_not directive hits
}
```

## Remote-control (observe + steer from anywhere)

The `remote/*` surface lets a phone, a browser, or another terminal observe a live agent session and steer it mid-run. Two transports : LAN-direct HTTP+SSE (`createRemoteControlServer`), and zero-knowledge relay (`connectRelay` + `@vauban-org/preste-relay`). Both expose the same logical API.

```typescript
import {
  createRemoteControlHub,
  createRemoteApprovalChannel,
  createRemoteControlServer,
  connectRelay,
} from "@vauban-org/agent-sdk";

const hub = createRemoteControlHub();
const approval = createRemoteApprovalChannel({ sink: hub });

// LAN-direct
const server = await createRemoteControlServer(hub, { token, approvalChannel: approval });

// Or relay from anywhere
const relay = await connectRelay({ relayUrl, hub, approvalChannel: approval });
```

### Capability-scoped handoff (T6f)

Mint a bounded sub-token a collaborator can use to observe or partially steer the session. HMAC-attenuated from the parent token ; verified in O(1) with no key registry.

```typescript
import { mintSubToken, verifySubToken, resolveAuthScope } from "@vauban-org/agent-sdk";

const sub = mintSubToken({ parentToken, scope: "approve-only", ttlSec: 3600 });
// hand `sub` to the collaborator ; they use it as Authorization: Bearer <sub>
```

### Device-binding (P1b + P1b-2)

A standard sub-token is a bearer ; whoever holds the string can use it until expiry. P1b binds a sub-token to a device's keypair via RFC 7800 `cnf` claim + RFC 9449 DPoP proof. Stolen sub-token alone is useless without the matching device key.

```typescript
import {
  rebindSubToken,
  computeJwkThumbprint,
  validateDpopProof,
  DpopReplayStore,
  type RebindSubTokenOptions,
  type RebindSubTokenResult,
  type EcP256Jwk,
} from "@vauban-org/agent-sdk";

// Server-side upgrade : bearer sub-token → device-bound sub-token.
// Inherits scope + remaining TTL. Caller revokes the old jti.
const result: RebindSubTokenResult = rebindSubToken({
  parentToken,
  oldSubToken: bearer,
  jwk: deviceJwk,
});
// result : { subToken, expiresAt, scope, oldJti, newJti }
```

`createRemoteControlServer` ships a `POST /remote/bind-device` route that orchestrates this end-to-end : verifies the bearer, mints the device-bound replacement, revokes the old jti via the configured `PersistencePort` before returning 200. Every subsequent `/remote/*` request must then carry a DPoP proof JWT signed by the matching device key ; `validateDpopProof` enforces method / URL / iat / jti-replay checks against the bound thumbprint. See [docs/device-binding.md](../../docs/device-binding.md) + [docs/remote-control.md](../../docs/remote-control.md).

### AG-UI event-name migration (2.27.0 ; default flipped in 2.28.0)

Vauban emitted dotted-lowercase event types since 2.11.0 (`run.start`, `assistant.delta`, `tool.call.start`, etc.). The AG-UI canonical vocabulary (Linux Foundation, late 2025) defines those same lifecycle events as UPPER_SNAKE_CASE (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, etc.). 2.27.0 shipped dual emission as a compatibility bridge ; 2.28.0 flipped the default.

**Default = canonical from 2.28.0 onwards.** `createRemoteControlHub()` with no explicit option now emits the AG-UI UPPER_SNAKE_CASE vocabulary directly. Consumers that depended on the legacy implicit default (preste-pwa SSE reader, dashboard render, gateway render, signed-event verification flows pre-2.28.0) MUST now pass `eventNaming: "legacy"` explicitly until they ship canonical-aware readers.

```typescript
import { createRemoteControlHub } from "@vauban-org/agent-sdk";

// 2.28.0+ default ; AG-UI canonical wire shape.
const hub = createRemoteControlHub();
// Emits RUN_STARTED, TEXT_MESSAGE_CONTENT, RUN_FINISHED, TOOL_CALL_START, etc.
// Passes @vauban-org/agent-sdk-conformance's `events.type_in_vocabulary` check out of the box.

// Legacy opt-in for consumers pinned to the dotted-lowercase wire shape.
const legacyHub = createRemoteControlHub({ eventNaming: "legacy" });
```

The CLI (`@vauban-org/preste`, `preste --remote` host), the PWA, and the dashboard stay pinned to `eventNaming: "legacy"` via explicit option until the canonical-aware readers ship in the next milestone ; new SDK consumers should pick up the default and migrate forward.

The hub normalises every emitted event at the boundary via `normalizeEventType()` from `remote/event-name-map.ts` ; that module is the single source of truth for the bidirectional `LEGACY_TO_CANONICAL` + `CANONICAL_TO_LEGACY` mappings. The conformance package [`@vauban-org/agent-sdk-conformance`](../agent-sdk-conformance/README.md) consumes the same canonical vocabulary and is the normative oracle for the wire format ; if `events.type_in_vocabulary` PASSES under canonical mode, the server is AG-UI-compliant.

Vauban-specific extensions with no AG-UI peer (`tool.intent`, `hitl.request`, `hitl.resolved`, `instruction.injected`) project onto `CUSTOM_*` names under the canonical default ; round-tripping through `LEGACY_TO_CANONICAL` → `CANONICAL_TO_LEGACY` is lossless.

**Permissive consumers**. `looksLikeSessionEvent(input)` is a runtime guard that accepts either form ; use it in relay / dashboard / PWA handlers that must tolerate a server emitting legacy OR canonical types. `isKnownEventType(name)` returns true for any name in either vocabulary plus the `CUSTOM_*` extensions.

**Roadmap** :

| Version | Default | Legacy on input | Legacy on output |
|---|---|---|---|
| 2.27.0 | legacy | accepted | emitted (default) |
| **2.28.0** | **canonical** | **accepted** | **opt-in via `eventNaming: "legacy"`** |
| 2.29.0 | canonical | accepted + deprecation warning | removed |
| 3.0.0 | canonical only | rejected | removed |

Consumers that need to interoperate now ship the permissive guard ; consumers that only need to read should switch to canonical as soon as possible to ease 2.29 / 3.0 readiness.

See [docs/remote-control.md](../../docs/remote-control.md#canonical-naming-migration-227) for the consumer-side migration recipe.

## API reference

See [CONTRACT.md](./CONTRACT.md) for all exported signatures and the breaking-change policy.

## Contributing

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
