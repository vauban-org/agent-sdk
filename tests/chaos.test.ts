/**
 * Tests for the chaos harness (Sprint-477).
 *
 * Exercises the three wrappers — injectFailure, networkJitter,
 * fullOutage — against reference ports. Critical: combined with
 * circuitBreaker / bulkhead, the agent must degrade gracefully instead
 * of crashing or piling up unbounded work.
 */

import { describe, expect, it, vi } from "vitest";
import {
  injectFailure,
  networkJitter,
  fullOutage,
} from "../src/testing/index.js";
import {
  BrainRateLimit,
  BrainUnavailable,
  circuitBreaker,
  CircuitOpenError,
  bulkhead,
} from "../src/index.js";
import type { BrainPort } from "../src/ports/index.js";

function reliableBrain(): BrainPort {
  return {
    archiveKnowledge: async (entry) => ({ id: "ok-1", content: entry.content }),
  };
}

describe("injectFailure", () => {
  it("fails approximately `rate` fraction of calls", async () => {
    // Deterministic PRNG: 0.5, 0.5, 0.5, ... → half fail at rate=0.5
    let i = 0;
    const samples = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7];
    const rand = () => samples[i++ % samples.length];

    const flaky = injectFailure(reliableBrain(), {
      rate: 0.5,
      type: "rate-limit",
      random: rand,
    });

    let ok = 0;
    let fail = 0;
    for (let k = 0; k < samples.length; k++) {
      try {
        await flaky.archiveKnowledge({ content: "x" });
        ok += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(BrainRateLimit);
        fail += 1;
      }
    }
    expect(ok + fail).toBe(samples.length);
    expect(fail).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(0);
  });

  it("fullOutage always fails with BrainUnavailable by default", async () => {
    const dead = fullOutage(reliableBrain());
    await expect(dead.archiveKnowledge({ content: "x" })).rejects.toBeInstanceOf(
      BrainUnavailable,
    );
  });

  it("forwards non-function fields unchanged", () => {
    const impl = { archiveKnowledge: async () => null, version: "1.2.3" };
    const flaky = injectFailure(impl, { rate: 1 });
    expect(flaky.version).toBe("1.2.3");
  });
});

describe("networkJitter", () => {
  it("respects [minMs, maxMs] bounds", async () => {
    const slow = networkJitter(reliableBrain(), { minMs: 10, maxMs: 30 });
    const start = Date.now();
    await slow.archiveKnowledge({ content: "x" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(8); // small slack for timer resolution
    expect(elapsed).toBeLessThan(80);
  });
});

// ─── Integration: antifragile primitives actually protect agents ────────

describe("chaos + circuit breaker integration", () => {
  it("fullOutage trips the circuit breaker and fast-fails", async () => {
    const rawBrain = reliableBrain();
    const brokenBrain = fullOutage(rawBrain);

    // Wrap the impl.archiveKnowledge with a breaker
    const protectedArchive = circuitBreaker(
      (entry: { content: string }) => brokenBrain.archiveKnowledge(entry),
      { name: "brain.archive", failureThreshold: 3 },
    );

    for (let i = 0; i < 3; i++) {
      await expect(protectedArchive({ content: "x" })).rejects.toBeInstanceOf(
        BrainUnavailable,
      );
    }
    // 4th call short-circuits
    await expect(protectedArchive({ content: "x" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it("bulkhead + network jitter keeps queue bounded", async () => {
    const slow = networkJitter(reliableBrain(), { minMs: 20, maxMs: 30 });
    const gated = bulkhead(
      (entry: { content: string }) => slow.archiveKnowledge(entry),
      { name: "brain", maxConcurrent: 3, maxQueued: 5 },
    );

    const promises = Array.from({ length: 8 }, () =>
      gated({ content: "x" }).catch((err) => err),
    );

    // After kicking 8 calls off with 3 concurrent + 5 queued, nothing
    // should reject immediately. Peak stats should respect the cap.
    await new Promise((r) => setTimeout(r, 5));
    expect(gated.stats.active).toBeLessThanOrEqual(3);
    expect(gated.stats.queued).toBeLessThanOrEqual(5);

    const results = await Promise.all(promises);
    // All 8 succeed (none rejected) — queue never saturated (>5 queued).
    expect(results.every((r) => !(r instanceof Error))).toBe(true);
  });
});
