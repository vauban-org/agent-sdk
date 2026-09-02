/**
 * Tests for computeQuality + computeQualityWithBreakdown (SDK 1.8.0).
 *
 * Mirrors the canonical behaviour promoted from forge's
 * src/agents/shared/quality-scoring.ts — ADR-ECO-039.
 */

import { describe, expect, it } from "vitest";
import {
  computeQuality,
  computeQualityOrNull,
  computeQualityWithBreakdown,
  isIdleCycle,
} from "../src/quality/index.js";

describe("computeQuality", () => {
  it("returns 0.5 when no signal is provided", () => {
    expect(computeQuality({})).toBe(0.5);
  });

  describe("customScore override", () => {
    it("bypasses the heuristic and returns the customScore", () => {
      expect(computeQuality({ customScore: 0.95 })).toBe(0.95);
    });

    it("clamps customScore above 1 to 1", () => {
      expect(computeQuality({ customScore: 1.7 })).toBe(1);
    });

    it("clamps customScore below 0 to 0", () => {
      expect(computeQuality({ customScore: -0.3 })).toBe(0);
    });

    it("ignores other signals when customScore is set", () => {
      expect(computeQuality({ customScore: 0.4, errorsEncountered: 5 })).toBe(0.4);
    });

    it("treats NaN customScore as neutral 0.5", () => {
      expect(computeQuality({ customScore: Number.NaN })).toBe(0.5);
    });
  });

  describe("positive single signals", () => {
    it("postsPublished > 0 → +0.2 → 0.7", () => {
      expect(computeQuality({ postsPublished: 1 })).toBeCloseTo(0.7, 10);
    });

    it("threatsBlocked > 0 → +0.3 → 0.8", () => {
      expect(computeQuality({ threatsBlocked: 1 })).toBeCloseTo(0.8, 10);
    });

    it("alertsSent > 0 → +0.1 → 0.6", () => {
      expect(computeQuality({ alertsSent: 1 })).toBeCloseTo(0.6, 10);
    });

    it("invoicesProcessed > 0 → +0.2 → 0.7", () => {
      expect(computeQuality({ invoicesProcessed: 1 })).toBeCloseTo(0.7, 10);
    });

    it("lessons:[x] → +0.05 → 0.55", () => {
      expect(computeQuality({ lessons: ["learned something"] })).toBeCloseTo(0.55, 10);
    });

    it("lessons:[] → no boost → 0.5", () => {
      expect(computeQuality({ lessons: [] })).toBe(0.5);
    });
  });

  describe("negative single signals", () => {
    it("errorsEncountered > 0 → -0.2 → 0.3", () => {
      expect(computeQuality({ errorsEncountered: 1 })).toBeCloseTo(0.3, 10);
    });

    it("postsRejectedByHITL > 0 → -0.1 → 0.4", () => {
      expect(computeQuality({ postsRejectedByHITL: 1 })).toBeCloseTo(0.4, 10);
    });
  });

  describe("mixed signals", () => {
    it("clamps the sum into [0, 1]", () => {
      // 0.5 + 0.2 (posts) + 0.3 (threats) + 0.1 (alerts) + 0.2 (invoices) +
      // 0.05 (lessons) = 1.35 → clamp to 1
      const score = computeQuality({
        postsPublished: 2,
        threatsBlocked: 1,
        alertsSent: 3,
        invoicesProcessed: 1,
        lessons: ["a", "b"],
      });
      expect(score).toBe(1);
    });

    it("clamps to 0 when negatives dominate", () => {
      // 0.5 - 0.2 (errors) - 0.1 (rejects) = 0.2; with no positives → 0.2
      // To force-clamp, layer additional negatives via multiple signals.
      // Heuristic only applies each penalty once → smallest reachable is 0.2.
      // Explicit clamp test: custom override.
      expect(computeQuality({ customScore: -5 })).toBe(0);
    });

    it("combines positive and negative correctly: 0.5 + 0.2 - 0.2 = 0.5", () => {
      expect(computeQuality({ postsPublished: 1, errorsEncountered: 1 })).toBeCloseTo(0.5, 10);
    });

    it("combines lessons + posts: 0.5 + 0.2 + 0.05 = 0.75", () => {
      expect(computeQuality({ postsPublished: 1, lessons: ["x"] })).toBeCloseTo(0.75, 10);
    });
  });

  describe("zero-count signals are no-ops", () => {
    it("does not boost when postsPublished is 0", () => {
      expect(computeQuality({ postsPublished: 0 })).toBe(0.5);
    });

    it("does not penalize when errorsEncountered is 0", () => {
      expect(computeQuality({ errorsEncountered: 0 })).toBe(0.5);
    });
  });
});

