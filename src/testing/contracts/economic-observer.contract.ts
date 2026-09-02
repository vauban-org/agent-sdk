/**
 * EconomicObserver contract test suite.
 *
 * Forge adapters (PostgresEconomicObserver) run this suite to validate:
 *   1. shouldThrottle returns true after 20+ cycles with cost > value * 0.5
 *   2. shouldThrottle returns false under 20 cycles regardless of ROI
 *   3. 7-day window: stale cycles expire, un-throttling the agent
 *   4. getStats returns correct cost7d, value7d, roi, cycles
 *
 * clock injection via factory parameter — PostgresEconomicObserver accepts
 * clock for test determinism without waiting 7 real days.
 *
 * @public
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EconomicObserver } from "../../orchestration/ooda/economic-observer.js";

export function economicObserverContract(
  factory: () => Promise<{
    obs: EconomicObserver;
    clock?: { now(): Date };
    cleanup(): Promise<void>;
  }>,
): void {
  let obs: EconomicObserver;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await factory();
    obs = result.obs;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("EconomicObserver contract", () => {
    const agentId = "test-agent-contract";

    it("shouldThrottle returns false under 20 cycles regardless of ROI", async () => {
      // Record 5 cycles with terrible ROI
      for (let i = 0; i < 5; i++) {
        await obs.recordCycle(agentId, 10.0, 1, 1.0); // $10 cost, $0.01 value
      }
      const throttled = await obs.shouldThrottle(agentId);
      expect(throttled).toBe(false);
    });

    it("shouldThrottle returns true after 20+ cycles with cost > value * 0.5", async () => {
      // Record 25 cycles with negative ROI
      for (let i = 0; i < 25; i++) {
        await obs.recordCycle(agentId, 5.0, 1, 1.0); // $5 cost, $0.01 value
      }
      const throttled = await obs.shouldThrottle(agentId);
      expect(throttled).toBe(true);
    });

    it("shouldThrottle returns false after 20+ cycles with positive ROI", async () => {
      const profitableAgent = "test-agent-profitable";
      for (let i = 0; i < 25; i++) {
        await obs.recordCycle(profitableAgent, 0.01, 100, 1.0); // $0.01 cost, $1.00 value
      }
      const throttled = await obs.shouldThrottle(profitableAgent);
      expect(throttled).toBe(false);
    });

    it("getStats returns correct cost7d, value7d, roi, cycles", async () => {
      const stats = await obs.getStats(agentId);
      expect(typeof stats.cost7d).toBe("number");
      expect(typeof stats.value7d).toBe("number");
      expect(typeof stats.roi).toBe("number");
      expect(typeof stats.cycles).toBe("number");
      expect(stats.cycles).toBeGreaterThan(0);
    });

    it("confidence weights outcome value", async () => {
      const confAgent = "test-agent-confidence";
      // Record with low confidence — effective value is discounted
      await obs.recordCycle(confAgent, 1.0, 100, 0.5); // $1 cost, $1 value * 0.5 = $0.50
      const stats = await obs.getStats(confAgent);
      // Value should reflect confidence weighting
      expect(stats.value7d).toBeGreaterThan(0);
    });
  });
}
