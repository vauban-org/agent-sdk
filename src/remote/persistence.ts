/**
 * remote/persistence — durable backing store for the remote-control hub.
 *
 * Purpose
 * -------
 * Without persistence, restarting `preste --remote` resets the in-memory
 * `revokedJtis` deny-list — sub-tokens that an operator explicitly revoked
 * before their TTL elapsed would silently become valid again. That is a
 * direct token-replay attack vector on any downstream verifier (Bastion,
 * Forge, Vauban Finance) that consumed the share.
 *
 * The `PersistencePort` is the SDK-side, transport-agnostic abstraction.
 * The hub + the HTTP server take it as an option ; when provided, every
 * revocation is durably written and every restart re-loads the deny-list.
 *
 * Events are also persisted (append-only, keyed by `seq`). The hub still
 * keeps a bounded in-memory ring buffer for live backlog ; persistence is
 * for crash recovery and offline audit, not for replay scaling.
 *
 * Implementations
 * ---------------
 *   - {@link InMemoryPersistencePort} — keeps the existing zero-config
 *     behavior, useful for tests and pure-loopback dev. Resets on process
 *     exit (no durability).
 *   - `SqlitePersistencePort` lives in `@vauban-org/preste` (CLI) because
 *     the SDK should stay free of `better-sqlite3` (a native addon). The
 *     CLI wires it at `--remote` boot when a writable home is available.
 *
 * Concurrency
 * -----------
 * All methods are async. Implementations MAY batch writes internally but
 * MUST surface failures via the returned promise. The hub calls
 * `saveEvent` fire-and-forget (errors are logged, never thrown into the
 * agent loop). The server calls `saveRevocation` with `await` — a write
 * failure on revoke is surfaced to the operator as a 5xx.
 *
 * @public @since 2.21.0 — preste remote-control P7
 */

import type { SessionEvent } from "./events.js";

/**
 * Durable backing store for remote-control state. Transport-agnostic ;
 * concrete impls map this to in-memory state, SQLite, Postgres, etc.
 * @public
 */
export interface PersistencePort {
  /**
   * Append a SessionEvent. Idempotent on `(seq, id)` — re-saving an event
   * with the same identity is a no-op. Throws on storage failure.
   */
  saveEvent(event: SessionEvent): Promise<void>;

  /**
   * Load events with `seq > sinceSeq` (or all events when omitted),
   * ordered by `seq` ascending. Used at hub construction to warm the
   * live backlog after a restart.
   */
  loadEvents(sinceSeq?: number): Promise<SessionEvent[]>;

  /**
   * Highest `seq` ever persisted ; 0 when the store is empty. Used to
   * align the next emitted event's `seq` after a crash.
   */
  getMaxSeq(): Promise<number>;

  /**
   * Mark a sub-token jti as revoked. Idempotent — re-revoking is a
   * no-op. Survives process restart on durable impls.
   */
  saveRevocation(jti: string): Promise<void>;

  /**
   * Load every currently-revoked jti. Called once at server boot to
   * re-hydrate the in-memory deny-list.
   */
  loadRevocations(): Promise<string[]>;

  /**
   * Erase everything. For tests and operator-driven manual wipe.
   */
  clearAll(): Promise<void>;

  /**
   * Release underlying resources (DB handle, file lock, etc.). Called
   * on graceful shutdown ; safe to call multiple times.
   */
  close(): Promise<void>;
}

/**
 * Zero-config in-memory implementation. Identical durability profile to
 * the pre-P7 hub : everything vanishes on process exit. Useful for tests
 * and pure-loopback dev where revocation persistence is not required.
 * @public
 */
export class InMemoryPersistencePort implements PersistencePort {
  private readonly events = new Map<number, SessionEvent>();
  private readonly revoked = new Set<string>();
  private maxSeq = 0;
  private closed = false;

  async saveEvent(event: SessionEvent): Promise<void> {
    if (this.closed) throw new Error("PersistencePort: closed");
    // Idempotent on seq — repeated saves of the same event are silent.
    this.events.set(event.seq, event);
    if (event.seq > this.maxSeq) this.maxSeq = event.seq;
  }

  async loadEvents(sinceSeq?: number): Promise<SessionEvent[]> {
    if (this.closed) throw new Error("PersistencePort: closed");
    const cutoff = sinceSeq ?? -1;
    const out: SessionEvent[] = [];
    for (const [seq, event] of this.events) {
      if (seq > cutoff) out.push(event);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async getMaxSeq(): Promise<number> {
    if (this.closed) throw new Error("PersistencePort: closed");
    return this.maxSeq;
  }

  async saveRevocation(jti: string): Promise<void> {
    if (this.closed) throw new Error("PersistencePort: closed");
    this.revoked.add(jti);
  }

  async loadRevocations(): Promise<string[]> {
    if (this.closed) throw new Error("PersistencePort: closed");
    return Array.from(this.revoked);
  }

  async clearAll(): Promise<void> {
    if (this.closed) throw new Error("PersistencePort: closed");
    this.events.clear();
    this.revoked.clear();
    this.maxSeq = 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.clear();
    this.revoked.clear();
  }

  /** Test helper — true after close() was called. */
  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Best-effort persistence wrapper for fire-and-forget callers (the hub).
 * Logs failures to console.warn but never throws — a broken disk must not
 * crash the agent loop.
 * @public
 */
export async function tryPersistEvent(
  persistence: PersistencePort | undefined,
  event: SessionEvent,
): Promise<void> {
  if (!persistence) return;
  try {
    await persistence.saveEvent(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[remote/persistence] saveEvent failed (seq=${event.seq}): ${msg}`);
  }
}
