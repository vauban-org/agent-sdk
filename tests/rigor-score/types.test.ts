/**
 * Tests for packages/agent-sdk/src/rigor-score/types.ts ; wave-2 MOVE#9.
 *
 * Coverage: the renormalized 3-pillar weight constants sum to 1 (the guard
 * the design brief calls out explicitly), match the published renormalization,
 * and the honest pillar-count constants (3 scored of RigorBench's published 5)
 * are exactly what every consumer (the composite scorer, the CLI HUD line)
 * relies on to never present a bare "N/100" as if it were the full benchmark.
 */
import { describe, expect, it } from "vitest";
import {
  RIGORBENCH_PILLARS_SCORED,
  RIGORBENCH_PILLARS_TOTAL,
  RIGOR_PILLAR_WEIGHTS,
} from "../../src/rigor-score/types.js";

describe("RIGOR_PILLAR_WEIGHTS", () => {
  it("sums to 1 across the 3 renormalized pillars (guard)", () => {
    const sum =
      RIGOR_PILLAR_WEIGHTS.verificationCoverage +
      RIGOR_PILLAR_WEIGHTS.recoveryEfficiency +
      RIGOR_PILLAR_WEIGHTS.atomicTransitionIntegrity;
    expect(sum).toBeCloseTo(1, 9);
  });

  it("matches the published renormalization (VC 0.3846 / RE 0.3846 / ATI 0.2308)", () => {
    // Renormalized from RigorBench's full-5-pillar weights (VC 0.25, RE 0.25,
    // ATI 0.15) over the 0.65 scored subset: 0.25/0.65 = 5/13, 0.15/0.65 = 3/13.
    expect(RIGOR_PILLAR_WEIGHTS.verificationCoverage).toBe(0.3846);
    expect(RIGOR_PILLAR_WEIGHTS.recoveryEfficiency).toBe(0.3846);
    expect(RIGOR_PILLAR_WEIGHTS.atomicTransitionIntegrity).toBe(0.2308);
  });
});

describe("honest pillar-count constants", () => {
  it("scores exactly 3 of RigorBench's published 5 pillars ; never a bare N/100", () => {
    expect(RIGORBENCH_PILLARS_SCORED).toBe(3);
    expect(RIGORBENCH_PILLARS_TOTAL).toBe(5);
  });
});
