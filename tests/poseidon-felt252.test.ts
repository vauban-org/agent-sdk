/**
 * Tests for packages/agent-sdk/src/privacy/poseidon-felt252.ts
 *
 * Coverage:
 *   feltMod — positive clamp, zero, negative clamp into [0, P)
 *   poseidonHashBigInt — deterministic, different inputs → different outputs,
 *                        empty input → defined result, single-element
 *   labelToFelt — deterministic, truncates at 31 bytes, distinct labels → distinct felts
 *
 * Ref: test coverage for agent-sdk/privacy/poseidon-felt252.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { feltMod, labelToFelt, poseidonHashBigInt } from "../src/privacy/poseidon-felt252.js";

const FELT252_PRIME = BigInt(
  "3618502788666131213697322783095070105623107215331596699973092056135872020481",
);

// ─── feltMod ──────────────────────────────────────────────────────────────────

describe("feltMod", () => {
  it("returns 0 for 0", () => {
    expect(feltMod(0n)).toBe(0n);
  });

  it("returns value when within [0, P)", () => {
    expect(feltMod(42n)).toBe(42n);
  });

  it("reduces values >= P by mod P", () => {
    const r = feltMod(FELT252_PRIME + 1n);
    expect(r).toBe(1n);
  });

  it("handles negative values by wrapping into [0, P)", () => {
    const r = feltMod(-1n);
    expect(r).toBe(FELT252_PRIME - 1n);
    expect(r).toBeGreaterThanOrEqual(0n);
    expect(r).toBeLessThan(FELT252_PRIME);
  });

  it("result is always in [0, P)", () => {
    const vals = [
      -100n,
      -1n,
      0n,
      1n,
      100n,
      FELT252_PRIME - 1n,
      FELT252_PRIME,
      FELT252_PRIME + 100n,
    ];
    for (const v of vals) {
      const r = feltMod(v);
      expect(r).toBeGreaterThanOrEqual(0n);
      expect(r).toBeLessThan(FELT252_PRIME);
    }
  });
});

// ─── poseidonHashBigInt ───────────────────────────────────────────────────────

describe("poseidonHashBigInt", () => {
  it("is deterministic for the same inputs", () => {
    const inputs = [1n, 2n, 3n];
    expect(poseidonHashBigInt(inputs)).toBe(poseidonHashBigInt(inputs));
  });

  it("produces different results for different inputs", () => {
    expect(poseidonHashBigInt([1n, 2n])).not.toBe(poseidonHashBigInt([1n, 3n]));
    expect(poseidonHashBigInt([1n])).not.toBe(poseidonHashBigInt([2n]));
  });

  it("result is in [0, P)", () => {
    const r = poseidonHashBigInt([123n, 456n]);
    expect(r).toBeGreaterThanOrEqual(0n);
    expect(r).toBeLessThan(FELT252_PRIME);
  });

  it("handles empty input without throwing", () => {
    expect(() => poseidonHashBigInt([])).not.toThrow();
  });

  it("single-element hash returns a defined felt252", () => {
    const r = poseidonHashBigInt([42n]);
    expect(typeof r).toBe("bigint");
  });

  it("order of elements matters", () => {
    expect(poseidonHashBigInt([1n, 2n])).not.toBe(poseidonHashBigInt([2n, 1n]));
  });
});

// ─── labelToFelt ─────────────────────────────────────────────────────────────

describe("labelToFelt", () => {
  it("is deterministic for the same label", () => {
    expect(labelToFelt("hdnt")).toBe(labelToFelt("hdnt"));
  });

  it("produces different felts for different labels", () => {
    expect(labelToFelt("alpha")).not.toBe(labelToFelt("beta"));
  });

  it("result is in [0, P)", () => {
    const r = labelToFelt("test");
    expect(r).toBeGreaterThanOrEqual(0n);
    expect(r).toBeLessThan(FELT252_PRIME);
  });

  it("handles empty string without throwing", () => {
    expect(() => labelToFelt("")).not.toThrow();
    expect(labelToFelt("")).toBe(0n); // empty bytes → 0
  });

  it("truncates at 31 bytes (31-char ASCII = same as 31 bytes)", () => {
    const label31 = "a".repeat(31);
    const label32 = "a".repeat(32);
    // 32nd byte is ignored — same hash as 31
    expect(labelToFelt(label31)).toBe(labelToFelt(label32));
  });
});
