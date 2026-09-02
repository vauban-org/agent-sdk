/**
 * tests/compute-bon-mav.test.ts
 *
 * Unit tests for BoN-MAV (Best-of-N with Multi-Agent Verification).
 * Reference: Lifshitz et al. 2025, arXiv:2502.20379.
 *
 * Golden, deterministic — no LLM calls. Verifiers and generator are pure
 * functions of the candidate index, so the score matrix is fully predictable.
 */

import { describe, expect, it } from "vitest";
import { bonMavStrategy } from "../src/compute/strategies/bon-mav.js";
import type { ComputeContext } from "../src/compute/types.js";
import type { Verifier } from "../src/compute/verifier.js";

// ---------------------------------------------------------------------------
// Helpers — deterministic generators and verifiers
// ---------------------------------------------------------------------------

/**
 * Generator that emits candidates labelled by their generation order.
 * Each call increments a shared counter so we can correlate verifier scores
 * with candidate identity.
 */
function makeIndexedGenerator(): (
  input: string,
  ctx: ComputeContext,
) => Promise<{ id: number; tag: string }> {
  let i = 0;
  return async (input, ctx) => {
    if (ctx.signal?.aborted) throw new Error("aborted");
    const id = i++;
    return { id, tag: `${input}#${id}` };
  };
}

/**
 * Static-score verifier: returns one of `scoresPerCandidate` indexed by the
 * candidate's `id` field. Lets us hand-craft the N×M matrix.
 */
