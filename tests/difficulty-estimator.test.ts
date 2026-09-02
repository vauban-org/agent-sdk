/**
 * tests/difficulty-estimator.test.ts
 *
 * Tests for deterministic task difficulty classifier + strategy recommender.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  estimateDifficulty,
  extractFeatures,
  recommendStrategy,
} from "../src/compute/difficulty-estimator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("extractFeatures", () => {
  it("computes inputLength correctly", () => {
    const f = extractFeatures("hello");
    expect(f.inputLength).toBe(5);
  });

  it("detects multi-step via 'step'/'then'/'first'", () => {
    expect(extractFeatures("first do X then do Y").hasMultipleSteps).toBe(true);
    expect(extractFeatures("step 1: a, step 2: b").hasMultipleSteps).toBe(true);
    expect(extractFeatures("hello world").hasMultipleSteps).toBe(false);
  });

  it("detects reasoning via 'why'/'explain'/'reason'/'prove'/'deduce'", () => {
    expect(extractFeatures("why is this true").requiresReasoning).toBe(true);
    expect(extractFeatures("explain the result").requiresReasoning).toBe(true);
    expect(extractFeatures("prove that P=NP").requiresReasoning).toBe(true);
    expect(extractFeatures("deduce the answer").requiresReasoning).toBe(true);
    expect(extractFeatures("hello").requiresReasoning).toBe(false);
  });

  it("detects creativity via 'create'/'generate'/'design'/'imagine'", () => {
    expect(extractFeatures("create a logo").requiresCreativity).toBe(true);
    expect(extractFeatures("generate a poem").requiresCreativity).toBe(true);
    expect(extractFeatures("design a system").requiresCreativity).toBe(true);
    expect(extractFeatures("imagine a world").requiresCreativity).toBe(true);
    expect(extractFeatures("read this file").requiresCreativity).toBe(false);
  });

  it("detects numerics via digits or math operators", () => {
    expect(extractFeatures("compute 2+3").hasNumerics).toBe(true);
    expect(extractFeatures("x * y").hasNumerics).toBe(true);
    expect(extractFeatures("42 items").hasNumerics).toBe(true);
    expect(extractFeatures("hello world").hasNumerics).toBe(false);
  });

  it("detects cross-reference via 'A and B' or 'compare'", () => {
    expect(extractFeatures("foo and bar").hasCrossReference).toBe(true);
    expect(extractFeatures("compare X and Y").hasCrossReference).toBe(true);
    expect(extractFeatures("single thing").hasCrossReference).toBe(false);
  });

  it("uses context for contextLength", () => {
    const f = extractFeatures("hi", "long system prompt here");
    expect(f.contextLength).toBe("long system prompt here".length);
  });

  it("empty context yields contextLength=0", () => {
    expect(extractFeatures("hi").contextLength).toBe(0);
  });
});

describe("estimateDifficulty", () => {
  it("returns 'simple' for short, no-reasoning, no-multi-step input", () => {
    const features = extractFeatures("hello");
    expect(estimateDifficulty(features)).toBe("simple");
  });

  it("returns 'reasoning' when requiresReasoning=true", () => {
    const features = extractFeatures("why does this happen explain it now");
    expect(estimateDifficulty(features)).toBe("reasoning");
  });

  it("returns 'standard' for 100-500 chars with numerics", () => {
    const features = extractFeatures(`compute 12 + 34 ${"x ".repeat(60)}`);
    expect(estimateDifficulty(features)).toBe("standard");
  });

  it("returns 'complex' for >500 chars OR multi-step", () => {
    const longInput = `${"text ".repeat(150)}`;
    const features = extractFeatures(longInput);
    expect(estimateDifficulty(features)).toBe("complex");
  });

  it("returns 'complex' for multi-step input", () => {
    const features = extractFeatures(`first do something then do another step ${"x ".repeat(30)}`);
    expect(estimateDifficulty(features)).toBe("complex");
  });
});

describe("recommendStrategy", () => {
  it("simple → single-shot", () => {
    expect(recommendStrategy("simple")).toBe("single-shot");
  });

  it("standard → bon-mav", () => {
    expect(recommendStrategy("standard")).toBe("bon-mav");
  });

  it("complex → tree-of-thoughts", () => {
    expect(recommendStrategy("complex")).toBe("tree-of-thoughts");
  });

  it("reasoning → mixture-of-agents", () => {
    expect(recommendStrategy("reasoning")).toBe("mixture-of-agents");
  });

  it("returns a valid strategy name for any class", () => {
    const valid = new Set(["single-shot", "bon-mav", "tree-of-thoughts", "mixture-of-agents"]);
    for (const c of ["simple", "standard", "complex", "reasoning"] as const) {
      expect(valid.has(recommendStrategy(c))).toBe(true);
    }
  });
});

describe("routing dataset", () => {
  it("has ≥100 entries with required fields", async () => {
    const datasetPath = path.resolve(__dirname, "../bench/routing-dataset.json");
    const raw = await readFile(datasetPath, "utf-8");
    const data: unknown = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    const arr = data as Array<Record<string, unknown>>;
    expect(arr.length).toBeGreaterThanOrEqual(100);

    for (const entry of arr.slice(0, 10)) {
      expect(entry).toHaveProperty("features");
      expect(entry).toHaveProperty("best_strategy");
      const features = entry.features as Record<string, unknown>;
      expect(features).toHaveProperty("inputLength");
      expect(features).toHaveProperty("requiresReasoning");
      expect(features).toHaveProperty("hasMultipleSteps");
    }
  });
});
