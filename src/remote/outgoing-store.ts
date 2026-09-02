/**
 * remote/outgoing-store — SQLite-backed durable queue for outgoing relay frames.
 *
 * Purpose
 * -------
 * `sendToGuest()` in `relay-client.ts` is fire-and-forget over a WebSocket.
 * When the socket is closed or the send throws, the frame is silently dropped.
 * `OutgoingMessageStore` persists frames in SQLite so they survive disconnects
 * and are drained in order when the connection is re-established.
 *
 * Design follows `persistence-sqlite.ts` exactly: synchronous better-sqlite3
 * wrapped behind an async API, WAL mode, lazy parent-directory creation.
 *
 * Schema
 * ------
 *   outgoing_messages(
 *     id             INTEGER PRIMARY KEY AUTOINCREMENT,
 *     client_id      TEXT    NOT NULL,
 *     frame          BLOB    NOT NULL,
 *     created_at     INTEGER NOT NULL,
 *     attempts       INTEGER NOT NULL DEFAULT 0,
 *     last_attempt_at INTEGER
 *   )
 *
 * Retry discipline
 * ----------------
 * Each failed send increments `attempts` + sets `last_attempt_at`. After
 * `MAX_ATTEMPTS` (10) the caller should drop the frame — this store does not
 * enforce the drop; the caller decides, then calls `markDelivered` to remove.
 *
 * Concurrency
 * -----------
 * better-sqlite3 is synchronous. The public API returns resolved Promises for
 * interface symmetry and to let callers use `await` safely.
 *
 * @public @since 2.29.0 — T6h durable OutgoingMessageStore for relay sends
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
// Shared with sqlitePathForSession — see the JSDoc on presteHomeDir in
// persistence-sqlite.ts for why the helper lives there instead of in a
// dedicated module.
import { presteHomeDir } from "./persistence-sqlite.js";

// Bare `require` does not exist under real ESM (it only worked under the CJS
// test transform) — same bug class as the attestation-store node:crypto
// incident. Mirror persistence-sqlite.ts's createRequire pattern.
const requireCjs = createRequire(import.meta.url);

/**
 * The shape of `better-sqlite3` we depend on. Declared locally so the
 * SDK does not carry `@types/better-sqlite3` as a hard dep ; consumers
 * that wire the SQLite store already pull both `better-sqlite3` + its types.
 */
interface BetterSqliteStatement<R = unknown> {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): R | undefined;
  all(...params: unknown[]): R[];
}

interface BetterSqliteDatabase {
  exec(sql: string): void;
  prepare<R = unknown>(sql: string): BetterSqliteStatement<R>;
  pragma(name: string, opts?: { simple?: boolean }): unknown;
  close(): void;
}

