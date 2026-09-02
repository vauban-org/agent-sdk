/**
 * tests/eval-harness.test.ts
 *
 * Sprint-579: eval-harness — TDD tests for evalSuite and scoreTask.
 */

import { describe, expect, it } from "vitest";
import type { EvalTask } from "../src/evals/datasets/index.js";
import { evalSuite, scoreTask } from "../src/evals/harness.js";
import type { EvalStrategy } from "../src/evals/harness.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeStrategy(outputFn: (prompt: string) => string, name = "test"): EvalStrategy {
  return {
    name,
    async run(prompt) {
      const t0 = Date.now();
      const output = outputFn(prompt);
      return { output, latencyMs: Date.now() - t0, costUsd: 0.001 };
    },
  };
}

const perfectTask: EvalTask = {
  id: "t-001",
  category: "math",
  difficulty: "easy",
  prompt: "What is 2+2?",
  groundTruth: "4",
  scorer: "exact",
};

const containsTask: EvalTask = {
  id: "t-002",
  category: "classification",
  difficulty: "easy",
  prompt: "Is this POSITIVE or NEGATIVE? 'Great product!'",
  groundTruth: "POSITIVE",
  scorer: "contains",
};

const numericTask: EvalTask = {
  id: "t-003",
  category: "math",
  difficulty: "medium",
  prompt: "What is pi rounded to 2 decimal places?",
  groundTruth: "3.14",
  scorer: "numeric_tolerance",
  tolerance: 0.01,
};

const multiTruthTask: EvalTask = {
  id: "t-004",
  category: "math",
  difficulty: "easy",
  prompt: "What is 6*7?",
  groundTruth: ["42", "forty-two"],
  scorer: "contains",
};

// ─── scoreTask ───────────────────────────────────────────────────────────────

describe("scoreTask", () => {
  describe("exact scorer", () => {
    it("returns 1 for exact match", () => {
      expect(scoreTask(perfectTask, "4")).toBe(1);
    });

    it("returns 1 for case-insensitive match", () => {
      expect(scoreTask({ ...perfectTask, groundTruth: "YES" }, "yes")).toBe(1);
    });

    it("returns 0 for mismatch", () => {
      expect(scoreTask(perfectTask, "5")).toBe(0);
    });

    it("returns 0 for empty output", () => {
      expect(scoreTask(perfectTask, "")).toBe(0);
    });
  });

  describe("contains scorer", () => {
    it("returns 1 when output contains ground truth", () => {
      expect(scoreTask(containsTask, "The sentiment is POSITIVE.")).toBe(1);
    });

    it("returns 0 when ground truth absent", () => {
      expect(scoreTask(containsTask, "NEGATIVE")).toBe(0);
    });

    it("accepts any of multiple ground truths", () => {
      expect(scoreTask(multiTruthTask, "The answer is 42")).toBe(1);
      expect(scoreTask(multiTruthTask, "forty-two indeed")).toBe(1);
    });
  });

  describe("numeric_tolerance scorer", () => {
    it("returns 1 within tolerance", () => {
      expect(scoreTask(numericTask, "3.14")).toBe(1);
      expect(scoreTask(numericTask, "approximately 3.141")).toBe(1);
    });

    it("returns 0 outside tolerance", () => {
      expect(scoreTask(numericTask, "3.20")).toBe(0);
    });

    it("returns 0 for non-numeric output", () => {
      expect(scoreTask(numericTask, "not a number")).toBe(0);
    });
  });

  describe("default scorer (contains)", () => {
    it("falls back to contains when scorer undefined", () => {
      const task: EvalTask = {
        id: "t-no-scorer",
        category: "reasoning",
        difficulty: "easy",
        prompt: "?",
        groundTruth: "yes",
      };
      expect(scoreTask(task, "The answer is yes.")).toBe(1);
    });
  });
});

// ─── evalSuite ───────────────────────────────────────────────────────────────

describe("evalSuite", () => {
  it("returns accuracy 1.0 when all tasks pass", async () => {
    const strategy = makeStrategy(() => "4");
    const result = await evalSuite(strategy, [perfectTask]);

    expect(result.accuracy).toBe(1);
    expect(result.meta.passedTasks).toBe(1);
    expect(result.meta.failedTasks).toBe(0);
  });

  it("returns accuracy 0.0 when all tasks fail", async () => {
    const strategy = makeStrategy(() => "wrong answer");
    const result = await evalSuite(strategy, [perfectTask]);

    expect(result.accuracy).toBe(0);
    expect(result.meta.failedTasks).toBe(1);
  });

  it("computes correct accuracy across mixed results", async () => {
    const tasks: EvalTask[] = [
      perfectTask,
      { ...perfectTask, id: "t-002", groundTruth: "5" },
      { ...perfectTask, id: "t-003", groundTruth: "4" },
    ];
    const strategy = makeStrategy(() => "4");
    const result = await evalSuite(strategy, tasks);

    expect(result.accuracy).toBeCloseTo(2 / 3, 5);
  });

  it("sums total cost across tasks", async () => {
    const strategy: EvalStrategy = {
      name: "costed",
      async run() {
        return { output: "4", costUsd: 0.01, latencyMs: 5 };
      },
    };
    const result = await evalSuite(strategy, [perfectTask, perfectTask]);

    expect(result.costUsd).toBeCloseTo(0.02);
  });

  it("returns median latency", async () => {
    let call = 0;
    const strategy: EvalStrategy = {
      name: "varied",
      async run() {
        call++;
        return { output: "4", latencyMs: call * 10, costUsd: 0 };
      },
    };
    const result = await evalSuite(strategy, [perfectTask, perfectTask, perfectTask]);
    expect(result.latencyMs).toBe(20);
  });

  it("handles empty dataset", async () => {
    const strategy = makeStrategy(() => "x");
    const result = await evalSuite(strategy, []);

    expect(result.accuracy).toBe(0);
    expect(result.meta.totalTasks).toBe(0);
    expect(result.rationale).toHaveLength(0);
  });

  it("records strategy name in result", async () => {
    const strategy = makeStrategy(() => "4", "single-shot-test");
    const result = await evalSuite(strategy, [perfectTask]);

    expect(result.strategy).toBe("single-shot-test");
  });

  it("captures output in per-task rationale", async () => {
    const strategy = makeStrategy(() => "the output is 4");
    const result = await evalSuite(strategy, [perfectTask]);

    expect(result.rationale[0]?.output).toBe("the output is 4");
    expect(result.rationale[0]?.taskId).toBe("t-001");
  });

  it("marks task failed when strategy throws", async () => {
    const strategy: EvalStrategy = {
      name: "failing",
      async run() {
        throw new Error("model unavailable");
      },
    };
    const result = await evalSuite(strategy, [perfectTask]);

    expect(result.accuracy).toBe(0);
    expect(result.rationale[0]?.rationale).toContain("model unavailable");
  });

  it("includes durationMs in meta", async () => {
    const strategy = makeStrategy(() => "4");
    const result = await evalSuite(strategy, [perfectTask]);

    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
