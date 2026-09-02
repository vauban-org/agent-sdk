/**
 * Tests for compute strategies: single-shot, best-of-n
 *
 * Coverage:
 *   singleShotStrategy — invokes generator once, returns result, metadata shape
 *   bestOfNStrategy — validation errors (n<1, both/neither scorer),
 *                     picks highest scoring candidate (verifier + rewardModel),
 *                     stable tie-break (first candidate wins), parallel vs sequential,
 *                     metadata.candidates and verifier_scores populated
 *
 * Ref: test coverage for agent-sdk/compute/strategies/* (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { bestOfNStrategy } from "../src/compute/strategies/best-of-n.js";
import { singleShotStrategy } from "../src/compute/strategies/single-shot.js";

// ─── singleShotStrategy ───────────────────────────────────────────────────────

describe("singleShotStrategy", () => {
  it("invokes the generator exactly once", async () => {
    const gen = vi.fn().mockResolvedValue("output");
    const strategy = singleShotStrategy<string, string>();
    await strategy.run("input", gen);
    expect(gen).toHaveBeenCalledOnce();
    expect(gen).toHaveBeenCalledWith("input", {});
  });

  it("returns the generator result", async () => {
    const strategy = singleShotStrategy<number, number>();
    const { result } = await strategy.run(42, async (n) => n * 2);
    expect(result).toBe(84);
  });

  it("returns correct metadata shape", async () => {
    const strategy = singleShotStrategy();
    const { metadata } = await strategy.run("x", async () => "y");
    expect(metadata.strategy).toBe("single-shot");
    expect(metadata.candidates).toBe(1);
    expect(metadata.verifier_scores).toEqual([]);
    expect(metadata.cost.calls).toBe(1);
    expect(metadata.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("strategy.name is 'single-shot'", () => {
    expect(singleShotStrategy().name).toBe("single-shot");
  });
});

// ─── bestOfNStrategy ──────────────────────────────────────────────────────────

describe("bestOfNStrategy", () => {
  const rewardModel = (scores: number[]) => {
    let i = 0;
    return { score: () => scores[i++] ?? 0 };
  };

  const verifier = (scores: number[]) => {
    let i = 0;
    return {
      evaluate: async (c: unknown) => ({
        score: scores[i++] ?? 0,
        verdict: "pass" as const,
        rationale: "",
        candidate: c,
      }),
    };
  };

  it("throws RangeError when n < 1", () => {
    expect(() => bestOfNStrategy({ n: 0, rewardModel: rewardModel([]) })).toThrow(RangeError);
  });

  it("throws when neither verifier nor rewardModel provided", () => {
    expect(() => bestOfNStrategy({ n: 2 } as never)).toThrow("exactly one of verifier|rewardModel");
  });

  it("throws when both verifier and rewardModel provided", () => {
    expect(() =>
      bestOfNStrategy({
        n: 2,
        verifier: verifier([1]),
        rewardModel: rewardModel([1]),
      }),
    ).toThrow("exactly one of verifier|rewardModel");
  });

  it("returns the highest-scored candidate (rewardModel)", async () => {
    const strategy = bestOfNStrategy({
      n: 3,
      rewardModel: rewardModel([0.3, 0.9, 0.5]),
    });
    let call = 0;
    const gen = async () => ({ index: call++ });
    const { result } = await strategy.run({}, gen);
    expect(result).toEqual({ index: 1 }); // score 0.9 is highest
  });

  it("returns the highest-scored candidate (verifier)", async () => {
    const strategy = bestOfNStrategy({
      n: 3,
      verifier: verifier([0.1, 0.4, 0.8]),
    });
    let call = 0;
    const gen = async () => call++;
    const { result } = await strategy.run({}, gen);
    expect(result).toBe(2); // score 0.8 is highest
  });

  it("stable tie-break: first candidate wins on equal scores", async () => {
    const strategy = bestOfNStrategy({
      n: 3,
      rewardModel: rewardModel([0.5, 0.5, 0.5]),
    });
    let call = 0;
    const gen = async () => call++;
    const { result } = await strategy.run({}, gen);
    expect(result).toBe(0); // first candidate wins
  });

  it("metadata.candidates equals n, verifier_scores has n entries", async () => {
    const strategy = bestOfNStrategy({
      n: 3,
      rewardModel: rewardModel([0.1, 0.5, 0.3]),
    });
    const { metadata } = await strategy.run({}, async () => "x");
    expect(metadata.candidates).toBe(3);
    expect(metadata.verifier_scores).toHaveLength(3);
    expect(metadata.cost.calls).toBe(3);
  });

  it("sequential mode (parallel=false) produces same result", async () => {
    const strategy = bestOfNStrategy({
      n: 2,
      parallel: false,
      rewardModel: rewardModel([0.2, 0.8]),
    });
    let call = 0;
    const gen = async () => call++;
    const { result } = await strategy.run({}, gen);
    expect(result).toBe(1);
  });

  it("strategy.name is 'best-of-n'", () => {
    expect(bestOfNStrategy({ n: 1, rewardModel: rewardModel([]) }).name).toBe("best-of-n");
  });
});
