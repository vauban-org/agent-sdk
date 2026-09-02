/**
 * nonce-store — Replay attack prevention via nonce deduplication.
 *
 * NonceStore tracks seen idempotencyKeys within a TTL window to prevent
 * replay attacks. The Redis implementation uses SET NX PX for atomic ops.
 * The InMemory implementation is for testing only.
 *
 * ADR-ECO-017: nonce dedup via Redis SETNX TTL 10 min (auth side).
 *
 * @module auth/nonce-store
 * @public
 */

export interface NonceStore {
  /**
   * Atomically sets the key if it does not exist.
   *
   * @param key   - Nonce/idempotencyKey to register.
   * @param ttlMs - Time-to-live in milliseconds.
   * @returns true if the key was newly set (first occurrence), false if already exists (replay).
   */
  setNX(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * In-memory NonceStore for unit tests.
 * NOT for production — no persistence, no distributed dedup.
 * @public
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly store = new Map<string, number>();

  async setNX(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // Evict expired entries on each call (bounded cleanup)
    for (const [k, expiry] of this.store.entries()) {
      if (expiry <= now) this.store.delete(k);
    }

    if (this.store.has(key)) {
      return false; // duplicate
    }
    this.store.set(key, now + ttlMs);
    return true;
  }

  /** Test helper: clear all state. */
  reset(): void {
    this.store.clear();
  }
}

/**
 * Minimal Redis client interface required by RedisNonceStore.
 * Compatible with ioredis and node-redis clients.
 * @public
 */
export interface RedisClientLike {
  set(key: string, value: string, options: { nx: true; px: number }): Promise<string | null>;
}

/**
 * Redis-backed NonceStore for production.
 * Uses SET key value NX PX ttlMs — atomic, no race condition.
 * @public
 */
export class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: RedisClientLike) {}

  async setNX(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(`vauban:nonce:${key}`, "1", {
      nx: true,
      px: ttlMs,
    });
    // SET NX returns "OK" on success, null if key already exists
    return result !== null;
  }
}
