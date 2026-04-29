/**
 * redis-circuit-breaker — Redis-backed OODA RiskGuard.
 *
 * V5 anti-pattern #4 fix: resetVia is EXPLICIT ('cron-rth' | 'admin-endpoint' |
 * 'never') — NOT TTL-based blind expiry. A tripped circuit stays tripped until
 * an explicit reset action fires (cron job at RTH open, admin endpoint call, or
 * never — for manual-only recovery).
 *
 * Redis key: `cb:<name>:tripped` = "1" when tripped, absent when clear.
 *
 * Decoupled from src/router/circuit-breaker.ts — the agent SDK must not import
 * from the CC server layer. This is a standalone, minimal implementation.
 *
 * @public
 */

import type { RiskGuard, OODAContext } from "../types.js";

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * How the circuit breaker is reset after being tripped.
 *
 * - `cron-rth`       : reset by a cron job aligned with RTH session open
 *                      (e.g. 09:30 ET Mon-Fri — implemented externally).
 * - `admin-endpoint` : reset only via an explicit admin API call.
 * - `never`          : manual Redis delete only — no automated reset.
 *
 * Anti-pattern #4: NO TTL-based blind reset. The key never expires on its own.
 */
export type CircuitBreakerResetMode =
  | "cron-rth"
  | "admin-endpoint"
  | "never";

export interface RedisCircuitBreakerOptions {
  /** Unique name per agent+rule — becomes the Redis key segment. */
  name: string;
  /**
   * Redis URL. Defaults to `process.env.REDIS_URL`.
   * Inject a custom client factory via `redisClientFactory` for tests.
   */
  redisUrl?: string;
  /**
   * Number of consecutive failures before the circuit trips.
   * Not auto-tripped by the guard itself (tripping is done by callers via
   * `tripCircuitBreaker`). This field is informational / for external
   * monitoring tooling.
   */
  failureThreshold: number;
  /**
   * V5 anti-pattern #4: explicit reset mode — NOT TTL aveugle.
   * Included in the `reason` string for observability.
   */
  resetVia: CircuitBreakerResetMode;
  /**
   * Optional Redis client factory — inject for unit tests.
   * Factory receives the resolved Redis URL and returns a minimal client.
   *
   * @internal
   */
  _redisClientFactory?: (url: string) => MinimalRedisClient;
}

/**
 * Minimal Redis client interface — satisfied by ioredis and Map-based mocks.
 */
export interface MinimalRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

// ─── Guard factory ────────────────────────────────────────────────────────

/**
 * Returns a RiskGuard that blocks the OODA cycle when the named circuit
 * breaker is tripped in Redis.
 *
 * The guard itself is read-only — it never trips or resets the breaker.
 * Use `tripCircuitBreaker` / `resetCircuitBreaker` from external code
 * (failure handlers, admin endpoints, cron jobs).
 */
export function redisCircuitBreaker(
  opts: RedisCircuitBreakerOptions,
): RiskGuard {
  const redisKey = `cb:${opts.name}:tripped`;

  return {
    name: `redis-cb:${opts.name}`,

    async check(_ctx: OODAContext): Promise<{ proceed: boolean; reason?: string }> {
      const url = opts.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";
      const client = opts._redisClientFactory
        ? opts._redisClientFactory(url)
        : await createIoRedisClient(url);

      try {
        const val = await client.get(redisKey);
        if (val === "1") {
          return {
            proceed: false,
            reason: `Circuit breaker '${opts.name}' tripped (resetVia=${opts.resetVia})`,
          };
        }
        return { proceed: true };
      } finally {
        await client.quit().catch(() => undefined);
      }
    },
  };
}

// ─── Trip / reset helpers ─────────────────────────────────────────────────

/**
 * Trip the named circuit breaker in Redis.
 * The key has NO expiry — reset is always explicit (anti-pattern #4).
 */
export async function tripCircuitBreaker(
  redisUrl: string,
  name: string,
  redisClientFactory?: (url: string) => MinimalRedisClient,
): Promise<void> {
  const client = redisClientFactory
    ? redisClientFactory(redisUrl)
    : await createIoRedisClient(redisUrl);

  try {
    await client.set(`cb:${name}:tripped`, "1");
  } finally {
    await client.quit().catch(() => undefined);
  }
}

/**
 * Reset the named circuit breaker in Redis (remove the trip key).
 * Called by cron-rth jobs, admin endpoints, or manual ops.
 */
export async function resetCircuitBreaker(
  redisUrl: string,
  name: string,
  redisClientFactory?: (url: string) => MinimalRedisClient,
): Promise<void> {
  const client = redisClientFactory
    ? redisClientFactory(redisUrl)
    : await createIoRedisClient(redisUrl);

  try {
    await client.del(`cb:${name}:tripped`);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

// ─── ioredis client factory ───────────────────────────────────────────────

async function createIoRedisClient(url: string): Promise<MinimalRedisClient> {
  // Dynamic import keeps ioredis as a peer dep — tests can inject a mock factory
  // without pulling the full ioredis module.
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(url, {
    // Fail-fast: if Redis is unreachable, throw immediately rather than queuing.
    enableOfflineQueue: false,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await client.connect();
  return client;
}
