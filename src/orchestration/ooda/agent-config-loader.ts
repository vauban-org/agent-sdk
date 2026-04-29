/**
 * AgentConfigLoader — hot-reload config cache for OODA agents.
 *
 * Reads per-agent runtime configuration from the `agent_config` table with an
 * in-memory TTL cache (default 30s). Each OODA cycle calls `get(agentId)` at
 * the start; after the TTL expires the next call transparently re-fetches from
 * the DB. No restart required for config changes.
 *
 * Column strategy:
 *   - `config` (new schema) — preferred when present.
 *   - `extra` (sprint-472 legacy) — backward-compat fallback.
 *
 * The `columnName` option allows the host to pin the column explicitly.
 *
 * @public
 */

import type { DbClient } from "../../tracking/agent-run-tracker.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Minimal contract for a hot-reload config cache.
 *
 * @typeParam T - Shape of the agent configuration object.
 */
export interface AgentConfigLoader<T = Record<string, unknown>> {
  /**
   * Return config for `agentId`. Serves from cache when within TTL;
   * otherwise fetches from `agent_config` table and refreshes the cache.
   *
   * If no row exists for `agentId`, returns `defaultConfig` (or `{}` if
   * none was provided).
   */
  get(agentId: string): Promise<T>;

  /**
   * Evict `agentId` from the cache. The next `get` call will re-fetch
   * from the database regardless of TTL.
   */
  invalidate(agentId: string): void;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  config: T;
  expiresAt: number; // ms since epoch
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a hot-reload config loader backed by the `agent_config` table.
 *
 * @example
 * ```typescript
 * const loader = createAgentConfigLoader<MyConfig>({
 *   db,
 *   ttlMs: 30_000,
 *   defaultConfig: { kelly_cap: 0.2, conviction_min: 0.6 },
 * });
 *
 * // At cycle start:
 * const cfg = await loader.get(agentId);
 * ```
 */
export function createAgentConfigLoader<T = Record<string, unknown>>(opts: {
  /** Postgres-compatible DB client (pg.Pool, pg.Client, or test mock). */
  db: DbClient;
  /** Cache TTL in milliseconds. Default: 30 000 (30s). */
  ttlMs?: number;
  /** Returned when no row exists for the requested agentId. */
  defaultConfig?: T;
  /**
   * Which JSONB column to read from `agent_config`.
   * - `'extra'` — sprint-472 legacy column (default when omitted).
   * - `'config'` — new column (set if schema was migrated to add it).
   */
  columnName?: "config" | "extra";
}): AgentConfigLoader<T> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const defaultConfig = (opts.defaultConfig ?? {}) as T;
  const column = opts.columnName ?? "extra";
  const cache = new Map<string, CacheEntry<T>>();

  async function fetch(agentId: string): Promise<T> {
    const result = await opts.db.query<Record<string, unknown>>(
      `SELECT ${column} AS cfg FROM agent_config WHERE agent_id = $1`,
      [agentId],
    );
    if (!result.rows.length) {
      return defaultConfig;
    }
    const raw = result.rows[0].cfg;
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return defaultConfig;
    }
    return raw as T;
  }

  return {
    async get(agentId: string): Promise<T> {
      const now = Date.now();
      const entry = cache.get(agentId);
      if (entry !== undefined && entry.expiresAt > now) {
        return entry.config;
      }
      const config = await fetch(agentId);
      cache.set(agentId, { config, expiresAt: now + ttlMs });
      return config;
    },

    invalidate(agentId: string): void {
      cache.delete(agentId);
    },
  };
}
