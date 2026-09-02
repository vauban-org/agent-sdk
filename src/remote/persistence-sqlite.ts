/**
 * remote/persistence-sqlite — SQLite-backed PersistencePort for the
 * remote-control hub.
 *
 * Purpose
 * -------
 * The pre-P7 hub kept the revocation deny-list in a `Set<string>` that
 * vanished on process exit. An operator who revoked a sub-token before
 * its TTL elapsed saw it silently re-validate after a restart ; that is a
 * direct token-replay attack vector on every downstream verifier
 * (Bastion, Forge, Vauban Finance) that consumed the share.
 *
 * `SqlitePersistencePort` is the SDK's default durable backing store. It
 * is the impl the `preste --remote` CLI attaches by default at boot ; it
 * is also the canonical reference for any SDK consumer that wants to
 * preserve revocations + the event log across restarts.
 *
 * Native dependency caveat
 * ------------------------
 * `better-sqlite3` is a native node addon (V8 bindings). The SDK declares
 * it as an OPTIONAL peerDependency : consumers that need durable
 * persistence install `better-sqlite3` themselves ; consumers that run
 * on edge/browser runtimes skip it and use `InMemoryPersistencePort` (or
 * their own port impl). The dynamic `import()` below means this module
 * is loadable in environments where `better-sqlite3` is absent — only
 * the constructor throws when the dep is missing.
 *
 * Schema
 * ------
 *   revocations  (jti TEXT PK, revoked_at INTEGER NOT NULL)
 *   events       (seq INTEGER PK, id TEXT, ts TEXT, type TEXT, payload TEXT)
 *
 * `revoked_at` is a unix-ms integer (per task spec) ; the event
 * `payload` is a JSON blob carrying the full SessionEvent envelope.
 * `INSERT OR IGNORE` makes both inserts idempotent — re-saving an event
 * after a `loadHubFromPersistence` warm-up is a silent no-op.
 *
 * Concurrency
 * -----------
 * `better-sqlite3` is synchronous. The PersistencePort interface is
 * async ; calls return resolved Promises around the sync underlying
 * operations. Concurrent `saveRevocation` calls do not deadlock — each
 * prepared statement run is atomic at the SQLite layer (single writer,
 * WAL mode).
 *
 * Crash safety
 * ------------
 * `journal_mode = WAL` + `synchronous = NORMAL`. WAL fsyncs at
 * checkpoint boundaries (every ~1s under load) rather than per write,
 * accepting a small window of potential loss for a large throughput
 * win. `close()` forces a final `wal_checkpoint(TRUNCATE)` so subsequent
 * opens see all committed data without re-playing the WAL.
 *
 * @public @since 2.29.0 — preste remote-control P7 SHIPPED default
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { SessionEvent } from "./events.js";
import type { PersistencePort } from "./persistence.js";

/**
 * This package ships `"type": "module"` ; under the real Node ESM loader
 * `require` is not a global, so a bare `require("better-sqlite3")` throws
 * `ReferenceError: require is not defined` even when the dependency IS
 * installed (vitest's transform shims `require` and masks this ; the real
 * `preste` CLI binary does not). `createRequire` mints a CJS-style require
 * bound to this file's URL, resolving `better-sqlite3` exactly like Node's
 * native `require` would. Same fix as `attestation-store.ts`'s
 * `privHex/pubHexToKeyObject`.
 */
const requireCjs = createRequire(import.meta.url);

/**
 * The shape of `better-sqlite3` we depend on. Declared locally so the
 * SDK does not carry `@types/better-sqlite3` as a hard dep ; consumers
 * that wire the SQLite port already pull both `better-sqlite3` + its
 * types.
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

/**
 * Options for opening the SQLite persistence store.
 * @public
 */
export interface SqlitePersistenceOptions {
  /**
   * Absolute path to the SQLite database file. Parent directory is
   * created lazily with `recursive: true`.
   */
  dbPath: string;
  /**
   * When true, opens the DB in read-only mode — used by audit tools
   * that never write. Defaults to false.
   */
  readOnly?: boolean;
}

/**
 * Resolve `better-sqlite3` lazily. Throws a clear error when the
 * native dep is missing so a consumer who forgot to install it sees a
 * useful message instead of a cryptic `MODULE_NOT_FOUND`.
 */
