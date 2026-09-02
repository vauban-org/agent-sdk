/**
 * tests/compute-best-of-n.test.ts
 *
 * Unit tests for the best-of-N compute strategy.
 */

import { describe, expect, it, vi } from "vitest";
import { type BestOfNRewardModel, bestOfNStrategy } from "../src/compute/strategies/best-of-n.js";
import type { ComputeContext } from "../src/compute/types.js";
import type { Verifier, VerifierResult } from "../src/compute/verifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verifier that scores numeric outputs as `out / 10` (clamped). */
function numericVerifier(): Verifier<number> {
  return {
    name: "numeric-test",
    evaluate(out: number): VerifierResult {
      const score = Math.max(0, Math.min(1, out / 10));
      return { score, rationale: `score=${score}` };
    },
  };
}

/** Reward model that returns the output itself (assumed [0,1]). */
function identityRewardModel(): BestOfNRewardModel<number> {
  return {
    score(out: number): number {
      return out;
    },
  };
}

/** Generator that yields a fixed sequence, one element per call. */
function sequenceGenerator(seq: number[]): {
  gen: (input: unknown, ctx: ComputeContext) => Promise<number>;
  callCount: () => number;
  callTimestamps: () => number[];
} {
  let i = 0;
  const stamps: number[] = [];
  return {
    gen: async (_input, _ctx) => {
      const idx = i++;
      stamps.push(performance.now());
      if (idx >= seq.length) {
        throw new Error(`sequenceGenerator exhausted at call ${idx}`);
      }
      return seq[idx] as number;
    },
    callCount: () => i,
    callTimestamps: () => stamps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bestOfNStrategy", () => {
  it("happy path verifier mode N=4 → returns highest-scoring candidate", async () => {
    const strategy = bestOfNStrategy<unknown, number>({ n: 4, verifier: numericVerifier() });
    const { gen } = sequenceGenerator([2, 7, 5, 3]);

    const { result, metadata } = await strategy.run(null, gen);

    expect(result).toBe(7);
    expect(metadata.strategy).toBe("best-of-n");
    expect(metadata.candidates).toBe(4);
    expect(metadata.verifier_scores).toEqual([0.2, 0.7, 0.5, 0.3]);
    expect(metadata.cost.calls).toBe(4);
    expect(metadata.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("happy path rewardModel mode N=3 → returns highest-scoring candidate", async () => {
    const strategy = bestOfNStrategy<unknown, number>({
      n: 3,
      rewardModel: identityRewardModel(),
    });
    const { gen } = sequenceGenerator([0.1, 0.9, 0.4]);

    const { result, metadata } = await strategy.run(null, gen);

    expect(result).toBeCloseTo(0.9);
    expect(metadata.candidates).toBe(3);
    expect(metadata.verifier_scores).toEqual([0.1, 0.9, 0.4]);
    expect(metadata.cost.calls).toBe(3);
  });

  it("ties at top score → first occurrence wins (stable tie-break)", async () => {
    const strategy = bestOfNStrategy<unknown, number>({
      n: 3,
      rewardModel: identityRewardModel(),
    });
    // Two candidates tied at 0.8 → index 0 should win.
    const { gen } = sequenceGenerator([0.8, 0.8, 0.5]);

    const { result, metadata } = await strategy.run(null, gen);

    expect(result).toBe(0.8);
    expect(metadata.verifier_scores).toEqual([0.8, 0.8, 0.5]);
    // Sanity: we cannot directly observe the chosen index, but stable tie-break
    // means result equals candidates[0].
  });

  it("N=1 → degenerates to a single candidate", async () => {
    const strategy = bestOfNStrategy<unknown, number>({ n: 1, verifier: numericVerifier() });
    const { gen, callCount } = sequenceGenerator([4]);

    const { result, metadata } = await strategy.run(null, gen);

    expect(result).toBe(4);
    expect(metadata.candidates).toBe(1);
    expect(metadata.cost.calls).toBe(1);
    expect(callCount()).toBe(1);
  });

  it("n < 1 → throws RangeError", () => {
    expect(() => bestOfNStrategy<unknown, number>({ n: 0, verifier: numericVerifier() })).toThrow(
      RangeError,
    );
    expect(() => bestOfNStrategy<unknown, number>({ n: -2, verifier: numericVerifier() })).toThrow(
      RangeError,
    );
  });

  it("both verifier + rewardModel → throws Error", () => {
    expect(() =>
      bestOfNStrategy<unknown, number>({
        n: 2,
        verifier: numericVerifier(),
        rewardModel: identityRewardModel(),
      }),
    ).toThrow(/exactly one of verifier\|rewardModel/);
  });

  it("neither verifier nor rewardModel → throws Error", () => {
    expect(() => bestOfNStrategy<unknown, number>({ n: 2 })).toThrow(
      /exactly one of verifier\|rewardModel/,
    );
  });

  it("parallel=false → generator called sequentially", async () => {
    const strategy = bestOfNStrategy<unknown, number>({
      n: 3,
      parallel: false,
      rewardModel: identityRewardModel(),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const gen = async (_input: unknown, _ctx: ComputeContext): Promise<number> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a microtask so any concurrent caller would overlap here.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 0.5;
    };

    await strategy.run(null, gen);

    expect(maxInFlight).toBe(1);
  });

  it("parallel=true (default) → generator calls overlap", async () => {
    const strategy = bestOfNStrategy<unknown, number>({
      n: 3,
      rewardModel: identityRewardModel(),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const gen = async (_input: unknown, _ctx: ComputeContext): Promise<number> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 0.5;
    };

    await strategy.run(null, gen);

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("aborted signal at entry → throws and does not call generator", async () => {
    const strategy = bestOfNStrategy<unknown, number>({
      n: 4,
      rewardModel: identityRewardModel(),
    });

    const gen = vi.fn(async (_input: unknown, _ctx: ComputeContext): Promise<number> => 0.5);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(strategy.run(null, gen, { signal: ctrl.signal })).rejects.toThrow();
    expect(gen).not.toHaveBeenCalled();
  });

  it("generator throws on candidate 2 of 4 with parallel=true → overall promise rejects", async () => {
    const strategy = bestOfNStrategy<unknown, number>({
      n: 4,
      rewardModel: identityRewardModel(),
    });

    let i = 0;
    const gen = async (_input: unknown, _ctx: ComputeContext): Promise<number> => {
      const idx = i++;
      if (idx === 1) {
        throw new Error("boom on candidate 2");
      }
      // Slow others so the rejection wins the race deterministically.
      await new Promise((r) => setTimeout(r, 10));
      return 0.1;
    };

    await expect(strategy.run(null, gen)).rejects.toThrow("boom on candidate 2");
  });
});
