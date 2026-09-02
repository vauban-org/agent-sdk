---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Migration : 1.2 → 1.3

!!! success "Zero breaking changes"
    Existing 1.2.x consumers continue to work unchanged. All new APIs are
    additive.

## TL;DR

- `AgentRunTracker` still works. Marked deprecated, will be removed in 2.0.
- New `telemetry` field on `OODAAgentConfig`. Opt-in.
- 4 new sinks shipped : `stdout`, `sqlite`, `otlp` in core ; `cc` in
  `@vauban-org/cc-telemetry`.

## What changed

### `AgentRunFinalStatus` adds `"skipped"`

Before :

```ts
type AgentRunFinalStatus = "success" | "failed" | "timeout" | "incoherent";
```

After :

```ts
type AgentRunFinalStatus = "success" | "failed" | "skipped" | "timeout" | "incoherent";
```

`"skipped"` distinguishes session_guard / risk_guard / heap_exceeded
short-circuits from real successes. Existing exhaustive `switch` statements
on this type will need to add a case (TypeScript will surface it).

For the new `TelemetryRunStatus` type (used by the new sinks), see the
[port.ts source](https://github.com/vauban-org/command-center/blob/main/packages/agent-sdk/src/telemetry/port.ts).

### New optional `OODAAgentConfig.telemetry`

```ts
interface OODAAgentConfig {
  // …existing fields…
  readonly telemetry?: TelemetrySink;   // NEW, optional
}
```

When set, the OODA loop auto-emits `start` + `step` + `finish` events.
When omitted, behavior is identical to 1.2.

### Legacy `AgentRunTracker` is deprecated

```ts
import { createAgentRunTracker } from "@vauban-org/agent-sdk";   // deprecated

const tracker = createAgentRunTracker(db);
// Still works, still INSERTs into agent_run. Will be removed in 2.0.
```

Migration target :

```ts
import {
  createTelemetryBus,
  localSqliteTelemetrySink,
} from "@vauban-org/agent-sdk";
import { commandCenterTelemetrySink } from "@vauban-org/cc-telemetry";

const telemetry = createTelemetryBus({
  sinks: [
    localSqliteTelemetrySink(),
    commandCenterTelemetrySink({ apiKey: process.env.VAUBAN_API_KEY! }),
  ],
});

createOODAAgent({
  agentId: "my-agent",
  telemetry,
  // …no more `createAgentRunTracker(db)` needed
});
```

## Recipes for common migrations

### From `AgentRunTracker` to sinks

Before :

```ts
const tracker = createAgentRunTracker(db);
const uuid = await tracker.start({ agentId, agentVersion, runId, model, provider });
await tracker.recordStep(uuid, { inputTokens, outputTokens, costUsd });
await tracker.finish(uuid, { status: "success" });
```

After :

```ts
// No imperative calls — the OODA loop handles it.
createOODAAgent({
  agentId: "my-agent",
  telemetry: localSqliteTelemetrySink(),
});
// runCycle() automatically emits start/step/finish.
```

If you ran tracker calls *outside* the OODA loop (e.g. from a custom
event handler), you can still use it ; the loop's telemetry and the
custom calls coexist (they write to different tables in v1.3 :
`agent_run` for legacy tracker, `telemetry_run_step` for SDK sinks).

### From `console.log` to stdoutTelemetrySink

Before :

```ts
console.log("[my-agent] cycle start", { runId, agentId });
```

After :

```ts
createOODAAgent({
  agentId: "my-agent",
  telemetry: stdoutTelemetrySink(),
});
```

You get structured JSON automatically, plus the same data lands in any
other sinks you configure later.

## Removed (only in 2.0, not yet)

Targeted for removal in **2.0** (no earlier than Q4 2026) :

- `createAgentRunTracker(db)`
- `AgentRunTracker` interface
- `tracking/agent-run-tracker.ts` module
- `tracking/cost-tracked-agent-run-tracker.ts` (consumer in CC backend)

Until then, both APIs coexist.

## Testing the upgrade

```bash
# Pin to old version
pnpm add @vauban-org/agent-sdk@1.2.0

# Pin to new version
pnpm add @vauban-org/agent-sdk@1.3.0

# Run your test suite
pnpm test
```

You should see 0 failures, 0 new warnings (other than the deprecation
notice if you still call `createAgentRunTracker`).
