---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# `localSqliteTelemetrySink`

**Sovereign local mirror** of every agent run. Per
[ADR-ECO-039 §5](https://github.com/vauban-org/vauban-gouvernance/blob/main/governance/decisions/ADR-ECO-039-sdk-telemetry-port.md),
this sink is **ON by default** when you compose with `createTelemetryBus` —
it is the *exit plan* for any remote sink.

## Why a local mirror, always ?

If `command.vauban.tech` goes down, if your OTLP collector is unreachable,
if a network partition cuts the link to your observability stack — the
local SQLite file retains the full history. No data loss. No vendor lock-in.

## Usage

```ts
import { localSqliteTelemetrySink } from "@vauban-org/agent-sdk";

localSqliteTelemetrySink({
  path?: string;        // default: ~/.vauban/runs.db
  readonly?: boolean;   // default: false
});
```

### Inspect via standard tools

```bash
sqlite3 ~/.vauban/runs.db
sqlite> .tables
agent_run         agent_run_step
sqlite> SELECT agent_id, status, COUNT(*) FROM agent_run GROUP BY agent_id, status;
```

The upcoming `vauban-agent runs list` CLI wraps this with a nicer UI.

## Schema

The sink auto-creates two tables on first use :

```sql
CREATE TABLE agent_run (
  run_id            TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  agent_version     TEXT NOT NULL,
  model             TEXT,
  provider          TEXT,
  tenant_id         TEXT,
  trace_id          TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT,
  stop_reason       TEXT,
  error_message     TEXT,
  total_input_tokens   INTEGER DEFAULT 0,
  total_output_tokens  INTEGER DEFAULT 0,
  total_cost_usd       REAL DEFAULT 0,
  total_tool_calls     INTEGER DEFAULT 0
);

CREATE TABLE agent_run_step (
  run_id        TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  tool_calls    INTEGER DEFAULT 0,
  cost_usd      REAL DEFAULT 0,
  duration_ms   INTEGER,
  metadata      TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (run_id, step_index)
);
```

Plus indices on `(agent_id, started_at DESC)` and `(status, started_at DESC)`.

## Optional dependency

`better-sqlite3` is declared as **peerDependencyOptional**. Install :

```bash
pnpm add better-sqlite3
```

If absent, the sink **degrades to no-op** and logs one warning at startup
("better-sqlite3 not installed — sink degraded to no-op"). Your agent
continues without local persistence. This is intentional — SDK consumers
who only want the OTLP or CC sink shouldn't be forced to compile a native
addon.

## Disk footprint

| Metric | Value |
|---|---|
| Per agent_run row | ~250 bytes |
| Per agent_run_step row | ~150 bytes |
| 100 000 runs × 5 steps each | ≈ 100 MB |
| WAL journal during writes | ≤ 10 MB |

Append-only. No cleanup required for normal usage. For aggressive retention,
manual DELETE WHERE `started_at < date('now', '-7 days')` works.

## Tests

The unit test suite skips SQLite-specific assertions if `better-sqlite3`
is not installed in the test environment, so CI passes both with and
without the addon.

## Failure modes

- **Disk full** : the next `start` throws a `SQLITE_FULL` error, isolated
  by the bus. The agent continues.
- **WAL corruption** : never observed in the field. Recovery is to
  delete the `.db-wal` + `.db-shm` files and re-open ; the main DB file
  is rebuilt from the checkpoint.
- **Concurrent access from multiple agents** : safe — WAL mode (set by
  the sink via `journal_mode = WAL`) supports concurrent readers + one
  writer per file.

## Migration to remote sinks

The local SQLite is the audit trail. Once your remote sink is wired up
and stable, the local file is **archival** — keep it around as the
sovereign backup. Some teams sync it nightly to S3 or Backblaze B2 as
a tier-2 archive.
