/**
 * Idempotency primitives for orchestration-layer deduplication.
 *
 * Sprint-468 (command-center:sprint-468:idempotency-keys).
 *
 * Three utilities:
 *   - computeIdempotencyKey  — SHA-256 fingerprint of a semantic payload
 *   - withIdempotency        — in-memory call deduplication by key
 *   - addIdempotencyHeader   — HTTP header injection for downstream services
 *
 * These operate at the orchestration layer (agent dispatch, pipeline step)
 * rather than at the port level. Use the resilience/idempotent.ts primitive
 * for direct port-wrapping; use these when you need explicit key management
 * or HTTP propagation.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// computeIdempotencyKey
// ---------------------------------------------------------------------------

/** @public */
export interface IdempotencyKeyPayload {
  content: string;
  author: string;
  category: string;
}

/**
 * Derive a stable SHA-256 hex key from a semantic payload.
 *
 * Fields are ordered deterministically (alphabetical) before hashing so
 * that object construction order does not affect the result.
 *
 * @param payload - Semantic payload with content, author, and category.
 * @returns 64-character lowercase hex string.
 * @public
 */
export function computeIdempotencyKey(payload: IdempotencyKeyPayload): string {
  const h = createHash("sha256");
  // Deterministic field order — alphabet: author < category < content
  h.update(payload.author);
  h.update("\x1f");
  h.update(payload.category);
  h.update("\x1f");
  h.update(payload.content);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// withIdempotency
// ---------------------------------------------------------------------------

/** @public */
export interface WithIdempotencyOptions {
  /** Entry TTL in ms. Default: 5 minutes. */
  ttlMs?: number;
}

interface CacheEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

/**
 * Deduplicate concurrent or repeated async calls using an in-memory Map.
 *
 * While a call identified by `key` is in-flight, subsequent calls with the
 * same key attach to the same Promise (fan-out dedup). Once the call
 * settles, the result is cached for `ttlMs` ms so that replay requests
 * within the window also receive the same value without re-invoking.
 *
 * Failures are NOT cached: a failed call is immediately evicted so it can
 * be retried.
 *
 * The shared cache Map is module-scoped by default. Pass an explicit Map
 * for per-instance isolation (e.g. in tests or multi-tenant agents).
 *
 * @param call  - Zero-argument factory returning a Promise.
 * @param key   - Stable deduplication key (from computeIdempotencyKey or any string).
 * @param opts  - Optional TTL override.
 * @param store - Optional shared Map (module-level singleton by default).
 */

const _defaultStore = new Map<string, CacheEntry<unknown>>();

/** @public */
export function withIdempotency<T>(
  call: () => Promise<T>,
  key: string,
  opts?: WithIdempotencyOptions,
  store?: Map<string, CacheEntry<unknown>>,
): Promise<T> {
  const cache = (store ?? _defaultStore) as Map<string, CacheEntry<T>>;
  const ttlMs = opts?.ttlMs ?? 5 * 60_000;
  const now = Date.now();

  const existing = cache.get(key);
  if (existing !== undefined && existing.expiresAt > now) {
    return existing.promise;
  }

  const promise = call().then(
    (value) => {
      // Refresh TTL on success so replays within window are cheap.
      cache.set(key, { promise: Promise.resolve(value), expiresAt: Date.now() + ttlMs });
      return value;
    },
    (err: unknown) => {
      // Evict on failure — allow retry.
      cache.delete(key);
      return Promise.reject(err);
    },
  );

  // Store the in-flight promise immediately so concurrent callers attach.
  cache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

// ---------------------------------------------------------------------------
// addIdempotencyHeader
// ---------------------------------------------------------------------------

/**
 * Inject an `X-Idempotency-Key` header into a plain headers record.
 *
 * Returns a new object — does not mutate the input. Safe to call in a
 * pipeline step that builds the options for a downstream `fetch` call.
 *
 * @param headers - Existing headers object (may be empty).
 * @param key     - Idempotency key (from computeIdempotencyKey or any string).
 * @returns New headers object with X-Idempotency-Key added.
 * @public
 */
export function addIdempotencyHeader(
  headers: Record<string, string>,
  key: string,
): Record<string, string> {
  return { ...headers, "X-Idempotency-Key": key };
}
