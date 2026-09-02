/**
 * ReceiptQueue — tamper-evident in-memory queue for TSA receipt retries.
 *
 * CH1-r: Every entry is HMAC-SHA-256 authenticated. process() rejects entries
 * with invalid HMACs before submitting to the TSA — no silent data corruption.
 *
 * Backoff schedule: DEFAULT_BACKOFF_MS defines 5 exponential windows.
 * process() skips entries whose next retry time has not been reached yet
 * (based on queuedAt + DEFAULT_BACKOFF_MS[attempts - 1]).
 *
 * KeyProvider isolation: the key is fetched from the provider at enqueue and
 * process time — never stored in the entry itself.
 *
 * @module proof/receipt-queue
 */

import { timingSafeEqual } from "node:crypto";
import type { KeyProvider } from "../ports/key-provider.js";
import type { TimestampPort } from "../ports/timestamp.js";
import { canonicalize } from "../trace/canonical.js";
import type { SignedReceipt } from "../trace/schema.js";
import { hmacSha256 } from "./sha256.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** @public */
export interface ReceiptQueueEntry {
  runId: string;
  rootHash: string;
  /** Unix epoch milliseconds when this entry was first enqueued. */
  queuedAt: number;
  /** Number of prior failed attempts (0 on first enqueue). */
  attempts: number;
  /**
   * HMAC-SHA-256(canonical(entry-without-hmac), key from provider).
   * CH1-r: tamper-evident field. process() rejects if this does not
   * match a freshly computed HMAC.
   */
  hmac: string;
}

/** @public */
export interface ReceiptQueue {
  /**
   * Add a new entry to the queue. Computes and stores the HMAC.
   *
   * @param entry       - Entry without hmac/attempts.
   * @param keyProvider - Provider that supplies the HMAC key.
   * @param keyId       - Key identifier for keyProvider.getKey().
   */
  enqueue(
    entry: Omit<ReceiptQueueEntry, "hmac" | "attempts">,
    keyProvider: KeyProvider,
    keyId: string,
  ): Promise<void>;

  /** Return all entries currently in the queue (including those in backoff). */
  pending(): Promise<ReceiptQueueEntry[]>;

  /**
   * Process up to `batchSize` due entries.
   *
   * For each entry:
   *   - Recompute HMAC; if mismatch → increment `rejected`, do NOT call adapter.
   *   - If backoff window not elapsed → skip (not counted in any bucket).
   *   - On success → remove from queue.
   *   - On failure → increment `entry.attempts`, apply next backoff.
   *
   * @returns { processed, failed, rejected }
   */
  process(
    adapter: TimestampPort,
    keyProvider: KeyProvider,
    keyId: string,
    opts?: { batchSize?: number; backoffMs?: readonly number[] },
  ): Promise<{ processed: number; failed: number; rejected: number }>;

  /** Number of entries currently in the queue. Test helper. */
  size?(): Promise<number>;
}

/**
 * Default exponential backoff schedule (5 levels).
 * Level 0 = 30s, 1 = 5min, 2 = 1h, 3 = 6h, 4 = 24h.
 * @public
 */
