/**
 * Tests for RandomPort implementations.
 *
 * Coverage:
 *   - RealRandom(seed=42).next() x10 → deterministic sequence (snapshot).
 *   - Two RealRandom(seed=42) instances produce identical sequences.
 *   - RealRandom.crypto(16) returns a 16-byte Uint8Array (non-deterministic across calls).
 *   - RecordedRandom next()/uuid() replay from recorded arrays.
 *   - RecordedRandom strict mode: crypto() throws CryptoRandomDuringReplayError.
 *   - RecordedRandom tolerant mode: crypto() returns fresh bytes without throwing.
 */

import { describe, expect, it } from "vitest";
import { CryptoRandomDuringReplayError, RealRandom, RecordedRandom } from "../src/replay/random.js";

describe("RealRandom", () => {
  it("next() x10 with seed=42 produces a deterministic sequence", () => {
    const rng = new RealRandom(42);
    const values = Array.from({ length: 10 }, () => rng.next());

    // Snapshot: exact values depend on xorshift32(42) chain.
    // We verify determinism by comparing two seeded instances.
    const rng2 = new RealRandom(42);
    const values2 = Array.from({ length: 10 }, () => rng2.next());

    expect(values).toEqual(values2);
    expect(values).toHaveLength(10);
    // All values must be in [0, 1)
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("two RealRandom(seed=42) instances produce identical sequences", () => {
    const rngA = new RealRandom(42);
    const rngB = new RealRandom(42);

    for (let i = 0; i < 20; i++) {
      expect(rngA.next()).toBe(rngB.next());
    }
  });

  it("different seeds produce different sequences", () => {
    const rngA = new RealRandom(42);
    const rngB = new RealRandom(99);

    const seqA = Array.from({ length: 5 }, () => rngA.next());
    const seqB = Array.from({ length: 5 }, () => rngB.next());

    // Extremely unlikely to be identical
    expect(seqA).not.toEqual(seqB);
  });

  it("uuid() with same seed produces identical UUIDs across instances", () => {
    const rngA = new RealRandom(42);
    const rngB = new RealRandom(42);

    expect(rngA.uuid()).toBe(rngB.uuid());
    expect(rngA.uuid()).toBe(rngB.uuid());
  });

  it("uuid() output matches v4 UUID format", () => {
    const rng = new RealRandom(42);
    const id = rng.uuid();

    // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("crypto(16) returns a 16-byte Uint8Array", async () => {
    const rng = new RealRandom(42);
    const bytes = await rng.crypto(16);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(16);
  });

  it("crypto() returns non-deterministic bytes across calls (almost certainly)", async () => {
    const rng = new RealRandom(42);
    const a = await rng.crypto(16);
    const b = await rng.crypto(16);

    // Not guaranteed but astronomically unlikely to collide
    expect(a).not.toEqual(b);
  });

  it("cryptoUuid() returns a valid UUID v4", () => {
    const rng = new RealRandom(42);
    const id = rng.cryptoUuid();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("zero seed is handled gracefully (coerced to non-zero internally)", () => {
    // xorshift32 must not start with 0 or it gets stuck at 0 forever
    const rng = new RealRandom(0);
    const values = Array.from({ length: 5 }, () => rng.next());

    // All values must be in [0, 1) — if seed=0 is not handled, all would be 0
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // Values should not all be 0
    expect(values.some((v) => v !== 0)).toBe(true);
  });
});

describe("RecordedRandom", () => {
  it("next() replays values from recordedNext in order", () => {
    const recorded = [0.1, 0.5, 0.9];
    const rng = new RecordedRandom(recorded, []);

    expect(rng.next()).toBe(0.1);
    expect(rng.next()).toBe(0.5);
    expect(rng.next()).toBe(0.9);
  });

  it("uuid() replays values from recordedUuids in order", () => {
    const uuids = ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"];
    const rng = new RecordedRandom([], uuids);

    expect(rng.uuid()).toBe(uuids[0]);
    expect(rng.uuid()).toBe(uuids[1]);
  });

  it("next() throws RangeError when recorded array is exhausted", () => {
    const rng = new RecordedRandom([0.5], []);
    rng.next();

    expect(() => rng.next()).toThrow(RangeError);
  });

  it("uuid() throws RangeError when recorded array is exhausted", () => {
    const rng = new RecordedRandom([], ["some-uuid"]);
    rng.uuid();

    expect(() => rng.uuid()).toThrow(RangeError);
  });

  it("CRITICAL: crypto() throws CryptoRandomDuringReplayError in strict mode", async () => {
    const rng = new RecordedRandom([], [], "strict");

    await expect(rng.crypto(16)).rejects.toThrow(CryptoRandomDuringReplayError);
  });

  it("CRITICAL: cryptoUuid() throws CryptoRandomDuringReplayError in strict mode", () => {
    const rng = new RecordedRandom([], [], "strict");

    expect(() => rng.cryptoUuid()).toThrow(CryptoRandomDuringReplayError);
  });

  it("CryptoRandomDuringReplayError has correct name and message", async () => {
    const rng = new RecordedRandom([], [], "strict");

    let err: CryptoRandomDuringReplayError | undefined;
    try {
      await rng.crypto(8);
    } catch (e) {
      err = e as CryptoRandomDuringReplayError;
    }

    expect(err).toBeInstanceOf(CryptoRandomDuringReplayError);
    expect(err?.name).toBe("CryptoRandomDuringReplayError");
    expect(err?.message).toContain("NON-REPLAY-SAFE");
  });

  it("crypto() does NOT throw in tolerant mode — returns fresh bytes", async () => {
    const rng = new RecordedRandom([], [], "tolerant");

    const bytes = await rng.crypto(16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(16);
  });

  it("cryptoUuid() does NOT throw in tolerant mode — returns valid UUID", () => {
    const rng = new RecordedRandom([], [], "tolerant");

    const id = rng.cryptoUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("default mode is strict", async () => {
    // No mode argument → should throw on crypto()
    const rng = new RecordedRandom([], []);
    await expect(rng.crypto(8)).rejects.toThrow(CryptoRandomDuringReplayError);
  });
});
