---
classification: C0
product: command-center
status: active
escalation: pending-founder-review
owner: founder
review_due: 2026-09-12
source_repo: command-center
---
# Privacy & Sovereignty

Per [ADR-ECO-039 §5](https://github.com/vauban-org/vauban-gouvernance/blob/main/governance/decisions/ADR-ECO-039-sdk-telemetry-port.md),
these are non-negotiable guarantees of the telemetry pipeline.

## Six guarantees

### 1. Zero phone-home by default

```ts
createOODAAgent({
  agentId: "my-agent",
  // no `telemetry` field — sink is NOOP_TELEMETRY_SINK
});
```

No network calls. No DNS lookups. No "anonymous usage statistics". The
sink is `NOOP_TELEMETRY_SINK` and silently no-ops.

### 2. Local sink always available

When you opt in to ANY sink via `createTelemetryBus`, you can also
include `localSqliteTelemetrySink()` — there is no scenario in which
opting in to a remote sink requires giving up the local mirror.

The local file is the *exit plan* for every external dependency
([Sovereignty principle](https://github.com/anthropics/claude-code/blob/main/docs/sovereignty.md)).

### 3. PII never crosses sinks unless opted in

OODA `step` events carry an optional `metadata` field that may contain
raw prompts, completions, tool inputs, or addresses. By default the SDK
**redacts** known-sensitive fields and hashes the rest before passing to
sinks.

To opt in to raw payloads (e.g. for debugging in a private deployment) :

```ts
createOODAAgent({
  telemetry: createTelemetryBus({
    sinks: [...],
    includePayloads: true,    // ← explicit opt-in
  }),
});
```

A startup warning is logged to make this choice visible.

### 4. Tenant isolation

The CC backend enforces row-level security : every `agent_run` and
`telemetry_run_step` row carries the `tenant_id` resolved server-side
from the API key. **No cross-tenant SELECTs are possible** — even with
a compromised key from another tenant, queries are scoped by RLS policy
to that key's tenant only.

Verified by the test suite (`tests/routes/telemetry-ingest.test.ts`,
test "tenant_id from API key").

### 5. Audit log of active sinks

Upcoming in v1.4 :

```bash
vauban-agent telemetry status

Active sinks:
  - stdout                                       (1 of 1 healthy)
  - sqlite        ~/.vauban/runs.db              (1 of 1 healthy, 1.2 MB)
  - command-center https://command.vauban.tech   (1 of 1 healthy, last successful POST 12s ago)
```

Allows immediate auditing of "where my data is being sent right now".

### 6. Sink failures never block the agent

```ts
const bus = createTelemetryBus({
  sinks: [
    networkSink_thatThrows,
    sqliteSink_thatWorks,
  ],
  logger: pinoLogger,
});

// runCycle() succeeds. SQLite captures. Network sink failure is logged.
await agent.triggerCycle();
```

This is enforced at the bus level via per-sink try/catch + log. The
host agent's `runCycle` is untouched by sink failures.

## Things we do NOT do

- We do NOT collect anonymous telemetry about your SDK usage. Period.
- We do NOT phone home to check for SDK updates.
- We do NOT silently retry telemetry after the user revokes their API
  key — 401s are not retried.
- We do NOT keep deleted data. A scheduled job on the Command Center
  backend deletes runs older than the tenant's retention window (7
  days free, 30 days Team, 1 year Pro, indefinite Sovereign).

## Things we DO do (transparently)

- We log a warning at startup if you configure a remote sink AND opt
  out of the local sink. Sovereignty preserved by signal.
- We embed the SDK version in the User-Agent of every POST. This lets
  the CC backend tell users when they're running a SDK version below
  the minimum supported (e.g. critical security patch).
- We record `last_used_at` on the API key server-side. Visible to the
  tenant only.

## How to verify

- Run with `node --inspect` and check the network panel — only the
  hosts you configured should appear.
- Run `tcpdump` filtered on your agent's PID — confirm zero traffic
  outside the configured sinks.
- Read the source — it's MIT, 700 LOC in `packages/agent-sdk/src/telemetry/`.

## How to report a violation

If you observe behavior that violates any of these six guarantees —
files transmitted you didn't authorize, fields appearing in dashboards
you redacted, etc. — please open a GitHub security advisory at
[github.com/vauban-org/command-center/security](https://github.com/vauban-org/command-center/security/advisories/new).
We treat this as P0.
