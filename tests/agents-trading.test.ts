/**
 * Unit tests — agents/trading module (SDK v0.7.1 — sprint-526 Bloc 5b)
 *
 * Tests cover computeKellyFraction: bootstrap path, Kelly path, negative
 * kelly clamping, and divide-by-zero protection.
 */
import { describe, expect, it } from "vitest";
import { computeKellyFraction } from "../src/agents/trading.js";

const BASE_CONFIG = {
  kelly_cap: 0.25,
  kelly_bootstrap_fraction: 0.02,
  bootstrap_trade_threshold: 20,
};

describe("computeKellyFraction", () => {
  describe("bootstrap path (historicalCount < 20)", () => {
    it("returns bootstrap_fraction and mode='bootstrap' when count=0", () => {
      const result = computeKellyFraction(0, 0.05, 0.01, BASE_CONFIG);
      expect(result.mode).toBe("bootstrap");
      expect(result.fraction).toBe(0.02);
    });

    it("returns bootstrap_fraction when count=19 (threshold boundary)", () => {
      const result = computeKellyFraction(19, 0.1, 0.02, BASE_CONFIG);
      expect(result.mode).toBe("bootstrap");
      expect(result.fraction).toBe(0.02);
    });
  });

  describe("Kelly path (historicalCount >= 20)", () => {
    it("returns kelly value capped at kelly_cap when count=20", () => {
      // kelly = 0.10 / 0.01 = 10 → capped at 0.25
      const result = computeKellyFraction(20, 0.1, 0.01, BASE_CONFIG);
      expect(result.mode).toBe("kelly");
      expect(result.fraction).toBe(0.25);
    });

    it("returns uncapped kelly when value is within cap", () => {
      // kelly = 0.02 / 0.1 = 0.20 → within cap of 0.25
      const result = computeKellyFraction(50, 0.02, 0.1, BASE_CONFIG);
      expect(result.mode).toBe("kelly");
      expect(result.fraction).toBeCloseTo(0.2, 10);
    });

    it("returns kelly_cap when computed fraction exceeds cap", () => {
      // kelly = 100 / 0.01 = 10_000 → capped at 0.25
      const result = computeKellyFraction(100, 100, 0.01, BASE_CONFIG);
      expect(result.mode).toBe("kelly");
      expect(result.fraction).toBe(0.25);
    });
  });

  describe("negative Kelly (negative expected return)", () => {
    it("clamps to fraction=0 (never short via Kelly formula)", () => {
      // kelly = -0.05 / 0.01 = -5 → clamped to 0
      const result = computeKellyFraction(30, -0.05, 0.01, BASE_CONFIG);
      expect(result.mode).toBe("kelly");
      expect(result.fraction).toBe(0);
    });
  });

  describe("divide-by-zero protection (variance=0)", () => {
    it("uses 1e-9 floor so no NaN or Infinity is returned", () => {
      // kelly = 0.05 / 1e-9 = 5e7 → capped at 0.25
      const result = computeKellyFraction(30, 0.05, 0, BASE_CONFIG);
      expect(result.mode).toBe("kelly");
      expect(Number.isFinite(result.fraction)).toBe(true);
      expect(result.fraction).toBe(0.25);
    });

    it("handles negative expected return + zero variance cleanly", () => {
      // kelly = -0.05 / 1e-9 → very negative → clamped to 0
      const result = computeKellyFraction(30, -0.05, 0, BASE_CONFIG);
      expect(result.mode).toBe("kelly");
      expect(result.fraction).toBe(0);
    });
  });
});
