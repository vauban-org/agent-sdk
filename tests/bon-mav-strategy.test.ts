/**
 * Tests for packages/agent-sdk/src/compute/strategies/bon-mav.ts
 *
 * Coverage:
 *   bonMavStrategy — validation (n<1, no verifiers, bad aggregation, bad voteThreshold),
 *                    mean/median/min/majority-vote aggregations,
 *                    argmax picks highest aggregated candidate,
 *                    stable tie-break (first wins),
 *                    mavMatrix shape in metadata,
 *                    strategy name includes aggregation mode
 *
 * Ref: test coverage for agent-sdk/compute/strategies/bon-mav.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { bonMavStrategy } from "../src/compute/strategies/bon-mav.js";

function makeVerifier(scores: number[]) {
  let i = 0;
  return {
    evaluate: async (c: unknown) => ({
      score: scores[i++] ?? 0,
      verdict: "pass" as const,
      rationale: "",
      candidate: c,
    }),
  };
}

// ─── Validation ────────────────────────────────────────────────────────────────

describe("bonMavStrategy — validation", () => {
  const v = makeVerifier([1]);

  it("throws RangeError when n < 1", () => {
    expect(() => bonMavStrategy({ n: 0, verifiers: [v] })).toThrow(RangeError);
  });

  it("throws when verifiers array is empty", () => {
    expect(() => bonMavStrategy({ n: 2, verifiers: [] })).toThrow("at least 1 verifier");
  });

  it("throws for unknown aggregation mode", () => {
    expect(() => bonMavStrategy({ n: 2, verifiers: [v], aggregation: "unknown" as never })).toThrow(
      "unknown aggregation",
    );
  });

  it("throws RangeError for voteThreshold outside [0,1]", () => {
    expect(() =>
      bonMavStrategy({
        n: 2,
        verifiers: [v],
        aggregation: "majority-vote",
        voteThreshold: 1.5,
      }),
    ).toThrow(RangeError);
  });
});

// ─── Strategy name ─────────────────────────────────────────────────────────────

describe("bonMavStrategy — strategy name", () => {
  it("includes aggregation mode in name", () => {
    const s = bonMavStrategy({
      n: 1,
      verifiers: [makeVerifier([1])],
      aggregation: "median",
    });
    expect(s.name).toContain("median");
    expect(s.name).toContain("bon-mav");
  });
});

// ─── Aggregation modes ─────────────────────────────────────────────────────────

describe("bonMavStrategy — aggregation modes", () => {
  const gen = async () => "x";

  it("mean: averages verifier scores per candidate", async () => {
    // 2 candidates, 2 verifiers: cand0 = [0.4, 0.6]=0.5, cand1 = [0.8, 0.9]=0.85
    const v1 = makeVerifier([0.4, 0.8]);
    const v2 = makeVerifier([0.6, 0.9]);
    const strategy = bonMavStrategy({
      n: 2,
      verifiers: [v1, v2],
      aggregation: "mean",
    });
    let call = 0;
    const { result, metadata } = await strategy.run({}, async () => call++);
    expect(result).toBe(1); // cand1 has higher mean
    expect(metadata.verifier_scores[0]).toBeCloseTo(0.5);
    expect(metadata.verifier_scores[1]).toBeCloseTo(0.85);
  });

  it("min: uses minimum verifier score per candidate", async () => {
    // cand0: min(0.9, 0.1)=0.1, cand1: min(0.7, 0.8)=0.7 → cand1 wins
    const v1 = makeVerifier([0.9, 0.7]);
    const v2 = makeVerifier([0.1, 0.8]);
    const strategy = bonMavStrategy({
      n: 2,
      verifiers: [v1, v2],
      aggregation: "min",
    });
    let call = 0;
    const { result } = await strategy.run({}, async () => call++);
    expect(result).toBe(1);
  });

  it("median: uses median of verifier scores", async () => {
    // 3 verifiers: cand0 = [0.1, 0.5, 0.9] → median 0.5, cand1 = [0.6, 0.7, 0.8] → median 0.7
    const v1 = makeVerifier([0.1, 0.6]);
    const v2 = makeVerifier([0.5, 0.7]);
    const v3 = makeVerifier([0.9, 0.8]);
    const strategy = bonMavStrategy({
      n: 2,
      verifiers: [v1, v2, v3],
      aggregation: "median",
    });
    let call = 0;
    const { result } = await strategy.run({}, async () => call++);
    expect(result).toBe(1);
  });

  it("majority-vote: counts verifiers scoring >= threshold", async () => {
    // threshold 0.5: cand0 = [0.3, 0.6] → 1/2=0.5, cand1 = [0.7, 0.8] → 2/2=1.0 → cand1 wins
    const v1 = makeVerifier([0.3, 0.7]);
    const v2 = makeVerifier([0.6, 0.8]);
    const strategy = bonMavStrategy({
      n: 2,
      verifiers: [v1, v2],
      aggregation: "majority-vote",
      voteThreshold: 0.5,
    });
    let call = 0;
    const { result } = await strategy.run({}, async () => call++);
    expect(result).toBe(1);
  });
});

// ─── mavMatrix shape ──────────────────────────────────────────────────────────

describe("bonMavStrategy — metadata", () => {
  it("mavMatrix has shape [N][M]", async () => {
    const v1 = makeVerifier([0.5, 0.6, 0.7]);
    const v2 = makeVerifier([0.8, 0.9, 1.0]);
    const strategy = bonMavStrategy({ n: 3, verifiers: [v1, v2] });
    const { metadata } = await strategy.run({}, async () => "x");
    expect(metadata.mavMatrix).toHaveLength(3);
    for (const row of metadata.mavMatrix) {
      expect(row).toHaveLength(2);
    }
    expect(metadata.candidates).toBe(3);
    expect(metadata.cost.calls).toBe(3);
  });

  it("stable tie-break: first candidate wins on equal aggregated scores", async () => {
    const v1 = makeVerifier([0.5, 0.5, 0.5]);
    const strategy = bonMavStrategy({ n: 3, verifiers: [v1] });
    let call = 0;
    const { result } = await strategy.run({}, async () => call++);
    expect(result).toBe(0);
  });
});
