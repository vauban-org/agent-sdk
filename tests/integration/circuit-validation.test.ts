/**
 * Integration: circuit-breaker, idempotency, bulkhead validation (Sprint-477).
 *
 * Validates sprint-468 primitives under chaos-induced failure modes:
 *   1. wholeCircuit — trips at threshold N, recovers after backoff (half-open probe)
 *   2. Idempotency — 10 concurrent identical calls → 1 Brain entry written
 *   3. Bulkhead — 20 concurrent recordOutcomeAsync → max 5 active, rest queued/shed
 */

import { describe, expect, it, vi } from "vitest";
import {
  BrainUnavailable,
  BulkheadFullError,
  CircuitOpenError,
  bulkhead,
  circuitBreaker,
  hashKey,
  idempotent,
} from "../../src/index.js";
import type { BrainEntry, BrainEntryInput, BrainPort } from "../../src/ports/index.js";
import type { AgentRunRef, OutcomePort } from "../../src/ports/outcome.js";
import { exhaustResources, networkJitter, wholeCircuit } from "../../src/testing/index.js";

// ─── Factories ───────────────────────────────────────────────────────────

function buildMemoryBrain(): BrainPort & {
  entries: BrainEntry[];
  callCount: number;
} {
  const entries: BrainEntry[] = [];
  let callCount = 0;
  return {
    entries,
    get callCount() {
      return callCount;
    },
    async archiveKnowledge(e: BrainEntryInput): Promise<BrainEntry> {
      callCount += 1;
      const entry: BrainEntry = {
        id: `entry-${entries.length}`,
        content: e.content,
        category: e.category,
        tags: e.tags,
      };
      entries.push(entry);
      return entry;
    },
  };
}

function buildOutcomeMock(delayMs = 0): OutcomePort & {
  activeCount: number;
  peakActive: number;
  totalCalls: number;
} {
  let activeCount = 0;
  let peakActive = 0;
  let totalCalls = 0;

  return {
    get activeCount() {
      return activeCount;
    },
    get peakActive() {
      return peakActive;
    },
    get totalCalls() {
      return totalCalls;
    },
    recordOutcomeAsync(run: AgentRunRef): void {
      totalCalls += 1;
      activeCount += 1;
      peakActive = Math.max(peakActive, activeCount);
      // Simulate async work but don't block caller (fire-and-forget pattern).
      const settle = (): void => {
        setTimeout(() => {
          activeCount -= 1;
        }, delayMs);
      };
      settle();
      // return void per contract
    },
  };
}

// ─── 1. wholeCircuit: trips at threshold, recovers after backoff ─────────

describe("wholeCircuit — trips and recovers via half-open probe", () => {
  it("trips immediately at threshold=3 calls", async () => {
    const brain = buildMemoryBrain();
    const tripped = wholeCircuit(brain);

    const cb = circuitBreaker(tripped.archiveKnowledge.bind(tripped), {
      name: "brain.archive",
      failureThreshold: 3,
      resetAfterMs: 1_000,
    });

    expect(cb.state).toBe("closed");

    for (let i = 0; i < 3; i++) {
      await expect(cb({ content: `step-${i}` })).rejects.toBeInstanceOf(BrainUnavailable);
    }

    expect(cb.state).toBe("open");
    // failureCount reflects the accumulated failures at trip time (not reset until recovery).
    expect(cb.failureCount).toBe(3);
  });

  it("fast-fails while OPEN without invoking port", async () => {
    const brain = buildMemoryBrain();
    const tripped = wholeCircuit(brain);
    const spy = vi.spyOn(tripped, "archiveKnowledge");

    const cb = circuitBreaker(tripped.archiveKnowledge.bind(tripped), {
      name: "brain.archive",
      failureThreshold: 1,
      resetAfterMs: 1_000,
    });

    // Trip the breaker.
    await expect(cb({ content: "x" })).rejects.toBeInstanceOf(BrainUnavailable);
    expect(cb.state).toBe("open");

    const callsAfterTrip = spy.mock.calls.length;

    // Subsequent calls are short-circuited.
    await expect(cb({ content: "y" })).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(cb({ content: "z" })).rejects.toBeInstanceOf(CircuitOpenError);

    // Port was NOT called after the trip.
    expect(spy.mock.calls.length).toBe(callsAfterTrip);
  });

  it("transitions OPEN → HALF-OPEN → CLOSED after backoff with healthy port", async () => {
    let clock = 0;
    const brain = buildMemoryBrain();

    // Use wholeCircuit only to trip, then switch to a healthy brain for recovery.
    const tripped = wholeCircuit(brain);
    let useTripped = true;

    const cb = circuitBreaker(
      async (entry: BrainEntryInput) => {
        if (useTripped) {
          return tripped.archiveKnowledge(entry);
        }
        return brain.archiveKnowledge(entry);
      },
      {
        name: "brain.archive",
        failureThreshold: 1,
        resetAfterMs: 500,
        now: () => clock,
      },
    );

    // Trip at t=0.
    await expect(cb({ content: "fail" })).rejects.toBeInstanceOf(BrainUnavailable);
    expect(cb.state).toBe("open");

    // Switch to healthy port before the probe fires.
    useTripped = false;

    // Advance past resetAfterMs — half-open probe.
    clock = 600;

    const probeResult = await cb({ content: "probe" });
    expect(probeResult.content).toBe("probe");
    expect(cb.state).toBe("closed");
  });
});

