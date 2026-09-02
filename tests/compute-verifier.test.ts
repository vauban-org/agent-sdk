/**
 * Tests for compute/verifier.ts
 *
 * TDD — tests written before implementation.
 * Covers: interface conformance, runtime guard, sync + async verifier paths.
 */

import { describe, expect, it } from "vitest";
import {
  type Verifier,
  type VerifierResult,
  assertVerifierResult,
} from "../src/compute/verifier.js";

// ─── 1. Type-level: custom verifier conforms to Verifier<T> ──────────────────

interface MathOutput {
  expression: string;
  answer: number;
}

/** Sync verifier — returns VerifierResult directly. */
const syncMathVerifier: Verifier<MathOutput> = {
  name: "math-correctness",
  evaluate(output: MathOutput): VerifierResult {
    const correct = output.answer === 42;
    return {
      score: correct ? 1 : 0,
      rationale: correct ? "Answer matches expected value" : `Expected 42, got ${output.answer}`,
    };
  },
};

/** Async verifier — returns Promise<VerifierResult>. */
const asyncMathVerifier: Verifier<MathOutput> = {
  name: "math-correctness-async",
  async evaluate(output: MathOutput): Promise<VerifierResult> {
    await Promise.resolve(); // simulate async work
    const correct = output.answer === 42;
    return {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Async: answer matches expected value"
        : `Async: expected 42, got ${output.answer}`,
    };
  },
};

// ─── 2. Verifier interface conformance ───────────────────────────────────────

describe("Verifier interface", () => {
  it("sync verifier returns a valid result on correct output", () => {
    const result = syncMathVerifier.evaluate({ expression: "6×7", answer: 42 });
    // result is VerifierResult (not a Promise) because evaluate is sync
    expect((result as VerifierResult).score).toBe(1);
    expect((result as VerifierResult).rationale).toBeTypeOf("string");
  });

  it("sync verifier returns score=0 on wrong answer", () => {
    const result = syncMathVerifier.evaluate({ expression: "6×7", answer: 0 });
    expect((result as VerifierResult).score).toBe(0);
  });

  it("async verifier resolves a valid result on correct output", async () => {
    const result = await asyncMathVerifier.evaluate({
      expression: "6×7",
      answer: 42,
    });
    expect(result.score).toBe(1);
    expect(result.rationale).toBeTypeOf("string");
  });

  it("async verifier resolves score=0 on wrong answer", async () => {
    const result = await asyncMathVerifier.evaluate({
      expression: "6×7",
      answer: 0,
    });
    expect(result.score).toBe(0);
  });

  it("exposes a name identifier for telemetry", () => {
    expect(syncMathVerifier.name).toBe("math-correctness");
    expect(asyncMathVerifier.name).toBe("math-correctness-async");
  });
});

// ─── 3. assertVerifierResult runtime guard ───────────────────────────────────

describe("assertVerifierResult", () => {
  it("accepts a valid result with score=0", () => {
    expect(() => assertVerifierResult({ score: 0, rationale: "rejected" })).not.toThrow();
  });

  it("accepts a valid result with score=1", () => {
    expect(() => assertVerifierResult({ score: 1, rationale: "accepted" })).not.toThrow();
  });

  it("accepts a valid result with score in (0,1)", () => {
    expect(() => assertVerifierResult({ score: 0.75, rationale: "partial" })).not.toThrow();
  });

  it("throws when score is above 1", () => {
    expect(() => assertVerifierResult({ score: 1.1, rationale: "oops" })).toThrow(
      /score.*\[0,1\]/i,
    );
  });

  it("throws when score is below 0", () => {
    expect(() => assertVerifierResult({ score: -0.1, rationale: "oops" })).toThrow(
      /score.*\[0,1\]/i,
    );
  });

  it("throws when score is NaN", () => {
    expect(() => assertVerifierResult({ score: Number.NaN, rationale: "oops" })).toThrow(
      /score.*\[0,1\]/i,
    );
  });

  it("throws when rationale is not a string", () => {
    // Using unknown cast to avoid noExplicitAny: deliberate bad input for guard test
    const bad = { score: 0.5, rationale: 42 } as unknown as VerifierResult;
    expect(() => assertVerifierResult(bad)).toThrow(/rationale.*string/i);
  });

  it("throws when rationale is missing", () => {
    const bad = { score: 0.5 } as unknown as VerifierResult;
    expect(() => assertVerifierResult(bad)).toThrow(/rationale.*string/i);
  });

  it("throws when score is missing", () => {
    const bad = { rationale: "hi" } as unknown as VerifierResult;
    expect(() => assertVerifierResult(bad)).toThrow(/score.*\[0,1\]/i);
  });

  it("throws when result is null", () => {
    const bad = null as unknown as VerifierResult;
    expect(() => assertVerifierResult(bad)).toThrow();
  });

  it("throws when result is undefined", () => {
    const bad = undefined as unknown as VerifierResult;
    expect(() => assertVerifierResult(bad)).toThrow();
  });
});

// ─── 4. No built-in pool — caller is responsible for verifier construction ───

describe("No verifier pool", () => {
  it("each caller constructs their own verifier instance", () => {
    // Verifier is a plain interface — no factory, no pool, no registry.
    // This test asserts the design intent: any object satisfying the
    // interface is a valid verifier.
    const trivialVerifier: Verifier<string> = {
      name: "trivial",
      evaluate: (output: string): VerifierResult => ({
        score: output.length > 0 ? 1 : 0,
        rationale: output.length > 0 ? "non-empty" : "empty string rejected",
      }),
    };
    const result = trivialVerifier.evaluate("hello") as VerifierResult;
    expect(result.score).toBe(1);
  });
});
