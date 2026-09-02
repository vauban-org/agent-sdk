/**
 * Tests for proof/receipt-queue — InMemoryReceiptQueue + HMAC integrity (CH1-r).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyProvider } from "../src/ports/key-provider.js";
import type { KeyProvider } from "../src/ports/key-provider.js";
import type { TimestampPort } from "../src/ports/timestamp.js";
import {
  DEFAULT_BACKOFF_MS,
  HmacInvalidError,
  InMemoryReceiptQueue,
} from "../src/proof/receipt-queue.js";
import type { SignedReceipt } from "../src/trace/schema.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** A KeyProvider that returns a fixed 32-byte key. */
function fixedKeyProvider(keyHex = "a".repeat(64)): KeyProvider {
  return {
    getKey: vi.fn().mockResolvedValue(new Uint8Array(Buffer.from(keyHex, "hex"))),
    hasColocationRisk: vi.fn().mockReturnValue(false),
  };
}

function makeReceipt(): SignedReceipt {
  return {
    tsa: "https://freetsa.org",
    timestamp: new Date().toISOString(),
    signature: "sig-base64",
    algorithm: "sha-256",
    hashedMessage: "a".repeat(64),
  };
}

function successAdapter(): TimestampPort {
  const receipt = makeReceipt();
  return {
    request: vi.fn().mockResolvedValue(receipt),
    verify: vi.fn().mockResolvedValue({ valid: true }),
  };
}