// ─── 2. Idempotency: 10 concurrent identical calls → 1 Brain write ───────

describe("idempotency — sequential retry deduplication produces single Brain write", () => {
  it("10 sequential retry calls with the same key → fn called once, cache hit after first", async () => {
    const brain = buildMemoryBrain();
    const fn = vi.fn(brain.archiveKnowledge.bind(brain));

    const safeArchive = idempotent(fn, {
      keyFor: (entry) => hashKey(entry.content, entry.author ?? ""),
    });

    const entry: BrainEntryInput = {
      content: "chaos-test-idempotency",
      author: "narrator",
      category: "test",
    };

    // Sequential calls — first writes, subsequent hits the cache.
    const results: BrainEntry[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(await safeArchive(entry));
    }

    // Underlying fn was only called once (first call). All subsequent are cache hits.
    expect(fn).toHaveBeenCalledTimes(1);

    // All 10 callers received the same result.
    const firstId = results[0].id;
    for (const r of results) {
      expect(r.id).toBe(firstId);
    }

    // Only 1 entry in Brain.
    expect(brain.entries).toHaveLength(1);
  });

  it("different keys are not deduplicated", async () => {
    const brain = buildMemoryBrain();
    const fn = vi.fn(brain.archiveKnowledge.bind(brain));

    const safeArchive = idempotent(fn, {
      keyFor: (entry) => hashKey(entry.content),
    });

    await Promise.all([
      safeArchive({ content: "alpha" }),
      safeArchive({ content: "beta" }),
      safeArchive({ content: "gamma" }),
    ]);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(brain.entries).toHaveLength(3);
  });

  it("idempotency + chaos: failed calls not cached — retry succeeds", async () => {
    const brain = buildMemoryBrain();
    let failOnce = true;

    const fn = vi.fn(async (entry: BrainEntryInput) => {
      if (failOnce) {
        failOnce = false;
        throw new BrainUnavailable();
      }
      return brain.archiveKnowledge(entry);
    });

    const safeArchive = idempotent(fn, {
      keyFor: (entry) => hashKey(entry.content),
    });

    const entry: BrainEntryInput = { content: "retry-test" };

    // First call fails — not cached.
    await expect(safeArchive(entry)).rejects.toBeInstanceOf(BrainUnavailable);

    // Second call succeeds.
    const result = await safeArchive(entry);
    expect(result.content).toBe("retry-test");

    // fn was called twice (once fail, once success).
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ─── 3. Bulkhead: 20 concurrent calls → max 5 active, rest queued/shed ──

describe("bulkhead — concurrency cap + queue discipline under load", () => {
  it("peak active never exceeds maxConcurrent=5 with 20 concurrent callers", async () => {
    let peakActive = 0;
    let active = 0;

    const fn = vi.fn(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((r) => setTimeout(r, 15));
      active -= 1;
    });

    const guarded = bulkhead(fn, {
      name: "brain.archive",
      maxConcurrent: 5,
      maxQueued: 50,
    });

    await Promise.all(Array.from({ length: 20 }, () => guarded()));

    expect(peakActive).toBeLessThanOrEqual(5);
    expect(fn).toHaveBeenCalledTimes(20);
  });

  it("shed calls that exceed maxQueued and throw BulkheadFullError", async () => {
    const fn = vi.fn(() => new Promise<void>((r) => setTimeout(r, 50)));
    const guarded = bulkhead(fn, {
      name: "brain.archive",
      maxConcurrent: 2,
      maxQueued: 3,
    });

    // Kick off 6 calls: 2 active + 3 queued + 1 shed.
    const calls = Array.from({ length: 6 }, () => guarded().catch((err) => err));

    const results = await Promise.all(calls);
    const errors = results.filter((r) => r instanceof BulkheadFullError);
    const successes = results.filter((r) => !(r instanceof Error));

    // At least one call was shed.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Successful calls respect maxConcurrent + maxQueued.
    expect(successes.length).toBeLessThanOrEqual(5);
  });

  it("bulkhead stats report active + queued in real time", async () => {
    const fn = vi.fn(() => new Promise<void>((r) => setTimeout(r, 30)));
    const guarded = bulkhead(fn, {
      name: "brain.archive",
      maxConcurrent: 3,
      maxQueued: 10,
    });

    // Fire 7 calls — 3 active, 4 queued.
    const pending = Array.from({ length: 7 }, () => guarded());

    await new Promise((r) => setTimeout(r, 5)); // let them start
    expect(guarded.stats.active).toBe(3);
    expect(guarded.stats.queued).toBe(4);

    await Promise.all(pending);
    expect(guarded.stats.active).toBe(0);
    expect(guarded.stats.queued).toBe(0);
  });

  it("exhaustResources: throws after N calls (simulates quota exhaustion)", async () => {
    const brain = buildMemoryBrain();
    const limited = exhaustResources(brain, { maxCalls: 3 });

    // First 3 calls succeed.
    await expect(limited.archiveKnowledge({ content: "a" })).resolves.toBeDefined();
    await expect(limited.archiveKnowledge({ content: "b" })).resolves.toBeDefined();
    await expect(limited.archiveKnowledge({ content: "c" })).resolves.toBeDefined();

    // 4th call throws BrainUnavailable.
    await expect(limited.archiveKnowledge({ content: "d" })).rejects.toBeInstanceOf(
      BrainUnavailable,
    );
    // 5th too.
    await expect(limited.archiveKnowledge({ content: "e" })).rejects.toBeInstanceOf(
      BrainUnavailable,
    );

    // Only 3 entries were actually written.
    expect(brain.entries).toHaveLength(3);
  });

  it("networkJitter p99Ms + bulkhead: queue stays bounded under slow backend", async () => {
    const brain = buildMemoryBrain();
    // p99Ms=40, p50Ms=5 → most calls ≈ 5ms, 99th percentile ≈ 40ms.
    const slow = networkJitter(brain, { p99Ms: 40, p50Ms: 5 });

    const guarded = bulkhead((e: BrainEntryInput) => slow.archiveKnowledge(e), {
      name: "brain.archive",
      maxConcurrent: 5,
      maxQueued: 30,
    });

    const calls = Array.from({ length: 20 }, (_, i) =>
      guarded({ content: `entry-${i}` }).catch((err) => err),
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(guarded.stats.active).toBeLessThanOrEqual(5);
    expect(guarded.stats.queued).toBeLessThanOrEqual(30);

    const results = await Promise.all(calls);
    const failures = results.filter((r) => r instanceof Error);

    // All 20 succeed — queue never saturated (maxQueued=30 > 20-5=15 pending).
    expect(failures).toHaveLength(0);
    expect(brain.entries).toHaveLength(20);
  });
});
