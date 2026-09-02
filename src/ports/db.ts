/**
 * DbPort — re-export of the existing minimal DbClient shape from
 * tracking/agent-run-tracker. Alias DbPort is the port-suffixed name
 * used across other ports; DbClient remains exported for back-compat.
 *
 * OTel instrumentation: import { createTracedDbPort } to wrap any
 * DbPort implementation with OpenTelemetry spans per query.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { DbClient } from "../tracking/agent-run-tracker.js";

const PORT_TRACER = trace.getTracer("vauban-agent-sdk.ports", "0.1.0");

export type { DbClient as DbPort } from "../tracking/agent-run-tracker.js";
export type { DbClient } from "../tracking/agent-run-tracker.js";

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when the database connection is lost (ECONNREFUSED, pool exhausted,
 * or TLS handshake failed). Callers should retry with exponential backoff
 * once the connection pool is re-established.
 * @public
 */
export class DbConnectionLostError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DbConnectionLostError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a database query exceeds the configured statement_timeout or
 * the caller-supplied timeoutMs. The query may have been cancelled by the
 * server — retrying the same query without changes is unlikely to succeed.
 * @public
 */
export class DbQueryTimeoutError extends Error {
  /** The SQL statement that timed out (truncated for logging). */
  readonly queryPreview: string;
  /** Timeout that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(
    message: string,
    queryPreview: string,
    timeoutMs: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DbQueryTimeoutError";
    this.queryPreview = queryPreview;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Wrap any DbPort implementation with OTel spans per query() call.
 * The span captures the SQL preview (first 200 chars) and params count.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 *
 * Usage:
 *   const raw: DbPort = pgPool;
 *   const traced = createTracedDbPort(raw);
 *   const { rows } = await traced.query("SELECT ...") // emits "db.query" span
 */
export function createTracedDbPort(impl: DbClient): DbClient {
  return {
    async query<T extends object>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount?: number | undefined }> {
      return PORT_TRACER.startActiveSpan(
        "db.query",
        {
          attributes: {
            "db.sql_preview": sql.slice(0, 200),
            "db.params_count": params?.length ?? 0,
            "vauban.port.name": "db",
          },
        },
        async (span: Span) => {
          try {
            const result = await impl.query<T>(sql, params);
            span.setAttributes({
              "db.row_count": result.rowCount ?? result.rows.length,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            if (err instanceof Error) span.recordException(err);
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },
  };
}