function failAdapter(msg = "TSA down"): TimestampPort {
  return {
    request: vi.fn().mockRejectedValue(new Error(msg)),
    verify: vi.fn().mockResolvedValue({ valid: false }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("InMemoryReceiptQueue", () => {
  let queue: InMemoryReceiptQueue;
  const keyId = "TRACE_HMAC_KEY";
  let keyProvider: KeyProvider;

  beforeEach(() => {
    queue = new InMemoryReceiptQueue();
    keyProvider = fixedKeyProvider();
  });

  // ── enqueue ────────────────────────────────────────────────────────────────

  describe("enqueue()", () => {
    it("adds an entry with a non-empty HMAC", async () => {
      await queue.enqueue(
        { runId: "run-1", rootHash: "a".repeat(64), queuedAt: Date.now() },
        keyProvider,
        keyId,
      );
      const entries = await queue.pending();
      expect(entries).toHaveLength(1);
      expect(entries[0].hmac).toMatch(/^[0-9a-f]{64}$/);
    });

    it("initial attempts is 0", async () => {
      await queue.enqueue(
        { runId: "run-2", rootHash: "b".repeat(64), queuedAt: Date.now() },
        keyProvider,
        keyId,
      );
      const entries = await queue.pending();
      expect(entries[0].attempts).toBe(0);
    });

    it("different entries produce different HMACs", async () => {
      await queue.enqueue(
        { runId: "run-a", rootHash: "a".repeat(64), queuedAt: 1000 },
        keyProvider,
        keyId,
      );
      await queue.enqueue(
        { runId: "run-b", rootHash: "b".repeat(64), queuedAt: 2000 },
        keyProvider,
        keyId,
      );
      const entries = await queue.pending();
      expect(entries[0].hmac).not.toBe(entries[1].hmac);
    });
  });

  // ── CH1-r — HMAC tamper detection ─────────────────────────────────────────

  describe("CH1-r — HMAC tamper detection", () => {
    it("tampered HMAC → process() rejects entry, rejected++ without calling adapter", async () => {
      const now = Date.now();
      await queue.enqueue(
        { runId: "tampered-run", rootHash: "c".repeat(64), queuedAt: now },
        keyProvider,
        keyId,
      );

      // Manually tamper the HMAC in the internal array.
      const entries = await queue.pending();
      // Access the internal array directly to tamper.
      // We cast to 'unknown' then to any[] to reach private field for testing.
      const internalEntries = (queue as unknown as { _entries: typeof entries })._entries;
      internalEntries[0].hmac = "f".repeat(64);

      const adapter = successAdapter();
      const result = await queue.process(adapter, keyProvider, keyId);

      expect(result.rejected).toBe(1);
      expect(result.processed).toBe(0);
      expect(adapter.request).not.toHaveBeenCalled();
    });

    it("tampered entry is removed from queue (not retried)", async () => {
      const now = Date.now();
      await queue.enqueue(
        { runId: "tampered-run-2", rootHash: "d".repeat(64), queuedAt: now },
        keyProvider,
        keyId,
      );

      const internalEntries = (queue as unknown as { _entries: unknown[] })._entries;
      (internalEntries[0] as { hmac: string }).hmac = "e".repeat(64);

      const adapter = successAdapter();
      await queue.process(adapter, keyProvider, keyId);

      const remaining = await queue.pending();
      expect(remaining).toHaveLength(0);
    });
  });

  // ── process() happy path ──────────────────────────────────────────────────

  describe("process() — happy path", () => {
    it("successful TSA → entry removed, processed++", async () => {
      const now = Date.now();
      await queue.enqueue(
        { runId: "run-ok", rootHash: "e".repeat(64), queuedAt: now },
        keyProvider,
        keyId,
      );

      const adapter = successAdapter();
      const result = await queue.process(adapter, keyProvider, keyId);

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.rejected).toBe(0);
      expect(await queue.size?.()).toBe(0);
    });

    it("adapter called with correct rootHash", async () => {
      const rootHash = "f".repeat(64);
      const now = Date.now();
      await queue.enqueue({ runId: "run-hash-check", rootHash, queuedAt: now }, keyProvider, keyId);

      const adapter = successAdapter();
      await queue.process(adapter, keyProvider, keyId);

      expect(adapter.request).toHaveBeenCalledWith(rootHash);
    });
  });

  // ── process() — failure + backoff ────────────────────────────────────────

  describe("process() — failure handling", () => {
    it("failed TSA → entry stays in queue, failed++, attempts incremented", async () => {
      const now = Date.now();
      await queue.enqueue(
        { runId: "run-fail", rootHash: "a".repeat(64), queuedAt: now },
        keyProvider,
        keyId,
      );

      const adapter = failAdapter();
      const result = await queue.process(adapter, keyProvider, keyId);

      expect(result.failed).toBe(1);
      expect(result.processed).toBe(0);
      const remaining = await queue.pending();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].attempts).toBe(1);
    });

    it("after failure HMAC is recomputed for updated entry (attempts++)", async () => {
      const now = Date.now();
      await queue.enqueue(
        { runId: "run-rehmac", rootHash: "b".repeat(64), queuedAt: now },
        keyProvider,
        keyId,
      );

      const originalEntries = await queue.pending();
      const originalHmac = originalEntries[0].hmac;

      const adapter = failAdapter();
      await queue.process(adapter, keyProvider, keyId);

      // After failure, attempts=1, so HMAC must be different from attempts=0.
      const updatedEntries = await queue.pending();
      expect(updatedEntries[0].hmac).not.toBe(originalHmac);
    });

    it("backoff: entry with attempts=2 is skipped if queuedAt + DEFAULT_BACKOFF_MS[1] > now", async () => {
      // queuedAt is far in the past — backoff[1] = 5min.
      // We'll use a near-future queuedAt to simulate not-yet-due.
      const futureQueuedAt = Date.now() + 60_000; // 1min in future

      // Manually craft an entry with attempts=2.
      const queue2 = new InMemoryReceiptQueue();
      await queue2.enqueue(
        { runId: "run-backoff", rootHash: "c".repeat(64), queuedAt: futureQueuedAt },
        keyProvider,
        keyId,
      );
      // Manually set attempts to 2 for backoff test.
      const internalEntries = (queue2 as unknown as { _entries: unknown[] })._entries;
      const entry = internalEntries[0] as {
        attempts: number;
        hmac: string;
        runId: string;
        rootHash: string;
        queuedAt: number;
      };
      entry.attempts = 2;
      // Recompute HMAC for the mutated attempts value.
      const { hmacSha256 } = await import("../src/proof/sha256.js");
      const { canonicalize } = await import("../src/trace/canonical.js");
      const key = await keyProvider.getKey(keyId);
      const newHmac = await hmacSha256(
        key,
        canonicalize({
          attempts: entry.attempts,
          queuedAt: entry.queuedAt,
          rootHash: entry.rootHash,
          runId: entry.runId,
        }),
      );
      entry.hmac = newHmac;

      const adapter = successAdapter();
      const result = await queue2.process(adapter, keyProvider, keyId);

      // Entry is not due yet → skipped (not counted in any bucket).
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.rejected).toBe(0);
      expect(adapter.request).not.toHaveBeenCalled();
    });
  });

  // ── DEFAULT_BACKOFF_MS ────────────────────────────────────────────────────

  describe("DEFAULT_BACKOFF_MS", () => {
    it("has 5 levels", () => {
      expect(DEFAULT_BACKOFF_MS).toHaveLength(5);
    });

    it("is monotonically increasing", () => {
      for (let i = 1; i < DEFAULT_BACKOFF_MS.length; i++) {
        expect(DEFAULT_BACKOFF_MS[i]).toBeGreaterThan(DEFAULT_BACKOFF_MS[i - 1]);
      }
    });

    it("first level is 30s", () => {
      expect(DEFAULT_BACKOFF_MS[0]).toBe(30_000);
    });

    it("last level is 24h", () => {
      expect(DEFAULT_BACKOFF_MS[4]).toBe(24 * 60 * 60_000);
    });
  });

  // ── KeyProvider colocation warning ────────────────────────────────────────

  describe("KeyProvider colocation warning", () => {
    it("emits warning to stderr when hasColocationRisk() returns true", async () => {
      const riskProvider: KeyProvider = {
        getKey: vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xab)),
        hasColocationRisk: vi.fn().mockReturnValue(true),
      };

      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await queue.enqueue(
        { runId: "risk-run", rootHash: "d".repeat(64), queuedAt: Date.now() },
        riskProvider,
        "RISK_KEY",
      );

      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("colocation risk"));

      stderrWrite.mockRestore();
    });
  });

  // ── size() ────────────────────────────────────────────────────────────────

  describe("size()", () => {
    it("returns 0 for empty queue", async () => {
      expect(await queue.size?.()).toBe(0);
    });

    it("increments after enqueue", async () => {
      await queue.enqueue(
        { runId: "r1", rootHash: "a".repeat(64), queuedAt: Date.now() },
        keyProvider,
        keyId,
      );
      expect(await queue.size?.()).toBe(1);
    });
  });
});

// ─── HmacInvalidError ────────────────────────────────────────────────────────

describe("HmacInvalidError", () => {
  it("has name HmacInvalidError", () => {
    const err = new HmacInvalidError("test-run");
    expect(err.name).toBe("HmacInvalidError");
  });

  it("message contains runId", () => {
    const err = new HmacInvalidError("my-run-id");
    expect(err.message).toContain("my-run-id");
  });

  it("is an instance of Error", () => {
    expect(new HmacInvalidError("x")).toBeInstanceOf(Error);
  });
});