type BetterSqliteCtor = new (
  path: string,
  opts?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqliteDatabase;

/** Row returned by `dequeueBatch`. */
export interface OutgoingMessageRow {
  id: number;
  clientId: string;
  frame: string;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
}

/** Options for `OutgoingMessageStore`. */
export interface OutgoingMessageStoreOptions {
  /**
   * Absolute path to the SQLite database file. Parent directory is
   * created lazily with `recursive: true`.
   */
  dbPath: string;
}

/**
 * Maximum delivery attempts before the caller should drop a frame.
 * The store tracks attempts; the caller enforces the ceiling.
 */
export const MAX_OUTGOING_ATTEMPTS = 10;

/**
 * Resolve `better-sqlite3` lazily. Mirrors `persistence-sqlite.ts`
 * exactly so both files behave identically when the native dep is absent.
 */
function loadBetterSqlite3(): BetterSqliteCtor {
  try {
    const mod = requireCjs("better-sqlite3") as unknown;
    if (typeof mod === "function") return mod as BetterSqliteCtor;
    const wrapped = (mod as { default?: unknown }).default;
    if (typeof wrapped === "function") return wrapped as BetterSqliteCtor;
    throw new Error("better-sqlite3 default export is not a constructor");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OutgoingMessageStore requires 'better-sqlite3' to be installed as a peerDependency. Install with: npm install better-sqlite3. Underlying error: ${msg}`,
    );
  }
}

/**
 * SQLite-backed durable queue for outgoing relay frames.
 *
 * Constructor takes a file path (e.g. `~/.preste/outgoing.sqlite`).
 * Parent directories are created lazily.
 */
export class OutgoingMessageStore {
  private readonly db: BetterSqliteDatabase;
  private closed = false;

  constructor(opts: OutgoingMessageStoreOptions) {
    if (!opts.dbPath) throw new Error("OutgoingMessageStore: dbPath is required");
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    const Ctor = loadBetterSqlite3();
    this.db = new Ctor(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.bootstrapSchema();
  }

  private bootstrapSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outgoing_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id       TEXT    NOT NULL,
        frame           BLOB    NOT NULL,
        created_at      INTEGER NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outgoing_client
        ON outgoing_messages(client_id, id);
    `);
  }

  /**
   * Persist a frame for the given client. The frame is a serialized
   * string (e.g. JSON-encoded + sealed payload).
   */
  enqueue(clientId: string, frame: string): void {
    if (this.closed) throw new Error("OutgoingMessageStore: closed");
    this.db
      .prepare(
        `INSERT INTO outgoing_messages(client_id, frame, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(clientId, frame, Date.now());
  }

  /**
   * Return up to `limit` pending messages for a client, ordered by id
   * (oldest first). Does NOT remove them — the caller must call
   * `markDelivered` or `markFailed` after each attempt.
   */
  dequeueBatch(clientId: string, limit: number): OutgoingMessageRow[] {
    if (this.closed) throw new Error("OutgoingMessageStore: closed");
    const rows = this.db
      .prepare<{
        id: number;
        client_id: string;
        frame: string;
        created_at: number;
        attempts: number;
        last_attempt_at: number | null;
      }>(
        `SELECT id, client_id, frame, created_at, attempts, last_attempt_at
         FROM outgoing_messages
         WHERE client_id = ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(clientId, limit);
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      frame: r.frame,
      createdAt: r.created_at,
      attempts: r.attempts,
      lastAttemptAt: r.last_attempt_at,
    }));
  }

  /**
   * Remove a successfully delivered message from the queue.
   */
  markDelivered(id: number): void {
    if (this.closed) throw new Error("OutgoingMessageStore: closed");
    this.db.prepare("DELETE FROM outgoing_messages WHERE id = ?").run(id);
  }

  /**
   * Increment the attempt counter and record the timestamp of the
   * failed attempt. The message stays in the queue for the next drain.
   */
  markFailed(id: number): void {
    if (this.closed) throw new Error("OutgoingMessageStore: closed");
    this.db
      .prepare(
        `UPDATE outgoing_messages
         SET attempts = attempts + 1, last_attempt_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /**
   * Return the number of pending messages for a client.
   */
  pendingCount(clientId: string): number {
    if (this.closed) throw new Error("OutgoingMessageStore: closed");
    const row = this.db
      .prepare<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM outgoing_messages WHERE client_id = ?")
      .get(clientId);
    return row?.n ?? 0;
  }

  /** Close the underlying SQLite handle. Idempotent. */
  close(): void {
    if (this.closed) return;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* best-effort */
    }
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
    this.closed = true;
  }

  /** Test helper — true after close() was called. */
  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Compute the canonical outgoing-queue DB path under
 * `${baseDir ?? PRESTE_HOME ?? ~/.preste}/outgoing.sqlite`.
 *
 * The default (`PRESTE_HOME` env var, else `~/.preste`) is the `preste`
 * CLI's own filesystem convention, not an SDK-owned one. Non-preste
 * consumers of the published SDK MUST pass `baseDir` (or use a full path
 * of their own) — otherwise the queue file silently lands under
 * `~/.preste`.
 *
 * @param baseDir — overrides the default root entirely when provided.
 */
export function outgoingStorePath(baseDir?: string): string {
  const home = presteHomeDir(baseDir);
  return `${home}/outgoing.sqlite`;
}