describe("computeQualityWithBreakdown", () => {
  it("returns score 0.5 and empty contributions for no signal", () => {
    const result = computeQualityWithBreakdown({});
    expect(result.score).toBe(0.5);
    expect(result.contributions).toEqual([]);
  });

  it("returns single customScore contribution when override is set", () => {
    const result = computeQualityWithBreakdown({ customScore: 0.95 });
    expect(result.score).toBe(0.95);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].signal).toBe("customScore");
    expect(result.contributions[0].delta).toBeCloseTo(0.45, 10);
  });

  it("reflects each non-zero signal in evaluation order", () => {
    // Evaluation order in implementation:
    //   errorsEncountered, postsRejectedByHITL, postsPublished,
    //   threatsBlocked, alertsSent, invoicesProcessed, lessons
    const result = computeQualityWithBreakdown({
      postsPublished: 1,
      errorsEncountered: 2,
      lessons: ["a", "b"],
    });

    expect(result.score).toBeCloseTo(0.55, 10); // 0.5 - 0.2 + 0.2 + 0.05

    const signals = result.contributions.map((c) => c.signal);
    expect(signals).toEqual(["errorsEncountered", "postsPublished", "lessons"]);

    expect(result.contributions[0].delta).toBe(-0.2);
    expect(result.contributions[0].reason).toBe("2 errors encountered");

    expect(result.contributions[1].delta).toBe(0.2);
    expect(result.contributions[1].reason).toBe("1 post published");

    expect(result.contributions[2].delta).toBe(0.05);
    expect(result.contributions[2].reason).toBe("2 lessons extracted");
  });

  it("score matches computeQuality for the same inputs", () => {
    const inputs = {
      postsPublished: 1,
      threatsBlocked: 1,
      alertsSent: 1,
      invoicesProcessed: 1,
      lessons: ["x"],
      errorsEncountered: 1,
      postsRejectedByHITL: 1,
    } as const;
    expect(computeQualityWithBreakdown(inputs).score).toBe(computeQuality(inputs));
  });

  it("singular vs plural reason strings are correct", () => {
    const single = computeQualityWithBreakdown({ postsPublished: 1 });
    expect(single.contributions[0].reason).toBe("1 post published");

    const plural = computeQualityWithBreakdown({ postsPublished: 3 });
    expect(plural.contributions[0].reason).toBe("3 posts published");
  });
});

// ─── Productive Cycle Evidence pattern (SDK 2.25 ; ADR-052 candidate) ────────

describe("isIdleCycle", () => {
  it("returns true on empty inputs", () => {
    expect(isIdleCycle({})).toBe(true);
  });

  it("returns true when workUnits === 0 (explicit)", () => {
    expect(isIdleCycle({ workUnits: 0 })).toBe(true);
  });

  it("returns false when workUnits > 0 (explicit) even with zero per-signal", () => {
    expect(isIdleCycle({ workUnits: 3 })).toBe(false);
  });

  it("returns false when customScore is defined (explicit eval is never idle)", () => {
    expect(isIdleCycle({ customScore: 0.9 })).toBe(false);
    expect(isIdleCycle({ customScore: 0.1 })).toBe(false);
    expect(isIdleCycle({ customScore: 0 })).toBe(false);
  });

  it("returns false when any work-emitting signal is > 0", () => {
    expect(isIdleCycle({ postsPublished: 1 })).toBe(false);
    expect(isIdleCycle({ threatsBlocked: 1 })).toBe(false);
    expect(isIdleCycle({ alertsSent: 1 })).toBe(false);
    expect(isIdleCycle({ invoicesProcessed: 1 })).toBe(false);
  });

  it("returns false when errorsEncountered > 0 (failure is signal)", () => {
    expect(isIdleCycle({ errorsEncountered: 1 })).toBe(false);
  });

  it("returns false when postsRejectedByHITL > 0 (rejection is signal)", () => {
    expect(isIdleCycle({ postsRejectedByHITL: 1 })).toBe(false);
  });

  it("returns true when only lessons are present (reflection alone is not work)", () => {
    expect(isIdleCycle({ lessons: ["lesson 1"] })).toBe(true);
  });

  it("workUnits=0 overrides per-signal counts (explicit beats inferred)", () => {
    // Pathological but allowed : caller declares idle explicitly.
    expect(isIdleCycle({ workUnits: 0, postsPublished: 5 })).toBe(true);
  });
});

describe("computeQualityOrNull", () => {
  it("returns null on idle cycle", () => {
    expect(computeQualityOrNull({})).toBeNull();
    expect(computeQualityOrNull({ workUnits: 0 })).toBeNull();
    expect(computeQualityOrNull({ lessons: ["a"] })).toBeNull();
  });

  it("returns the same score as computeQuality on productive cycle", () => {
    const inputs = { postsPublished: 1 } as const;
    expect(computeQualityOrNull(inputs)).toBe(computeQuality(inputs));
  });

  it("returns customScore even on otherwise-idle cycle", () => {
    expect(computeQualityOrNull({ customScore: 0.95 })).toBe(0.95);
  });

  it("returns the failure score when only errorsEncountered is set", () => {
    const inputs = { errorsEncountered: 1 } as const;
    expect(computeQualityOrNull(inputs)).toBe(0.3);
  });

  it("propagates customScore clamping", () => {
    expect(computeQualityOrNull({ customScore: 1.5 })).toBe(1);
    expect(computeQualityOrNull({ customScore: -0.2 })).toBe(0);
  });

  it("workUnits>0 with no per-signal data scores at the neutral default", () => {
    // Productive but no positive nor negative signal ; same as computeQuality({})
    expect(computeQualityOrNull({ workUnits: 1 })).toBe(0.5);
  });
});