function loadBetterSqlite3(): BetterSqliteCtor {
  // The require is deferred so the module loads cleanly in environments
  // where better-sqlite3 is absent (edge runtimes, browser bundles that
  // tree-shake the remote module).
  try {
    const mod = requireCjs("better-sqlite3") as unknown;
    if (typeof mod === "function") return mod as BetterSqliteCtor;
    const wrapped = (mod as { default?: unknown }).default;
    if (typeof wrapped === "function") return wrapped as BetterSqliteCtor;
    throw new Error("better-sqlite3 default export is not a constructor");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SqlitePersistencePort requires 'better-sqlite3' to be installed as a peerDependency. Install with: npm install better-sqlite3. Underlying error: ${msg}`,
    );
  }
}

/**
 * SQLite-backed implementation of `PersistencePort`. Durable across
 * process restarts ; ships as the default for `preste --remote`.
 *
 * Constructor takes a file path (e.g. `~/.preste/remote/<sessionId>.db`).
 * Parent directories are created lazily.
 * @public
 */
export class SqlitePersistencePort implements PersistencePort {
  private readonly db: BetterSqliteDatabase;
  private readonly readOnly: boolean;
  private closed = false;

  constructor(opts: SqlitePersistenceOptions) {
    if (!opts.dbPath) throw new Error("SqlitePersistencePort: dbPath is required");
    this.readOnly = opts.readOnly === true;
    if (!this.readOnly) {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    const Ctor = loadBetterSqlite3();
    this.db = new Ctor(opts.dbPath, { readonly: this.readOnly });
    if (!this.readOnly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.bootstrapSchema();
    }
  }

  private bootstrapSchema(): void {
    // Schema follows the task spec : revocations + events with a JSON
    // payload blob. We keep an `id`/`ts`/`type` projection alongside
    // the JSON for cheap audit queries without paying a full JSON
    // parse per row.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revocations (
        jti        TEXT PRIMARY KEY,
        revoked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq     INTEGER PRIMARY KEY,
        id      TEXT NOT NULL,
        ts      TEXT NOT NULL,
        type    TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    `);
  }

  async saveEvent(event: SessionEvent): Promise<void> {
    if (this.closed) throw new Error("SqlitePersistencePort: closed");
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO events(seq, id, ts, type, payload)
       VALUES (@seq, @id, @ts, @type, @payload)`,
    );
    stmt.run({
      seq: event.seq,
      id: event.id,
      ts: event.ts,
      type: event.type,
      payload: JSON.stringify(event),
    });
  }

  async loadEvents(sinceSeq?: number): Promise<SessionEvent[]> {
    if (this.closed) throw new Error("SqlitePersistencePort: closed");
    const cutoff = sinceSeq ?? -1;
    const rows = this.db
      .prepare<{ payload: string }>("SELECT payload FROM events WHERE seq > ? ORDER BY seq ASC")
      .all(cutoff);
    return rows.map((r) => JSON.parse(r.payload) as SessionEvent);
  }

  async getMaxSeq(): Promise<number> {
    if (this.closed) throw new Error("SqlitePersistencePort: closed");
    const row = this.db.prepare<{ max: number | null }>("SELECT MAX(seq) AS max FROM events").get();
    return row?.max ?? 0;
  }

  async saveRevocation(jti: string): Promise<void> {
    if (this.closed) throw new Error("SqlitePersistencePort: closed");
    if (!jti) throw new Error("SqlitePersistencePort: empty jti");
    this.db
      .prepare("INSERT OR IGNORE INTO revocations(jti, revoked_at) VALUES (?, ?)")
      .run(jti, Date.now());
  }

  async loadRevocations(): Promise<string[]> {
    if (this.closed) throw new Error("SqlitePersistencePort: closed");
    const rows = this.db.prepare<{ jti: string }>("SELECT jti FROM revocations").all();
    return rows.map((r) => r.jti);
  }

  async clearAll(): Promise<void> {
    if (this.closed) throw new Error("SqlitePersistencePort: closed");
    if (this.readOnly) throw new Error("SqlitePersistencePort: read-only mode");
    this.db.exec("DELETE FROM events; DELETE FROM revocations;");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      // Force a WAL checkpoint before closing so subsequent opens see
      // all committed data without needing to re-play the WAL.
      if (!this.readOnly) this.db.pragma("wal_checkpoint(TRUNCATE)");
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
 * Resolve the base directory for remote-module durable files (session DBs,
 * the outgoing relay queue).
 *
 * Precedence: explicit `baseDir` argument > `PRESTE_HOME` env var >
 * `${HOME}/.preste` (the `preste` CLI's own filesystem convention, not an
 * SDK-owned one).
 *
 * Single source of truth for `sqlitePathForSession` (below) and
 * `outgoingStorePath` (`./outgoing-store.js`, which imports this instead
 * of duplicating the fallback logic). Defined here rather than in a
 * dedicated module: this file is covered by an ESM regression test
 * (`tests/remote/persistence-sqlite.test.ts`, "real Node ESM require
 * regression") that runs the raw `.ts` source through
 * `node --experimental-strip-types` — that loader does not map `.js`
 * specifiers to sibling `.ts` files, so a new cross-file relative import
 * here would fail under that probe even though it works fine once built.
 * Keeping the helper local to this file (already the natural owner —
 * `outgoing-store.ts`'s own docstring says its design "follows
 * persistence-sqlite.ts exactly") avoids introducing that new import.
 */
export function presteHomeDir(baseDir?: string): string {
  return baseDir ?? process.env.PRESTE_HOME ?? `${process.env.HOME}/.preste`;
}

/**
 * Compute the canonical DB path for a session under
 * `${baseDir ?? PRESTE_HOME ?? ~/.preste}/remote/<sessionId>.db`.
 *
 * The default (`PRESTE_HOME` env var, else `~/.preste`) is the `preste`
 * CLI's own filesystem convention, not an SDK-owned one. Non-preste
 * consumers of the published SDK MUST pass `baseDir` (or use a full path
 * of their own) — otherwise session DBs silently land under `~/.preste`.
 *
 * @param baseDir — overrides the default root entirely when provided.
 * @public
 */
export function sqlitePathForSession(sessionId: string, baseDir?: string): string {
  const home = presteHomeDir(baseDir);
  return `${home}/remote/${sessionId}.db`;
}
