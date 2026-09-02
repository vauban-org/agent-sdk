/**
 * src/skill-loop/evaluator.ts
 *
 * Eval harness for SkillCandidates against a verifier set.
 *
 * Scoring is deterministic string-similarity (Jaccard token overlap).
 * No LLM calls — consumer provides the executor function.
 *
 * Statistical significance: Welch's t-test (p < 0.05 AND delta >= 0.10).
 *
 * @module skill-loop/evaluator
 */

import type { SkillCandidate } from "./candidate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @public */
export interface VerifierExample {
  input: string;
  expectedOutput: string;
  domain: string;
}

/** @public */
export interface EvalResult {
  candidateId: string;
  verifierSetSize: number;
  meanScore: number;
  stddev: number;
  /** Fraction of examples where score >= 0.7 */
  passRate: number;
  incumbentMeanScore: number;
  deltaVsIncumbent: number;
  /** Welch's t-test p-value vs incumbent */
  pValue: number;
  /** true if p < 0.05 AND delta >= 0.10 */
  significant: boolean;
}

// ---------------------------------------------------------------------------
// Similarity scoring — Jaccard token overlap (deterministic, no LLM)
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

function jaccardScore(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Statistical helpers — Welch's t-test (two-sample, unequal variance)
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
}

/**
 * Welch's t-test — returns p-value (two-tailed approximation via t-distribution).
 *
 * Uses the Cornish-Fisher normal approximation for the CDF when df is large (>30).
 * For small df we use a simple lookup table truncated at key quantiles.
 * This is sufficient for the pass criterion (p < 0.05 threshold).
 */
function welchPValue(candidateScores: number[], incumbentScores: number[]): number {
  const n1 = candidateScores.length;
  const n2 = incumbentScores.length;
  if (n1 < 2 || n2 < 2) return 1.0;

  const m1 = mean(candidateScores);
  const m2 = mean(incumbentScores);
  const v1 = variance(candidateScores, m1);
  const v2 = variance(incumbentScores, m2);

  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return m1 === m2 ? 1.0 : 0.0;

  const t = Math.abs((m1 - m2) / se);

  // Welch–Satterthwaite degrees of freedom
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));

  // Approximation: for df >= 30 use standard normal; else conservative t lookup
  if (df >= 30) {
    // Two-tailed p using standard normal approximation
    // p ≈ 2 * (1 - Φ(t))  where Φ is the standard normal CDF
    const p = 2 * (1 - normalCdf(t));
    return Math.max(0, Math.min(1, p));
  }

  // Conservative lookup table for small df — sufficient for p < 0.05 gate
  // t-critical values at alpha=0.05 (two-tailed) by df (1..29)
  const tCrit05: Record<number, number> = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    11: 2.201,
    12: 2.179,
    13: 2.16,
    14: 2.145,
    15: 2.131,
    16: 2.12,
    17: 2.11,
    18: 2.101,
    19: 2.093,
    20: 2.086,
    25: 2.06,
    29: 2.045,
  };
  const dfInt = Math.max(1, Math.min(29, Math.round(df)));
  // Find the nearest key
  const keys = Object.keys(tCrit05)
    .map(Number)
    .sort((a, b) => a - b);
  let nearest = keys[0];
  for (const k of keys) {
    if (k <= dfInt) nearest = k;
  }
  const crit = tCrit05[nearest] ?? 2.045;
  // Return p < 0.05 signal: if t > crit → p < 0.05
  return t > crit ? 0.04 : 0.1;
}

/**
 * Standard normal CDF approximation (Hart algorithm, sufficient for p-value use).
 */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212559 + t * 1.3302744))));
  return 1 - p;
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a SkillCandidate against a verifier set.
 *
 * @param candidate       - The skill candidate under evaluation.
 * @param verifierSet     - Ground-truth input/output pairs.
 * @param incumbentScore  - Mean score of the current production skill.
 * @param executor        - Runs the skill on an input, returns output.
 */
export async function evaluateCandidate(
  candidate: SkillCandidate,
  verifierSet: VerifierExample[],
  incumbentScore: number,
  executor: (skill: string, input: string) => Promise<string>,
): Promise<EvalResult> {
  if (verifierSet.length === 0) {
    return {
      candidateId: candidate.id,
      verifierSetSize: 0,
      meanScore: 0,
      stddev: 0,
      passRate: 0,
      incumbentMeanScore: incumbentScore,
      deltaVsIncumbent: -incumbentScore,
      pValue: 1.0,
      significant: false,
    };
  }

  // Evaluate candidate on each example
  const scores: number[] = await Promise.all(
    verifierSet.map(async (example) => {
      const actual = await executor(candidate.instructions, example.input);
      return jaccardScore(actual, example.expectedOutput);
    }),
  );

  const m = mean(scores);
  const v = variance(scores, m);
  const stddev = Math.sqrt(v);
  const passRate = scores.filter((s) => s >= 0.7).length / scores.length;
  const delta = m - incumbentScore;

  // Build synthetic incumbent scores for statistical test
  // (treat incumbentScore as a constant distribution — one sample per example)
  const incumbentScores = verifierSet.map(() => incumbentScore);

  const pValue = welchPValue(scores, incumbentScores);
  const significant = pValue < 0.05 && delta >= 0.1;

  return {
    candidateId: candidate.id,
    verifierSetSize: verifierSet.length,
    meanScore: m,
    stddev,
    passRate,
    incumbentMeanScore: incumbentScore,
    deltaVsIncumbent: delta,
    pValue,
    significant,
  };
}