function makeStaticVerifier(
  name: string,
  scoresPerCandidate: readonly number[],
): Verifier<{ id: number; tag: string }> {
  return {
    name,
    evaluate: (output) => ({
      score: scoresPerCandidate[output.id],
      rationale: `${name}@${output.id}=${scoresPerCandidate[output.id]}`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bonMavStrategy", () => {
  // ── Algorithm correctness ────────────────────────────────────────────────

  it("mean aggregation: N=4, M=3 picks the candidate with highest mean", async () => {
    // Matrix (rows = candidates, cols = verifiers)
    // C0: 0.4, 0.5, 0.6 → mean 0.5
    // C1: 0.9, 0.8, 0.7 → mean 0.8 ← winner
    // C2: 0.3, 0.4, 0.5 → mean 0.4
    // C3: 0.7, 0.7, 0.6 → mean 0.666...
    const v1 = makeStaticVerifier("v1", [0.4, 0.9, 0.3, 0.7]);
    const v2 = makeStaticVerifier("v2", [0.5, 0.8, 0.4, 0.7]);
    const v3 = makeStaticVerifier("v3", [0.6, 0.7, 0.5, 0.6]);

    const strategy = bonMavStrategy<string, { id: number; tag: string }>({
      n: 4,
      verifiers: [v1, v2, v3],
      aggregation: "mean",
    });

    const { result, metadata } = await strategy.run("q", makeIndexedGenerator());

    expect(result.id).toBe(1);
    expect(metadata.candidates).toBe(4);
    expect(metadata.aggregation).toBe("mean");
    expect(metadata.strategy).toBe("bon-mav-mean");
    expect(metadata.verifier_scores).toHaveLength(4);
    expect(metadata.verifier_scores[1]).toBeCloseTo(0.8, 10);
    expect(metadata.cost.calls).toBe(4);
  });

  it("median aggregation picks a different winner than mean when an outlier exists", async () => {
    // C0 scores: 1.0, 0.0, 0.0 → mean ~0.333, median 0.0
    // C1 scores: 0.5, 0.5, 0.5 → mean 0.5,    median 0.5 ← winner under median
    // Under mean, C1 (0.5) > C0 (0.333) so same winner. We need a different setup.
    //
    // C0: 1.0, 1.0, 0.0 → mean 0.666, median 1.0 ← winner under median
    // C1: 0.7, 0.7, 0.7 → mean 0.7,   median 0.7  ← winner under mean
    const v1 = makeStaticVerifier("v1", [1.0, 0.7]);
    const v2 = makeStaticVerifier("v2", [1.0, 0.7]);
    const v3 = makeStaticVerifier("v3", [0.0, 0.7]);

    const meanRes = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [v1, v2, v3],
      aggregation: "mean",
    }).run("q", makeIndexedGenerator());
    expect(meanRes.result.id).toBe(1);

    const medRes = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [v1, v2, v3],
      aggregation: "median",
    }).run("q", makeIndexedGenerator());
    expect(medRes.result.id).toBe(0);
    expect(medRes.metadata.verifier_scores).toEqual([1.0, 0.7]);
  });

  it("min (conservative) selects highest worst-case", async () => {
    // C0: 0.9, 0.9, 0.1 → min 0.1
    // C1: 0.6, 0.6, 0.6 → min 0.6 ← winner
    // C2: 1.0, 1.0, 0.5 → min 0.5
    const v1 = makeStaticVerifier("v1", [0.9, 0.6, 1.0]);
    const v2 = makeStaticVerifier("v2", [0.9, 0.6, 1.0]);
    const v3 = makeStaticVerifier("v3", [0.1, 0.6, 0.5]);

    const { result, metadata } = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 3,
      verifiers: [v1, v2, v3],
      aggregation: "min",
    }).run("q", makeIndexedGenerator());

    expect(result.id).toBe(1);
    expect(metadata.verifier_scores).toEqual([0.1, 0.6, 0.5]);
  });

  it("majority-vote with threshold 0.5: 2/3 verifiers approve → 0.6666...", async () => {
    // C0: 0.6, 0.7, 0.4 → votes = 2 → 2/3
    // C1: 0.4, 0.4, 0.4 → votes = 0 → 0
    const v1 = makeStaticVerifier("v1", [0.6, 0.4]);
    const v2 = makeStaticVerifier("v2", [0.7, 0.4]);
    const v3 = makeStaticVerifier("v3", [0.4, 0.4]);

    const { result, metadata } = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [v1, v2, v3],
      aggregation: "majority-vote",
      voteThreshold: 0.5,
    }).run("q", makeIndexedGenerator());

    expect(result.id).toBe(0);
    expect(metadata.verifier_scores[0]).toBeCloseTo(2 / 3, 10);
    expect(metadata.verifier_scores[1]).toBe(0);
    expect(metadata.strategy).toBe("bon-mav-majority-vote");
  });

  it("ties: returns the first-occurring candidate", async () => {
    // All candidates score identically → first wins (id=0).
    const v1 = makeStaticVerifier("v1", [0.5, 0.5, 0.5]);
    const v2 = makeStaticVerifier("v2", [0.5, 0.5, 0.5]);

    const { result } = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 3,
      verifiers: [v1, v2],
      aggregation: "mean",
    }).run("q", makeIndexedGenerator());

    expect(result.id).toBe(0);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("throws RangeError when n < 1", () => {
    const v = makeStaticVerifier("v", [0]);
    expect(() => bonMavStrategy({ n: 0, verifiers: [v] })).toThrow(RangeError);
    expect(() => bonMavStrategy({ n: -1, verifiers: [v] })).toThrow(RangeError);
    expect(() => bonMavStrategy({ n: 1.5, verifiers: [v] })).toThrow(RangeError);
  });

  it("throws when verifiers is empty", () => {
    expect(() => bonMavStrategy({ n: 4, verifiers: [] })).toThrow(/at least 1 verifier/);
  });

  it("throws when aggregation is unknown", () => {
    const v = makeStaticVerifier("v", [0]);
    expect(() =>
      bonMavStrategy({
        n: 1,
        verifiers: [v],
        aggregation: "weird" as unknown as "mean",
      }),
    ).toThrow(/unknown aggregation/);
  });

  it("throws RangeError when voteThreshold is out of [0,1]", () => {
    const v = makeStaticVerifier("v", [0]);
    expect(() => bonMavStrategy({ n: 1, verifiers: [v], voteThreshold: 1.5 })).toThrow(RangeError);
    expect(() => bonMavStrategy({ n: 1, verifiers: [v], voteThreshold: -0.1 })).toThrow(RangeError);
  });

  // ── Cancellation & failures ──────────────────────────────────────────────

  it("AbortSignal aborts before generator runs", async () => {
    const v = makeStaticVerifier("v", [0.5, 0.5]);
    const strategy = bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [v],
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      strategy.run("q", makeIndexedGenerator(), { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("AbortSignal aborts during sequential candidate generation", async () => {
    const v = makeStaticVerifier("v", [0.5, 0.5, 0.5]);
    const controller = new AbortController();

    const generator = async (
      _input: string,
      ctx: ComputeContext,
    ): Promise<{ id: number; tag: string }> => {
      if (ctx.signal?.aborted) throw new Error("aborted-mid");
      // Abort after the first candidate so the second sees aborted.
      controller.abort();
      return { id: 0, tag: "first" };
    };

    const strategy = bonMavStrategy<string, { id: number; tag: string }>({
      n: 3,
      verifiers: [v],
      parallel: false,
    });

    await expect(strategy.run("q", generator, { signal: controller.signal })).rejects.toThrow();
  });

  it("verifier rejection bubbles up as strategy failure", async () => {
    const failing: Verifier<{ id: number; tag: string }> = {
      name: "boom",
      evaluate: async () => {
        throw new Error("verifier exploded");
      },
    };

    const strategy = bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [failing],
    });

    await expect(strategy.run("q", makeIndexedGenerator())).rejects.toThrow("verifier exploded");
  });

  // ── Metadata shape ───────────────────────────────────────────────────────

  it("metadata: mavMatrix is N×M; aggregated scores in [0,1] for [0,1] inputs", async () => {
    const v1 = makeStaticVerifier("v1", [0.2, 0.4, 0.6]);
    const v2 = makeStaticVerifier("v2", [0.3, 0.5, 0.7]);
    const v3 = makeStaticVerifier("v3", [0.4, 0.6, 0.8]);
    const v4 = makeStaticVerifier("v4", [0.1, 0.5, 0.9]);

    const { metadata } = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 3,
      verifiers: [v1, v2, v3, v4],
      aggregation: "mean",
    }).run("q", makeIndexedGenerator());

    expect(metadata.mavMatrix).toHaveLength(3);
    for (const row of metadata.mavMatrix) {
      expect(row).toHaveLength(4);
    }
    expect(metadata.mavMatrix[0]).toEqual([0.2, 0.3, 0.4, 0.1]);
    expect(metadata.mavMatrix[2]).toEqual([0.6, 0.7, 0.8, 0.9]);
    expect(metadata.verifier_scores).toHaveLength(3);
    for (const s of metadata.verifier_scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(metadata.cost.calls).toBe(3);
    expect(metadata.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("sequential mode (parallel=false) produces identical results to parallel", async () => {
    const v1 = makeStaticVerifier("v1", [0.1, 0.9]);
    const v2 = makeStaticVerifier("v2", [0.2, 0.8]);

    const par = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [v1, v2],
      parallel: true,
    }).run("q", makeIndexedGenerator());

    const seq = await bonMavStrategy<string, { id: number; tag: string }>({
      n: 2,
      verifiers: [v1, v2],
      parallel: false,
    }).run("q", makeIndexedGenerator());

    expect(par.result.id).toBe(seq.result.id);
    expect(par.metadata.mavMatrix).toEqual(seq.metadata.mavMatrix);
  });
});
