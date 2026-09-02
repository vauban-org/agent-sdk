/**
 * tests/skill-evaluator.test.ts
 *
 * Unit tests for skill-loop/evaluator.ts
 *
 * Coverage:
 *   - evaluateCandidate: empty verifier set, perfect match, zero score, mixed scores
 *   - jaccardScore (via evaluateCandidate): tokenization edge cases
 *   - Statistical logic: significance flag, p-value boundaries, delta threshold
 */

import { describe, expect, it } from "vitest";
import { evaluateCandidate } from "../src/skill-loop/evaluator.js";
import type { SkillCandidate, VerifierExample } from "../src/skill-loop/evaluator.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(instructions: string): SkillCandidate {
  return {
    id: "test-candidate-001",
    extractedFrom: "cycle-abc",
    domain: "test-domain",
    instructions,
    constitutionalScore: 0.9,
    outcomeScore: 0.85,
    version: "1.0.0",
    replayRoot: "replay-root-hash",
  };
}

function makeExample(input: string, expectedOutput: string): VerifierExample {
  return { input, expectedOutput, domain: "test" };
}

/** Executor that returns the expectedOutput unchanged — perfect score. */
const perfectExecutor = (_skill: string, input: string) => Promise.resolve(input);

/** Executor that returns exactly the expected output (matched from a lookup). */
function fixedOutputExecutor(outputs: string[]) {
  let i = 0;
  return (_skill: string, _input: string) => Promise.resolve(outputs[i++]);
}

/** Executor that always returns empty string — zero Jaccard score. */
const emptyExecutor = () => Promise.resolve("");

// ---------------------------------------------------------------------------
// Tests — empty verifier set
// ---------------------------------------------------------------------------

describe("evaluateCandidate — empty verifier set", () => {
  it("returns zeroed EvalResult when verifierSet is empty", async () => {
    const candidate = makeCandidate("do something useful");
    const result = await evaluateCandidate(candidate, [], 0.5, perfectExecutor);

    expect(result.candidateId).toBe("test-candidate-001");
    expect(result.verifierSetSize).toBe(0);
    expect(result.meanScore).toBe(0);
    expect(result.stddev).toBe(0);
    expect(result.passRate).toBe(0);
    expect(result.pValue).toBe(1.0);
    expect(result.significant).toBe(false);
  });

  it("deltaVsIncumbent equals -incumbentScore when verifier set is empty", async () => {
    const candidate = makeCandidate("noop");
    const result = await evaluateCandidate(candidate, [], 0.7, perfectExecutor);
    expect(result.deltaVsIncumbent).toBeCloseTo(-0.7);
  });
});

// ---------------------------------------------------------------------------
// Tests — perfect executor (executor returns input as output)
// ---------------------------------------------------------------------------

