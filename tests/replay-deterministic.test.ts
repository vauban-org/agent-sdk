/**
 * Deterministic replay property tests.
 *
 * Core property: given identical seed, a fixed timestamp array, and a fixed
 * random sequence, the hash chain produced by running the PRNG + clock is
 * byte-identical across an original run and a RecordedClock/RecordedRandom replay.
 *
 * NOTE: this proves byte-identical replay when LLM cache + clock + random are
 * virtualized. Does NOT prove LLM provider determinism — the provider may return
 * different tokens even with identical inputs (temperature, context window,
 * batching). Provider-side non-determinism is an orthogonal concern.
 */

import { describe, expect, it } from "vitest";
import { RecordedClock } from "../src/replay/clock.js";
import { CryptoRandomDuringReplayError, RealRandom, RecordedRandom } from "../src/replay/random.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulate an "original run": produce N random floats + N UUIDs using a seeded
 * RealRandom, and record N timestamps in arithmetic progression.
 */
function simulateOriginalRun(
  seed: number,
  n: number,
): {
  timestamps: number[];
  nextValues: number[];
  uuids: string[];
  hashSequence: string[];
} {
  const rng = new RealRandom(seed);
  const baseTime = 1_700_000_000_000;
  const timestamps: number[] = [];
  const nextValues: number[] = [];
  const uuids: string[] = [];
  const hashSequence: string[] = [];

  for (let i = 0; i < n; i++) {
    const ts = baseTime + i * 100;
    const v = rng.next();
    const uuid = rng.uuid();

    timestamps.push(ts);
    nextValues.push(v);
    uuids.push(uuid);

    // Proxy hash: deterministic combination of ts + float + uuid
    // (In a real agent this would be SHA-256(canonical(step)); we use a
    // lightweight proxy to avoid async overhead in the 1000-iteration test.)
    const raw = `${ts}:${v.toFixed(15)}:${uuid}`;
    hashSequence.push(raw);
  }

  return { timestamps, nextValues, uuids, hashSequence };
}

/**
 * Simulate a "replay run": use RecordedClock + RecordedRandom to reproduce the
 * same sequence from recorded artifacts.
 */
function simulateReplayRun(timestamps: number[], nextValues: number[], uuids: string[]): string[] {
  const clock = new RecordedClock(timestamps);
  const rng = new RecordedRandom(nextValues, uuids, "strict");
  const hashSequence: string[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = clock.now();
    const v = rng.next();
    const uuid = rng.uuid();

    const raw = `${ts}:${v.toFixed(15)}:${uuid}`;
    hashSequence.push(raw);
  }

  return hashSequence;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Deterministic replay property", () => {
  it("1000-iteration property: original hash sequence === replay hash sequence", () => {
    // NOTE: this proves byte-identical replay when LLM cache + clock + random
    // are virtualized. Does NOT prove LLM provider determinism.
    const n = 1000;
    const seed = 42;

    const { timestamps, nextValues, uuids, hashSequence: original } = simulateOriginalRun(seed, n);

    const replayed = simulateReplayRun(timestamps, nextValues, uuids);

    expect(replayed).toHaveLength(n);
    expect(replayed).toEqual(original);
  }, 10000); // 10s timeout for 1000 iterations

  it("replay is byte-identical across different seed values", () => {
    for (const seed of [0, 1, 7, 99, 2 ** 31 - 1]) {
      const {
        timestamps,
        nextValues,
        uuids,
        hashSequence: original,
      } = simulateOriginalRun(seed, 50);

      const replayed = simulateReplayRun(timestamps, nextValues, uuids);

      expect(replayed).toEqual(original);
    }
  });

  it("replay fails to match if any timestamp is altered", () => {
    const { timestamps, nextValues, uuids, hashSequence: original } = simulateOriginalRun(42, 10);

    // Corrupt one timestamp
    const corrupted = [...timestamps];
    corrupted[5] = corrupted[5] + 1;

    const replayed = simulateReplayRun(corrupted, nextValues, uuids);

    expect(replayed).not.toEqual(original);
  });

  it("replay fails to match if any random value is altered", () => {
    const { timestamps, nextValues, uuids, hashSequence: original } = simulateOriginalRun(42, 10);

    // Corrupt one next value
    const corrupted = [...nextValues];
    corrupted[3] = corrupted[3] + 0.0001;

    const replayed = simulateReplayRun(timestamps, corrupted, uuids);

    expect(replayed).not.toEqual(original);
  });

  it("crypto() during replay strict → CryptoRandomDuringReplayError", async () => {
    const rng = new RecordedRandom([], [], "strict");
    await expect(rng.crypto(16)).rejects.toThrow(CryptoRandomDuringReplayError);
  });

  it("tolerant mode: crypto() during replay does not throw", async () => {
    const rng = new RecordedRandom([], [], "tolerant");
    const bytes = await rng.crypto(8);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(8);
  });
});
