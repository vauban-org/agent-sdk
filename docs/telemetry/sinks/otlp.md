---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# `otlpTelemetrySink`

Pushes agent runs to any **OpenTelemetry Protocol over HTTP** receiver,
JSON-encoded. Works with Langfuse self-host, Grafana Tempo, Jaeger,
Honeycomb, Datadog, any OTLP-compliant collector — no vendor lock-in.

## Usage

```ts
import { otlpTelemetrySink } from "@vauban-org/agent-sdk";

otlpTelemetrySink({
  url: "https://langfuse.vauban.tech/api/public/otel",
  headers: { Authorization: "Basic <base64(pub:sec)>" },
});
```

## Options

```ts
otlpTelemetrySink({
  url: string;                         // base URL ; `/v1/traces` is appended
  headers?: Record<string, string>;    // static, includes auth
  serviceName?: string;                // OTel resource attribute (default: "vauban-agent-sdk")
  fetchImpl?: typeof fetch;            // test override
  timeoutMs?: number;                  // request timeout (default: 5000)
});
```

## OTel semantic conventions

The sink maps SDK events to OpenTelemetry spans using **GenAI semantic
conventions** (`gen_ai.*` namespace) plus Vauban-specific extensions :

| Span attribute | Source | Convention |
|---|---|---|
| `service.name` | `serviceName` option | OTel resource |
| `gen_ai.system` | `event.provider` | OTel GenAI |
| `gen_ai.request.model` | `event.model` | OTel GenAI |
| `gen_ai.usage.input_tokens` | `event.totalInputTokens` | OTel GenAI |
| `gen_ai.usage.output_tokens` | `event.totalOutputTokens` | OTel GenAI |
| `vauban.run_id` | `event.runId` | Vauban ext |
| `vauban.agent.id` | `event.agentId` | Vauban ext |
| `vauban.agent.version` | `event.agentVersion` | Vauban ext |
| `vauban.run.status` | `event.status` | Vauban ext |
| `vauban.run.stop_reason` | `event.stopReason` | Vauban ext |
| `vauban.run.cost_usd` | `event.totalCostUsd` | Vauban ext |
| `vauban.run.steps` | step count | Vauban ext |

Step events emit child spans named `ooda.<kind>` with attributes
`vauban.step.{index,kind,status,tool_calls,cost_usd}` + tokens.

## Span structure

```
trace (single)
└── span: ooda.cycle.<agentId>                    [parent]
    ├── span: ooda.observe                        [step 0]
    ├── span: ooda.orient                         [step 1]
    ├── span: ooda.decide                         [step 2]
    └── span: ooda.act                            [step 3]
```

trace_id is preserved from the caller — pass `event.traceId` to link to
upstream traces (e.g. an inbound HTTP request).

## Wire format

JSON-encoded OTLP/HTTP (not protobuf). Reasoning : avoids pulling the
`@opentelemetry/exporter-trace-otlp-proto` dependency. JSON is a
first-class OTLP transport since v1.0.

Sample payload :

```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        { "key": "service.name", "value": { "stringValue": "vauban-agent-sdk" } }
      ]
    },
    "scopeSpans": [{
      "scope": { "name": "vauban.agent.ooda", "version": "1.3.0" },
      "spans": [{
        "traceId": "abc...32 hex chars",
        "spanId": "def...16 hex chars",
        "name": "ooda.cycle.my-agent",
        "startTimeUnixNano": "1747414800000000000",
        "endTimeUnixNano":   "1747414805012000000",
        "kind": 1,
        "attributes": [...],
        "status": { "code": 1 }
      }]
    }]
  }]
}
```

## Failure modes

- **5xx** : the bus retries (default RETRY_TRANSIENT). After exhaustion,
  warned and dropped.
- **4xx** : NOT retried (auth/quota errors). Logged and dropped.
- **Timeout** : `AbortController` after `timeoutMs`. Counted as transient.

## Performance

One HTTP request per `step` and `finish` event. Not batched at the sink
level. For high-volume agents, wrap with a batcher or use the CC sink
(which batches).

## Common backends

### Langfuse self-host (Vauban's choice)

```ts
otlpTelemetrySink({
  url: "https://langfuse.vauban.tech/api/public/otel",
  headers: { Authorization: `Basic ${btoa("pk_xxx:sk_xxx")}` },
});
```

Per [Brain entry 426c92f5](https://command.vauban.tech/brain/426c92f5),
`langfuse.vauban.tech` is the self-hosted Langfuse already deployed on
K3s. Free for ecosystem usage.

### Grafana Tempo

```ts
otlpTelemetrySink({
  url: "http://tempo.observability.svc.cluster.local:4318",
});
```

### Jaeger (dev)

```bash
docker run -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
```

```ts
otlpTelemetrySink({ url: "http://localhost:4318" });
```

UI at `http://localhost:16686`.