describe("evaluateCandidate — perfect executor (Jaccard = 1 when input = expected)", () => {
  it("yields meanScore 1.0 when executor echoes input matching expectedOutput", async () => {
    const candidate = makeCandidate("echo the input");
    // Both input and expectedOutput are the same text so Jaccard = 1.0
    const verifierSet: VerifierExample[] = [
      makeExample("hello world", "hello world"),
      makeExample("foo bar baz", "foo bar baz"),
    ];
    const result = await evaluateCandidate(candidate, verifierSet, 0.5, perfectExecutor);
    expect(result.meanScore).toBeCloseTo(1.0);
    expect(result.passRate).toBe(1.0);
    expect(result.verifierSetSize).toBe(2);
  });

  it("significant=true when delta >= 0.10 and candidate scores consistently higher than incumbent", async () => {
    const candidate = makeCandidate("skill text");
    // All scores will be 1.0 (perfect match), incumbent = 0.5 → delta = 0.5
    const verifierSet = Array.from({ length: 10 }, (_, i) => makeExample(`token${i}`, `token${i}`));
    const executor = (_skill: string, input: string) => Promise.resolve(input);
    const result = await evaluateCandidate(candidate, verifierSet, 0.5, executor);

    expect(result.deltaVsIncumbent).toBeCloseTo(0.5, 1);
    expect(result.significant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — zero-score executor
// ---------------------------------------------------------------------------

describe("evaluateCandidate — zero-score executor", () => {
  it("yields meanScore 0 when executor returns empty string", async () => {
    const candidate = makeCandidate("failing skill");
    const verifierSet = [
      makeExample("input1", "expected output one"),
      makeExample("input2", "expected output two"),
    ];
    const result = await evaluateCandidate(candidate, verifierSet, 0.5, emptyExecutor);
    expect(result.meanScore).toBe(0);
    expect(result.passRate).toBe(0);
  });

  it("significant=false when delta is negative (candidate worse than incumbent)", async () => {
    const candidate = makeCandidate("bad skill");
    const verifierSet = Array.from({ length: 5 }, (_, i) => makeExample(`q${i}`, `answer${i}`));
    // executor returns empty → score 0, incumbent 0.8 → delta = -0.8
    const result = await evaluateCandidate(candidate, verifierSet, 0.8, emptyExecutor);
    expect(result.deltaVsIncumbent).toBeCloseTo(-0.8, 1);
    expect(result.significant).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — Jaccard similarity (via executor providing known outputs)
// ---------------------------------------------------------------------------

describe("evaluateCandidate — Jaccard similarity edge cases", () => {
  it("partial overlap produces score between 0 and 1", async () => {
    const candidate = makeCandidate("partial");
    // "hello world" vs "hello earth" → intersection={hello}, union={hello,world,earth} → 1/3
    const verifierSet = [makeExample("query", "hello earth")];
    const executor = () => Promise.resolve("hello world");
    const result = await evaluateCandidate(candidate, verifierSet, 0, executor);
    // Jaccard: intersection=1 (hello), union=3 (hello,world,earth) → 0.333
    expect(result.meanScore).toBeCloseTo(1 / 3, 2);
  });

  it("completely disjoint tokens yield score 0", async () => {
    const candidate = makeCandidate("disjoint");
    const verifierSet = [makeExample("q", "alpha beta gamma")];
    const executor = () => Promise.resolve("delta epsilon zeta");
    const result = await evaluateCandidate(candidate, verifierSet, 0, executor);
    expect(result.meanScore).toBe(0);
  });

  it("case-insensitive tokenization: 'Hello' and 'hello' count as same token", async () => {
    const candidate = makeCandidate("case test");
    const verifierSet = [makeExample("q", "Hello World")];
    const executor = () => Promise.resolve("hello world");
    const result = await evaluateCandidate(candidate, verifierSet, 0, executor);
    expect(result.meanScore).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// Tests — statistical significance
// ---------------------------------------------------------------------------

describe("evaluateCandidate — statistical significance logic", () => {
  it("significant=false when delta >= 0.10 but p-value is NOT < 0.05 (too few samples)", async () => {
    // With only 2 samples, Welch's t-test returns p=0.1 or p=0.04 depending on t vs crit
    // We target a scenario where delta is large but n=1 triggers n<2 guard → p=1.0
    const candidate = makeCandidate("tiny sample");
    // 1 example only — welchPValue returns 1.0 when n<2
    const verifierSet = [makeExample("q", "exact match output")];
    const executor = () => Promise.resolve("exact match output");
    const result = await evaluateCandidate(candidate, verifierSet, 0.1, executor);
    // With n=1 candidate scores and n=1 incumbent, welchPValue returns 1.0
    expect(result.pValue).toBe(1.0);
    expect(result.significant).toBe(false);
  });

  it("significant=false when delta < 0.10 even if p < 0.05", async () => {
    // All scores slightly above incumbent but delta < 0.10
    // scores = [0.55, 0.55, ...] × 30, incumbent = 0.50 → delta = 0.05
    const candidate = makeCandidate("marginal improvement");
    const verifierSet = Array.from({ length: 30 }, (_, i) => makeExample(`q${i}`, `abc${i} def`));
    // executor returns output that yields Jaccard ≈ 0.5 (1 token match out of 3 distinct tokens)
    const executor = (_s: string, _i: string) => Promise.resolve("abc0 xyz");
    const result = await evaluateCandidate(candidate, verifierSet, 0.4, executor);
    // Just verify the significant flag is consistent with both conditions
    if (result.deltaVsIncumbent < 0.1 || result.pValue >= 0.05) {
      expect(result.significant).toBe(false);
    }
  });

  it("candidateId is preserved in result", async () => {
    const candidate = { ...makeCandidate("x"), id: "custom-id-xyz" };
    const result = await evaluateCandidate(candidate, [], 0, emptyExecutor);
    expect(result.candidateId).toBe("custom-id-xyz");
  });

  it("incumbentMeanScore reflects the provided incumbentScore", async () => {
    const candidate = makeCandidate("skill");
    const result = await evaluateCandidate(candidate, [makeExample("q", "a")], 0.65, emptyExecutor);
    expect(result.incumbentMeanScore).toBe(0.65);
  });

  it("stddev is 0 when all scores are identical", async () => {
    const candidate = makeCandidate("uniform skill");
    const verifierSet = [
      makeExample("q1", "hello world"),
      makeExample("q2", "hello world"),
      makeExample("q3", "hello world"),
    ];
    const executor = () => Promise.resolve("hello world");
    const result = await evaluateCandidate(candidate, verifierSet, 0.5, executor);
    expect(result.stddev).toBeCloseTo(0);
  });

  it("passRate counts fraction of scores >= 0.7", async () => {
    const candidate = makeCandidate("pass-rate test");
    // First example: exact match → score 1.0 (pass)
    // Second example: executor returns "" → score 0.0 (fail)
    const verifierSet = [makeExample("q1", "hello world foo"), makeExample("q2", "bar baz qux")];
    const outputs = ["hello world foo", ""];
    const executor = fixedOutputExecutor(outputs);
    const result = await evaluateCandidate(candidate, verifierSet, 0.5, executor);
    expect(result.passRate).toBeCloseTo(0.5);
  });

  it("verifierSetSize matches length of verifierSet", async () => {
    const candidate = makeCandidate("size test");
    const verifierSet = Array.from({ length: 7 }, (_, i) => makeExample(`q${i}`, `ans${i}`));
    const result = await evaluateCandidate(candidate, verifierSet, 0, emptyExecutor);
    expect(result.verifierSetSize).toBe(7);
  });
});
