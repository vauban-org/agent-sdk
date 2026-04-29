/**
 * Idempotency cache — dedupe duplicate calls by a caller-supplied key.
 *
 * Sprint-468. Wrap an async operation so repeated calls with the same
 * key return the cached result without re-invoking the operation.
 * Essential for retry-safe writes (BrainPort.archiveKnowledge on
 * retryable failures).
 *
 * Defaults to an in-memory LRU with 1024 entries / 5 min TTL. Production
 * hosts with multi-process topology should inject a shared
 * implementation (e.g. Redis-backed) via the `cache` option.
 *
 * Usage:
 *   const safe = idempotent(brain.archiveKnowledge.bind(brain), {
 *     keyFor: (entry) => sha256(entry.content + entry.author),
 *     ttlMs: 60_000,
 *   });
 */

import { createHash } from "node:crypto";

export interface IdempotencyCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
}

/**
 * Simple bounded TTL cache. In-memory only; single-process.
 * Eviction: oldest entry first when `maxEntries` is exceeded, and
 * entries past `ttlMs` are skipped on read.
 */
export class BoundedTtlCache<T> implements IdempotencyCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}

export interface IdempotentOptions<TArgs extends unknown[], TResult> {
  /** Derive a stable cache key from the call arguments. */
  keyFor: (...args: TArgs) => string;
  /** Optional cache implementation (defaults to BoundedTtlCache). */
  cache?: IdempotencyCache<TResult>;
  /** Default cache: entries count cap. Default 1024. */
  maxEntries?: number;
  /** Default cache: entry TTL in ms. Default 5 minutes. */
  ttlMs?: number;
}

/**
 * Wrap an async function so identical keyed calls share the same
 * result. Failures are NOT cached — a failed call is retryable.
 */
export function idempotent<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: IdempotentOptions<TArgs, TResult>,
): (...args: TArgs) => Promise<TResult> {
  const cache =
    options.cache ??
    new BoundedTtlCache<TResult>(
      options.maxEntries ?? 1024,
      options.ttlMs ?? 5 * 60_000,
    );

  return async (...args: TArgs): Promise<TResult> => {
    const key = options.keyFor(...args);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const result = await fn(...args);
    cache.set(key, result);
    return result;
  };
}

/**
 * Convenience: hash the JSON-serialisable arguments as the cache key.
 * Useful when the args already fully determine the operation (e.g.
 * BrainPort.archiveKnowledge takes a single entry object).
 */
export function hashKey(...parts: unknown[]): string {
  const h = createHash("sha256");
  for (const part of parts) {
    let serialised: string;
    if (typeof part === "string") serialised = part;
    else if (part === undefined) serialised = "__undefined__";
    else serialised = JSON.stringify(part) ?? "__unserialisable__";
    h.update(serialised);
    h.update("\x1f"); // unit-separator
  }
  return h.digest("hex");
}