export const DEFAULT_BACKOFF_MS = [
  30_000,
  5 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown internally when a queue entry HMAC fails verification.
 * The error is caught by process() and counted in the `rejected` bucket.
 * @public
 */
export class HmacInvalidError extends Error {
  constructor(runId: string) {
    super(
      `HmacInvalidError: HMAC verification failed for entry runId="${runId}". The entry may have been tampered with. Entry rejected without TSA call.`,
    );
    this.name = "HmacInvalidError";
  }
}

// ─── HMAC helpers ─────────────────────────────────────────────────────────────

async function computeEntryHmac(
  entry: Omit<ReceiptQueueEntry, "hmac">,
  keyProvider: KeyProvider,
  keyId: string,
): Promise<string> {
  const key = await keyProvider.getKey(keyId);
  // Canonical representation excludes the hmac field itself.
  const canonical = canonicalize({
    attempts: entry.attempts,
    queuedAt: entry.queuedAt,
    rootHash: entry.rootHash,
    runId: entry.runId,
  });
  return hmacSha256(key, canonical);
}

// ─── InMemoryReceiptQueue ─────────────────────────────────────────────────────

/**
 * In-memory ReceiptQueue implementation.
 *
 * Not durable across restarts — for production persistence, implement
 * ReceiptQueue against a PostgreSQL table (see sprint-562 B2).
 * @public
 */
export class InMemoryReceiptQueue implements ReceiptQueue {
  private readonly _entries: ReceiptQueueEntry[] = [];

  async enqueue(
    entry: Omit<ReceiptQueueEntry, "hmac" | "attempts">,
    keyProvider: KeyProvider,
    keyId: string,
  ): Promise<void> {
    // Emit colocation warning if EnvKeyProvider + TRACE_DB_URL detected.
    if (keyProvider.hasColocationRisk()) {
      process.stderr.write(
        "[WARN] InMemoryReceiptQueue.enqueue: KeyProvider reports colocation risk " +
          "(key and TRACE_DB_URL on same host). " +
          "For production audit compliance, migrate to ExternalKMSKeyProvider.\n",
      );
    }

    const withAttempts = { ...entry, attempts: 0 };
    const hmac = await computeEntryHmac(withAttempts, keyProvider, keyId);
    this._entries.push({ ...withAttempts, hmac });
  }

  async pending(): Promise<ReceiptQueueEntry[]> {
    return [...this._entries];
  }

  async process(
    adapter: TimestampPort,
    keyProvider: KeyProvider,
    keyId: string,
    opts?: { batchSize?: number; backoffMs?: readonly number[] },
  ): Promise<{ processed: number; failed: number; rejected: number }> {
    const backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
    const batchSize = opts?.batchSize ?? this._entries.length;

    let processed = 0;
    let failed = 0;
    let rejected = 0;

    const now = Date.now();
    const toRemove: number[] = [];

    let count = 0;
    for (let i = 0; i < this._entries.length && count < batchSize; i++) {
      const entry = this._entries[i];

      // CH1-r: recompute HMAC and compare before calling adapter.
      const expectedHmac = await computeEntryHmac(
        {
          attempts: entry.attempts,
          queuedAt: entry.queuedAt,
          rootHash: entry.rootHash,
          runId: entry.runId,
        },
        keyProvider,
        keyId,
      );
      // Constant-time compare: entry.hmac is attacker-influenceable and this is
      // a secret-keyed MAC, so a non-timing-safe !== would leak the expected MAC.
      const hmacBuf = Buffer.from(entry.hmac, "utf8");
      const expectedBuf = Buffer.from(expectedHmac, "utf8");
      if (hmacBuf.length !== expectedBuf.length || !timingSafeEqual(hmacBuf, expectedBuf)) {
        rejected++;
        toRemove.push(i); // Remove tampered entries immediately.
        count++;
        continue;
      }

      // Backoff check: skip if retry window hasn't elapsed.
      if (entry.attempts > 0) {
        const backoffIdx = Math.min(entry.attempts - 1, backoffMs.length - 1);
        const nextRetryAt = entry.queuedAt + backoffMs[backoffIdx];
        if (now < nextRetryAt) {
          // Not due yet — skip but do not count.
          continue;
        }
      }

      count++;

      try {
        // Try to request the TSA receipt.
        const _receipt: SignedReceipt = await adapter.request(entry.rootHash);
        void _receipt;
        // Success — mark for removal.
        toRemove.push(i);
        processed++;
      } catch {
        // Failure — increment attempts and recompute HMAC for updated entry.
        entry.attempts += 1;
        const newHmac = await computeEntryHmac(
          {
            attempts: entry.attempts,
            queuedAt: entry.queuedAt,
            rootHash: entry.rootHash,
            runId: entry.runId,
          },
          keyProvider,
          keyId,
        );
        entry.hmac = newHmac;
        failed++;
      }
    }

    // Remove processed/rejected entries (reverse order to keep indices stable).
    for (const idx of toRemove.slice().sort((a, b) => b - a)) {
      this._entries.splice(idx, 1);
    }

    return { processed, failed, rejected };
  }

  async size(): Promise<number> {
    return this._entries.length;
  }
}
