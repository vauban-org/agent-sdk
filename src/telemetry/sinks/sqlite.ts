/**
 * localSqliteTelemetrySink — sovereign local mirror of agent runs.
 *
 * Per ADR-ECO-039 §5 : SQLite sink is ON by default. It is the exit plan for
 * any remote sink (CC SaaS, OTLP backend) — if the network sink is revoked,
 * the local SQLite file retains the full history.
 *
 * Schema (created on first use) :
 *   - `agent_run`  : one row per OODA cycle (start + finish join)
 *   - `agent_run_step` : one row per OODA step
 *
 * Dependency : `better-sqlite3` declared as **peerDependency optional**.
 * If absent, this sink degrades gracefully — logs a warning and no-ops.
 *
 * Ref: command-center:sprint-693:sink-sqlite
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";

import type {
  TelemetryRunFinish,
  TelemetryRunStart,
  TelemetryRunStep,
  TelemetrySink,
} from "../port.js";

/** @public */
export interface LocalSqliteTelemetrySinkOptions {
  /**
   * Database file path. Default `~/.vauban/runs.db`.
   * Pass `:memory:` for ephemeral test mode.
   */
  path?: string;
  /** Synchronous mode (better-sqlite3 default). Tests may override. */
  readonly?: boolean;
}

// ─── better-sqlite3 dynamic type stub ────────────────────────────────────────

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  pragma(sql: string, options?: { simple: boolean }): unknown;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_run (
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
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd      REAL DEFAULT 0,
  total_tool_calls    INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_run_agent_started
  ON agent_run (agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_status
  ON agent_run (status, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_step (
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
  recorded_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_step_run
  ON agent_run_step (run_id, step_index);
`;

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a local SQLite sink. Returns a no-op sink if `better-sqlite3` is not
 * installed — the caller is warned via `console.warn` once.
 * @public
 */
export function localSqliteTelemetrySink(
  opts: LocalSqliteTelemetrySinkOptions = {},
): TelemetrySink {
  const dbPath = resolveDbPath(opts.path);
  const db = openDatabaseSafely(dbPath, opts.readonly ?? false);

  if (!db) {
    return degradedSink(dbPath);
  }

  db.exec(SCHEMA);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const insertRun = db.prepare(`
    INSERT INTO agent_run
      (run_id, agent_id, agent_version, model, provider,
       tenant_id, trace_id, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_id) DO NOTHING
  `);

  const insertStep = db.prepare(`
    INSERT INTO agent_run_step
      (run_id, step_index, kind, status,
       input_tokens, output_tokens, tool_calls, cost_usd,
       duration_ms, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_id, step_index) DO NOTHING
  `);

  const updateFinish = db.prepare(`
    UPDATE agent_run
       SET finished_at = ?,
           status = ?,
           stop_reason = ?,
           error_message = ?,
           total_input_tokens = COALESCE(?, total_input_tokens),
           total_output_tokens = COALESCE(?, total_output_tokens),
           total_cost_usd = COALESCE(?, total_cost_usd),
           total_tool_calls = COALESCE(?, total_tool_calls)
     WHERE run_id = ?
  `);

  return {
    name: "sqlite",

    async start(event: TelemetryRunStart) {
      insertRun.run(
        event.runId,
        event.agentId,
        event.agentVersion,
        event.model ?? null,
        event.provider ?? null,
        event.tenantId ?? null,
        event.traceId ?? null,
        event.startedAt,
      );
    },

    async step(runId: string, delta: TelemetryRunStep) {
      insertStep.run(
        runId,
        delta.stepIndex,
        delta.kind,
        delta.status,
        delta.inputTokens,
        delta.outputTokens,
        delta.toolCalls ?? 0,
        delta.costUsd,
        delta.durationMs ?? null,
        delta.metadata ? JSON.stringify(delta.metadata) : null,
      );
    },

    async finish(runId: string, event: TelemetryRunFinish) {
      updateFinish.run(
        event.finishedAt,
        event.status,
        event.stopReason ?? null,
        event.errorMessage ?? null,
        event.totalInputTokens ?? null,
        event.totalOutputTokens ?? null,
        event.totalCostUsd ?? null,
        event.totalToolCalls ?? null,
        runId,
      );
    },

    async flush() {
      // better-sqlite3 is synchronous — no buffer to flush.
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveDbPath(input?: string): string {
  if (!input) return resolvePath(homedir(), ".vauban", "runs.db");
  if (input === ":memory:") return input;
  // Expand leading ~ manually (Node doesn't do it).
  if (input.startsWith("~/")) {
    return resolvePath(homedir(), input.slice(2));
  }
  return resolvePath(input);
}

let warnedMissing = false;

function openDatabaseSafely(path: string, readonly: boolean): Database | null {
  try {
    // Dynamic require so better-sqlite3 stays optional.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createRequire = require("node:module").createRequire as (
      specifier: string,
    ) => NodeJS.Require;
    const req = createRequire(import.meta.url);
    const BetterSqlite = req("better-sqlite3") as new (
      path: string,
      opts?: { readonly?: boolean },
    ) => Database;

    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    return new BetterSqlite(path, { readonly });
  } catch (err) {
    if (!warnedMissing) {
      warnedMissing = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[telemetry:sqlite] better-sqlite3 not installed — sink degraded to no-op.",
        "Install with: `pnpm add better-sqlite3` (peerDependencyOptional).",
        err instanceof Error ? err.message : "",
      );
    }
    return null;
  }
}

function degradedSink(path: string): TelemetrySink {
  return {
    name: `sqlite:degraded(${path})`,
    async start() {
      /* no-op when better-sqlite3 missing */
    },
    async step() {
      /* no-op */
    },
    async finish() {
      /* no-op */
    },
  };
}
