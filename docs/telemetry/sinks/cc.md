---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# `commandCenterTelemetrySink`

Pushes agent runs to **Vauban Command Center** — free → sovereign tiers,
with optional Vauban Claim Algebra (VPSF) signatures on Pro+.

Shipped as a separate npm package to keep the core SDK MIT and zero-dep.

```bash
pnpm add @vauban-org/cc-telemetry
```

## Setup walkthrough (free tier)

### 1. Sign up at `command.vauban.tech`

GitHub OAuth, takes 30 seconds. Free tier auto-issued. No credit card.

### 2. Copy your API key

Settings → API Keys → "Generate". Format `vauban_pk_…` (free tier prefix).

!!! warning
    The key is shown **once**. Store securely. Compromised keys can be
    revoked from the same UI ; new key issuance is unlimited.

### 3. Configure the sink

```ts
import {
  createOODAAgent,
  createTelemetryBus,
  localSqliteTelemetrySink,
} from "@vauban-org/agent-sdk";
import { commandCenterTelemetrySink } from "@vauban-org/cc-telemetry";

createOODAAgent({
  agentId: "my-agent",
  telemetry: createTelemetryBus({
    sinks: [
      localSqliteTelemetrySink(),                       // sovereign mirror
      commandCenterTelemetrySink({
        apiKey: process.env.VAUBAN_API_KEY!,
      }),
    ],
  }),
});
```

### 4. Run a cycle, watch the dashboard

Every run shows up at `command.vauban.tech/runs` within 5 seconds. Filter
by agent, status, cost, time window. SSE-driven, no manual refresh needed.

## Options

```ts
commandCenterTelemetrySink({
  apiKey: string;            // REQUIRED — Bearer token from CC SaaS
  baseUrl?: string;          // default: "https://command.vauban.tech"
  batchSize?: number;        // events per HTTP batch (default 10, max 100)
  batchMs?: number;          // max wait before flush (default 5000)
  timeoutMs?: number;        // HTTP timeout (default 10_000)
  fetchImpl?: typeof fetch;  // test override
  retry?: RetryConfig;       // default: RETRY_TRANSIENT (3 attempts, exp + jitter)
  logger?: { warn, error };  // default: console.warn / console.error
});
```

## Tiers

| Tier | Key prefix | Monthly runs | Retention | Extra |
|---|---|---|---|---|
| Free | `vauban_pk_*` | 1 000 | 7 days | Dashboard read-only |
| Team €49/mo | `vauban_team_*` | 10 000 | 30 days | + Slack/Discord HITL hooks |
| Pro €490/mo | `vauban_pro_*` | 100 000 | 1 year | + VPSF signed runs + STARK per-call |
| Sovereign €180k/yr | mTLS + air-gap | unlimited | indefinite | + TDX/SEV-SNP enclave + L3 anchor |

Free tier upgrade : no SDK code change. Just rotate the API key.

The free tier policy (1000/mo + 7d) is intentionally narrow enough to
funnel adoption toward paid tiers without being unusable for solo devs
exploring the platform.

## Self-hosted Command Center

If you run the AGPL CC backend yourself ([ADR-ECO-014](https://github.com/vauban-org/vauban-gouvernance/blob/main/governance/decisions/ADR-ECO-014-cc-oss-release.md)),
override `baseUrl` :

```ts
commandCenterTelemetrySink({
  apiKey: "internal-key",
  baseUrl: "https://cc.myorg.internal",
});
```

No revenue for Vauban. Sovereignty respected.

## Batching behavior

Events accumulate in an in-memory queue until **either** `batchSize` events
collected **or** `batchMs` elapses **or** a `finish` event arrives
(which always force-flushes — dashboards see results immediately).

Single-flight : while a batch POST is in flight, new events queue locally.
Subsequent `flush()` calls await the in-flight request before sending the
next batch.

## Retry semantics

Errors are classified at the HTTP layer :

- **5xx + network errors** → retried per `retry` config (default 3 attempts,
  exponential backoff with ±25 % jitter via SDK's `retry()` helper).
- **4xx** (401 unauthorized, 429 quota exceeded) → NOT retried. Logged
  and dropped. Burning quota on retries would be net-negative.
- **Network timeout** → counted as 5xx (retryable).

After retry exhaustion, the batch is **dropped with a warning log**. The
sink itself never throws — failures are isolated by the SDK's TelemetryBus.

## Security

- API key sent as `Authorization: Bearer <key>`. **Always use HTTPS.**
- Keys are stored hashed (SHA-256) server-side ; the plaintext is shown
  only once at issuance.
- Revocation is immediate — the next POST returns 401.
- The server stamps every row with the resolved `tenant_id` from the
  key. **No cross-tenant write authority possible**, even with a
  compromised key from another tenant.
- Rate-limited at 60 req/min per key (Redis sliding window) plus the
  monthly quota.

## Failure mode runbook

| Symptom | Likely cause | Remediation |
|---|---|---|
| All POSTs return 401 | Key revoked or typo | Re-issue from /settings/api-keys |
| All POSTs return 429 immediately | Monthly quota exhausted | Upgrade tier or wait for month rollover |
| Sporadic 429 | Per-minute rate limit hit | Reduce agent cycle frequency or batch upstream |
| 502/503 transient | CC backend brief restart | Auto-retry; if persistent, check status page |
| Local SQLite has rows but dashboard empty | Sink not receiving events | Verify `VAUBAN_API_KEY` env var, check pod logs |

## Observability of the sink itself

If you wrap with `createTelemetryBus`, inspect counters :

```ts
const bus = createTelemetryBus({ sinks: [commandCenterTelemetrySink({...})] });
// later…
console.log(bus.counters);
// { dispatched: 142, sinkErrors: 0, dropped: 0 }
```

Surface `sinkErrors` / `dropped` to Prometheus for alerting.
