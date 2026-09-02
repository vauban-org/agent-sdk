import { describe, expect, it, vi } from "vitest";
import {
  type QualityEvaluator,
  type QualityScore,
  createQualityGate,
} from "../src/patterns/quality-gate/index.js";
import type { BrainPort } from "../src/ports/brain.js";

interface S {
  value: number;
}

function ev(name: string, score: number, weight = 1): QualityEvaluator<S> {
  return { name, weight, evaluate: async () => score };
}

function mockBrain(): BrainPort {
  return { archiveKnowledge: vi.fn(async () => null) };
}

// ────────────────────────────────────────────────────────────────────────────
// Constructor validation
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — construction", () => {
  it("throws when evaluators array is empty", () => {
    expect(() => createQualityGate({ name: "g", evaluators: [] })).toThrow(
      /evaluators must not be empty/,
    );
  });

  it("throws when asyncReviewThreshold >= autoProceedThreshold (equal)", () => {
    expect(() =>
      createQualityGate({
        name: "g",
        evaluators: [ev("e", 0.5)],
        autoProceedThreshold: 0.5,
        asyncReviewThreshold: 0.5,
      }),
    ).toThrow(/asyncReviewThreshold.*must be < autoProceedThreshold/);
  });

  it("throws when asyncReviewThreshold > autoProceedThreshold", () => {
    expect(() =>
      createQualityGate({
        name: "g",
        evaluators: [ev("e", 0.5)],
        autoProceedThreshold: 0.6,
        asyncReviewThreshold: 0.7,
      }),
    ).toThrow(/asyncReviewThreshold.*must be < autoProceedThreshold/);
  });

  it("valid config creates gate without throwing", () => {
    expect(() => createQualityGate({ name: "g", evaluators: [ev("e", 0.5)] })).not.toThrow();
  });

  it("default autoProceedThreshold is 0.8 (score=0.8 routes auto)", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.8)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("auto");
  });

  it("default asyncReviewThreshold is 0.5 (score=0.5 routes async_review)", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.5)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("async_review");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// evaluate() routing
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — routing", () => {
  it("score >= 0.8 → routing = 'auto'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.9)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("auto");
    expect(score.overall).toBeCloseTo(0.9);
  });

  it("0.5 <= score < 0.8 → routing = 'async_review'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.6)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("async_review");
  });

  it("score < 0.5 → routing = 'hitl_block'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.3)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("hitl_block");
  });

  it("exactly 0.8 → 'auto' (boundary inclusive)", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.8)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("auto");
  });

  it("exactly 0.5 → 'async_review' (boundary inclusive)", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.5)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("async_review");
  });

  it("just below 0.5 → 'hitl_block'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.499)],
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("hitl_block");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scoring and weighted average
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — scoring", () => {
  it("single evaluator score=0.9 → overall=0.9", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.9)],
    }).evaluate({ value: 1 });
    expect(score.overall).toBeCloseTo(0.9);
  });

  it("two equal-weight evaluators [0.6, 0.8] → overall=0.7", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("a", 0.6), ev("b", 0.8)],
    }).evaluate({ value: 1 });
    expect(score.overall).toBeCloseTo(0.7, 5);
  });

  it("weighted evaluators: weight=2 score=1.0 + weight=1 score=0.0 → overall≈0.667", async () => {
    const gate = createQualityGate({
      name: "g",
      evaluators: [ev("a", 1.0, 2), ev("b", 0.0, 1)],
    });
    const score = await gate.evaluate({ value: 1 });
    expect(score.overall).toBeCloseTo(2 / 3, 3);
  });

  it("evaluator that throws → scores 0 (does not propagate)", async () => {
    const gate = createQualityGate({
      name: "g",
      evaluators: [
        {
          name: "throws",
          evaluate: async () => {
            throw new Error("boom");
          },
        },
        ev("ok", 1.0),
      ],
    });
    const score = await gate.evaluate({ value: 1 });
    expect(score.overall).toBeCloseTo(0.5);
  });

  it("NaN from evaluator → clamped to 0", async () => {
    const gate = createQualityGate({
      name: "g",
      evaluators: [{ name: "nan", evaluate: async () => Number.NaN }, ev("ok", 1.0)],
    });
    const score = await gate.evaluate({ value: 1 });
    expect(score.overall).toBeCloseTo(0.5);
    expect(Number.isFinite(score.overall)).toBe(true);
  });

  it("score > 1 from evaluator → clamped to 1", async () => {
    const gate = createQualityGate({
      name: "g",
      evaluators: [{ name: "over", evaluate: async () => 1.5 }],
    });
    const score = await gate.evaluate({ value: 1 });
    expect(score.dimensions[0]?.score).toBe(1.0);
    expect(score.overall).toBe(1.0);
  });

  it("score < 0 from evaluator → clamped to 0", async () => {
    const gate = createQualityGate({
      name: "g",
      evaluators: [{ name: "under", evaluate: async () => -0.2 }],
    });
    const score = await gate.evaluate({ value: 1 });
    expect(score.dimensions[0]?.score).toBe(0.0);
    expect(score.overall).toBe(0.0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dimensions
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — dimensions", () => {
  it("result includes dimensions array with name, score, weight per evaluator", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("conf", 0.9, 2)],
    }).evaluate({ value: 1 });
    expect(score.dimensions).toHaveLength(1);
    expect(score.dimensions[0]).toEqual({
      name: "conf",
      score: 0.9,
      weight: 2,
    });
  });

  it("multiple evaluators → all appear in dimensions", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("conf", 0.9, 2), ev("comp", 0.7, 1)],
    }).evaluate({ value: 1 });
    expect(score.dimensions).toHaveLength(2);
    expect(score.dimensions[0]?.name).toBe("conf");
    expect(score.dimensions[1]?.name).toBe("comp");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Custom thresholds
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — custom thresholds", () => {
  it("autoProceedThreshold=0.95, score=0.9 → 'async_review'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.9)],
      autoProceedThreshold: 0.95,
      asyncReviewThreshold: 0.5,
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("async_review");
  });

  it("asyncReviewThreshold=0.7, score=0.75 → 'async_review'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.75)],
      autoProceedThreshold: 0.9,
      asyncReviewThreshold: 0.7,
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("async_review");
  });

  it("custom autoProceedThreshold=0.7, score=0.75 → 'auto'", async () => {
    const score = await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.75)],
      autoProceedThreshold: 0.7,
      asyncReviewThreshold: 0.4,
    }).evaluate({ value: 1 });
    expect(score.routing).toBe("auto");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// onHitlBlock callback
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — onHitlBlock", () => {
  it("calls onHitlBlock when routing=hitl_block", async () => {
    const onHitlBlock = vi.fn();
    const subject = { value: 1 };
    await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.1)],
      onHitlBlock,
    }).evaluate(subject);
    expect(onHitlBlock).toHaveBeenCalledOnce();
    const [callScore, callSubject] = onHitlBlock.mock.calls[0] as [QualityScore, S];
    expect(callScore.routing).toBe("hitl_block");
    expect(callSubject).toBe(subject);
  });

  it("does not call onHitlBlock when routing != hitl_block", async () => {
    const onHitlBlock = vi.fn();
    await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.9)],
      onHitlBlock,
    }).evaluate({ value: 1 });
    expect(onHitlBlock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Brain logging
// ────────────────────────────────────────────────────────────────────────────
describe("createQualityGate — Brain logging", () => {
  it("calls brain.archiveKnowledge once (fire-and-forget)", async () => {
    const brain = mockBrain();
    await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.8)],
      brain,
    }).evaluate({ value: 1 });
    await Promise.resolve();
    expect(brain.archiveKnowledge).toHaveBeenCalledOnce();
  });

  it("uses category 'operations' in the Brain log", async () => {
    const brain = mockBrain();
    await createQualityGate({
      name: "g",
      evaluators: [ev("e", 0.8)],
      brain,
    }).evaluate({ value: 1 });
    await Promise.resolve();
    const call = (brain.archiveKnowledge as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call?.category).toBe("operations");
  });
});
