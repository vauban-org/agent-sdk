/**
 * LLMResponseCache — content-addressed in-memory cache for LLM responses.
 *
 * Cache key: SHA-256(canonical({provider, model, messages, temperature, seed?}))
 * This makes the cache deterministic across runs given identical inputs,
 * enabling replay of LLM responses without hitting the actual provider.
 *
 * Production adapters (pgsql, Redis) belong to the B-series tasks.
 * This module ships the in-memory implementation + the hash utility.
 *
 * @module replay/llm-cache
 */

import { canonicalize } from "../trace/canonical.js";

// ─── LLMCacheKey ──────────────────────────────────────────────────────────────

/**
 * Canonical key for an LLM response cache entry.
 * All fields are included in the SHA-256 hash — changing any field
 * produces a different cache key (cache miss).
 * @public
 */
export interface LLMCacheKey {
  /** LLM provider identifier (e.g. "openai", "groq", "anthropic"). */
  provider: string;
  /** Model identifier (e.g. "gpt-4o", "llama-3.3-70b"). */
  model: string;
  /**
   * Message array passed to the LLM. Array order matters: a different
   * ordering of the same messages will produce a different hash.
   */
  messages: unknown;
  /** Sampling temperature. Included in key — same prompt at different temps yields different responses. */
  temperature: number;
  /**
   * Optional provider-side seed for deterministic sampling.
   * When present, influences the cache key to distinguish seeded from unseeded calls.
   */
  seed?: number;
}

// ─── LLMCacheEntry ────────────────────────────────────────────────────────────

/**
 * A single cache entry: the hash key, the stored response, and when it was recorded.
 * @public
 */
export interface LLMCacheEntry {
  /** SHA-256(canonical(LLMCacheKey)) — hex-encoded. */
  key: string;
  /** Full serialized response payload from the LLM provider. */
  response: unknown;
  /** Unix epoch milliseconds when this entry was recorded. */
  recordedAt: number;
}

// ─── LLMResponseCache interface ───────────────────────────────────────────────

/**
 * Content-addressed store for LLM responses.
 *
 * Implementations:
 *   - InMemoryLLMResponseCache (this module) — for tests and dev.
 *   - PostgreSQL adapter (B-series tasks) — for production replay.
 * @public
 */
export interface LLMResponseCache {
  /**
   * Look up a cached response for the given key.
   * Returns undefined on a cache miss.
   */
  get(key: LLMCacheKey): Promise<LLMCacheEntry | undefined>;

  /**
   * Store a response for the given key.
   * Overwrites any existing entry with the same hash.
   */
  put(key: LLMCacheKey, response: unknown): Promise<void>;

  /**
   * Test helper: wipe the entire in-memory store.
   * Optional — production adapters may omit this.
   */
  clear?(): void;
}

// ─── hashLLMCacheKey ──────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex hash of a canonical LLMCacheKey.
 *
 * Uses Web Crypto API (globalThis.crypto.subtle) — zero external dependencies.
 * Requires Node >= 20 or any modern browser.
 *
 * Array order in `messages` is significant: two arrays with the same elements
 * in different order will produce different hashes.
 * @public
 */
export async function hashLLMCacheKey(key: LLMCacheKey): Promise<string> {
  const canonical = canonicalize(key);
  const encoded = new TextEncoder().encode(canonical);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return bufferToHex(hashBuffer);
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── InMemoryLLMResponseCache ─────────────────────────────────────────────────

/**
 * In-memory LLM response cache keyed by SHA-256(canonical(LLMCacheKey)).
 *
 * Intended for:
 *   - Unit and integration tests (deterministic, zero I/O).
 *   - Development replay (fast, ephemeral).
 *
 * NOT intended for production: data is lost on process restart.
 * Production replay should use the PostgreSQL adapter (B-series).
 * @public
 */
export class InMemoryLLMResponseCache implements LLMResponseCache {
  private readonly store = new Map<string, LLMCacheEntry>();

  async get(key: LLMCacheKey): Promise<LLMCacheEntry | undefined> {
    const hash = await hashLLMCacheKey(key);
    return this.store.get(hash);
  }

  async put(key: LLMCacheKey, response: unknown): Promise<void> {
    const hash = await hashLLMCacheKey(key);
    this.store.set(hash, {
      key: hash,
      response,
      recordedAt: Date.now(),
    });
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── CompositeLLMResponseCache ────────────────────────────────────────────────

/**
 * Composite (two-level) LLM response cache.
 *
 * Lookup order: child cache first, then parent cache (lookup-through).
 * Writes go only to the child cache. In replay mode the child is typically
 * read-only (no new entries), so `put()` is a no-op — pass `readOnly: true`.
 *
 * Use `withParent()` to construct a child cache that inherits responses from a
 * parent cycle without polluting the parent's store.
 */
export class CompositeLLMResponseCache implements LLMResponseCache {
  constructor(
    private readonly child: LLMResponseCache,
    private readonly parent: LLMResponseCache,
    private readonly readOnly: boolean = false,
  ) {}

  async get(key: LLMCacheKey): Promise<LLMCacheEntry | undefined> {
    // Child takes priority (own cycle entries override parent)
    const childHit = await this.child.get(key);
    if (childHit !== undefined) return childHit;
    return this.parent.get(key);
  }

  async put(key: LLMCacheKey, response: unknown): Promise<void> {
    if (this.readOnly) return;
    await this.child.put(key, response);
  }

  clear(): void {
    if (!this.readOnly && typeof this.child.clear === "function") {
      this.child.clear();
    }
  }
}

/**
 * Factory: creates a composite cache that looks up `parentCache` on miss.
 * The child is a fresh InMemoryLLMResponseCache — writes do NOT propagate to
 * the parent (write-back disabled in replay mode by default).
 *
 * @param parentCache  The parent cycle's cache (read-only access).
 * @param readOnly     When true, put() is a no-op (replay write-back disabled).
 *                     Defaults to true for replay safety.
 */
export function withParent(parentCache: LLMResponseCache, readOnly = true): LLMResponseCache {
  return new CompositeLLMResponseCache(new InMemoryLLMResponseCache(), parentCache, readOnly);
}
