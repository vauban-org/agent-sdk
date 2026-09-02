/**
 * tests/eval-dataset.test.ts
 *
 * Sprint-579: eval-dataset-30 — structural validation of the 30 synthetic tasks.
 */

import { describe, expect, it } from "vitest";
import {
  EVAL_DATASET_30,
  type EvalCategory,
  getTasksByCategory,
  getTasksByDifficulty,
} from "../src/evals/datasets/index.js";

describe("EVAL_DATASET_30", () => {
  it("contains exactly 30 tasks", () => {
    expect(EVAL_DATASET_30).toHaveLength(30);
  });

  it("has 6 tasks per category", () => {
    const categories: EvalCategory[] = [
      "math",
      "code",
      "classification",
      "summarization",
      "reasoning",
    ];
    for (const cat of categories) {
      expect(getTasksByCategory(cat), `expected 6 tasks for category "${cat}"`).toHaveLength(6);
    }
  });

  it("all task ids are unique", () => {
    const ids = EVAL_DATASET_30.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every task has non-empty prompt", () => {
    for (const task of EVAL_DATASET_30) {
      expect(task.prompt.trim().length, `task ${task.id} has empty prompt`).toBeGreaterThan(0);
    }
  });

  it("every task has non-empty groundTruth", () => {
    for (const task of EVAL_DATASET_30) {
      const gt = Array.isArray(task.groundTruth) ? task.groundTruth : [task.groundTruth];
      expect(gt.length, `task ${task.id} has no groundTruth`).toBeGreaterThan(0);
      for (const v of gt) {
        expect(v.trim().length, `task ${task.id} has empty groundTruth value`).toBeGreaterThan(0);
      }
    }
  });

  it("every task has a valid scorer", () => {
    const validScorers = ["exact", "numeric_tolerance", "contains", "code_output", undefined];
    for (const task of EVAL_DATASET_30) {
      expect(validScorers, `task ${task.id} has invalid scorer`).toContain(task.scorer);
    }
  });

  it("numeric_tolerance tasks have tolerance defined", () => {
    const numeric = EVAL_DATASET_30.filter((t) => t.scorer === "numeric_tolerance");
    for (const task of numeric) {
      expect(task.tolerance, `task ${task.id} missing tolerance`).toBeDefined();
      expect(typeof task.tolerance).toBe("number");
    }
  });

  it("has tasks at all difficulty levels", () => {
    const easy = getTasksByDifficulty("easy");
    const medium = getTasksByDifficulty("medium");
    const hard = getTasksByDifficulty("hard");
    expect(easy.length).toBeGreaterThan(0);
    expect(medium.length).toBeGreaterThan(0);
    expect(hard.length).toBeGreaterThan(0);
    expect(easy.length + medium.length + hard.length).toBe(30);
  });

  it("no task mentions product-specific terms (substrate-purity)", () => {
    const forbidden = /\b(forge|bastion|glacis|n8n)\b/i;
    for (const task of EVAL_DATASET_30) {
      expect(task.prompt, `task ${task.id} contains product-specific term`).not.toMatch(forbidden);
    }
  });
});
