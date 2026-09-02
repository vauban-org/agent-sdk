---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# `stdoutTelemetrySink`

Emits one **JSON line per event** to `process.stderr` (by default). Designed
for dev visibility — pipe through `jq`, `pino-pretty`, or any structured-log
collector.

## Why stderr, not stdout ?

Many agents print their *application output* to stdout. Mixing telemetry
JSON lines with that output corrupts both pipelines. stderr is the
conventional "diagnostics" channel that doesn't interfere.

## Usage

```ts
import { stdoutTelemetrySink } from "@vauban-org/agent-sdk";

createOODAAgent({
  agentId: "my-agent",
  telemetry: stdoutTelemetrySink(),   // shorthand — single sink
});
```

Or compose with the bus :

```ts
import { createTelemetryBus, stdoutTelemetrySink, localSqliteTelemetrySink } from "@vauban-org/agent-sdk";

createOODAAgent({
  agentId: "my-agent",
  telemetry: createTelemetryBus({
    sinks: [stdoutTelemetrySink(), localSqliteTelemetrySink()],
  }),
});
```

## Options

```ts
stdoutTelemetrySink({
  stream?: NodeJS.WritableStream;   // default: process.stderr
  json?: boolean;                   // default: true (else key=value)
});
```

## Output sample

```bash
node my-agent.ts 2>&1 | jq -c
```

```json
{"telemetry":"run.start","runId":"abc-…","agentId":"my-agent","agentVersion":"1.0.0","model":"unknown","provider":"unknown","startedAt":"2026-05-16T17:00:00.000Z"}
{"telemetry":"run.step","runId":"abc-…","stepIndex":0,"kind":"observe","status":"completed","inputTokens":127,"outputTokens":42,"costUsd":0.0008}
{"telemetry":"run.finish","runId":"abc-…","status":"success","finishedAt":"2026-05-16T17:00:05.012Z"}
```

## Tail-friendly recipes

```bash
# Live error monitoring
node my-agent.ts 2> >(jq -c 'select(.telemetry == "run.finish" and .status != "success")')

# Cost per agent (last 100 runs)
node my-agent.ts 2>&1 | jq -s 'map(select(.telemetry == "run.finish")) | group_by(.agentId) | map({agent: .[0].agentId, runs: length})'
```

## Failure modes

- **Stream closed mid-write** : Node's default behavior is to emit an
  `error` event on the stream. The sink does NOT swallow this — wire up
  `stream.on('error', …)` if you need custom recovery.
- **stderr disconnected** (`> /dev/null 2>&1`) : silently no-ops, as
  expected.

## Performance

Synchronous `stream.write()` — ~1 µs per event. Negligible. Safe to keep
enabled in production for low-rate agents.

For high-rate (>1000 events/sec) deployments, prefer `otlpTelemetrySink`
or the CC sink, which batch internally.
