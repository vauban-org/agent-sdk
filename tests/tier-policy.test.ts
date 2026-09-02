import { describe, expect, it } from "vitest";
import { DefaultTierPolicy, type ModelTier, type TierPolicy } from "../src/economy/tier-policy.js";

describe("DefaultTierPolicy", () => {
  const policy = new DefaultTierPolicy();

  describe("degraded mode — category routing", () => {
    it('routes "simple" → [free, cheap]', () => {
      const tiers = policy.tiersFor("simple", "degraded");
      expect(tiers).toHaveLength(2);
      expect(tiers[0]?.label).toBe("free");
      expect(tiers[1]?.label).toBe("cheap");
    });

    it('routes "standard" → [cheap, mid]', () => {
      const tiers = policy.tiersFor("standard", "degraded");
      expect(tiers).toHaveLength(2);
      expect(tiers[0]?.label).toBe("cheap");
      expect(tiers[1]?.label).toBe("mid");
    });

    it('routes "complex" → [mid, premium]', () => {
      const tiers = policy.tiersFor("complex", "degraded");
      expect(tiers).toHaveLength(2);
      expect(tiers[0]?.label).toBe("mid");
      expect(tiers[1]?.label).toBe("premium");
    });

    it('routes "reasoning" → [premium]', () => {
      const tiers = policy.tiersFor("reasoning", "degraded");
      expect(tiers).toHaveLength(1);
      expect(tiers[0]?.label).toBe("premium");
    });

    it("falls back to [cheap, mid] for unknown category", () => {
      const tiers = policy.tiersFor("unknown-category", "degraded");
      expect(tiers).toHaveLength(2);
      expect(tiers[0]?.label).toBe("cheap");
      expect(tiers[1]?.label).toBe("mid");
    });
  });

  describe("full mode — same tiers (router owns re-ordering)", () => {
    it('returns same candidates as degraded for "simple"', () => {
      const degraded = policy.tiersFor("simple", "degraded");
      const full = policy.tiersFor("simple", "full");
      expect(full.map((t) => t.label)).toEqual(degraded.map((t) => t.label));
    });

    it('returns same candidates as degraded for "reasoning"', () => {
      const degraded = policy.tiersFor("reasoning", "degraded");
      const full = policy.tiersFor("reasoning", "full");
      expect(full.map((t) => t.label)).toEqual(degraded.map((t) => t.label));
    });
  });

  describe("catalog integrity", () => {
    it("each tier has finite non-negative cost fields", () => {
      const categories = ["simple", "standard", "complex", "reasoning"];
      for (const cat of categories) {
        const tiers = policy.tiersFor(cat, "degraded");
        for (const tier of tiers) {
          expect(tier.costPerMTokenIn).toBeGreaterThanOrEqual(0);
          expect(tier.costPerMTokenOut).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(tier.costPerMTokenIn)).toBe(true);
          expect(Number.isFinite(tier.costPerMTokenOut)).toBe(true);
        }
      }
    });

    it("returns copies (mutation-safe)", () => {
      const tiers = policy.tiersFor("simple", "degraded");
      tiers.push({
        provider: "injected",
        model: "evil",
        costPerMTokenIn: 999,
        costPerMTokenOut: 999,
        label: "premium",
      });
      const tiersAgain = policy.tiersFor("simple", "degraded");
      expect(tiersAgain).toHaveLength(2);
    });
  });
});

describe("Custom TierPolicy — consumer override", () => {
  const customTier: ModelTier = {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    costPerMTokenIn: 0.25,
    costPerMTokenOut: 1.25,
    label: "cheap",
  };

  class CustomPolicy implements TierPolicy {
    tiersFor(_category: string, _mode: "degraded" | "full"): ModelTier[] {
      return [customTier];
    }
  }

  it("overrides default policy completely", () => {
    const policy = new CustomPolicy();
    const tiers = policy.tiersFor("simple", "degraded");
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.provider).toBe("anthropic");
    expect(tiers[0]?.model).toBe("claude-haiku-4-5");
  });

  it("applies to every category", () => {
    const policy = new CustomPolicy();
    for (const cat of ["simple", "standard", "complex", "reasoning"]) {
      const tiers = policy.tiersFor(cat, "full");
      expect(tiers[0]?.label).toBe("cheap");
    }
  });
});
