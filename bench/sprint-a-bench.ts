/**
 * bench/sprint-a-bench.ts
 *
 * Sprint-580 — BoN-MAV bench harness.
 *
 * Compares three strategies on 30 synthetic numeric tasks:
 *   1. single-shot baseline
 *   2. BoN-4 (average of 3 verifiers as reward model)
 *   3. BoN-MAV-4 (3 aspect verifiers; mean / median / majority-vote aggregation)
 *
 * NO real LLM API calls. Deterministic synthetic generator + verifier model
 * calibrated so single-shot accuracy ≈ 50%.
 *
 * Run: pnpm exec tsx bench/sprint-a-bench.ts
 *      node --import tsx/esm bench/sprint-a-bench.ts
 */

import { writeFileSync } from "node:fs";
import { bestOfNStrategy } from "../src/compute/strategies/best-of-n.js";
import { bonMavStrategy } from "../src/compute/strategies/bon-mav.js";
import { singleShotStrategy } from "../src/compute/strategies/single-shot.js";
import type { ComputeContext } from "../src/compute/types.js";
import type { Verifier, VerifierResult } from "../src/compute/verifier.js";

// ─── Reproducible PRNG (mulberry32) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Box-Muller transform to sample N(0,1) from uniform PRNG. */
function gaussianPair(rng: () => number): [number, number] {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

function makeGaussianSampler(seed: number): (mean: number, std: number) => number {
  const rng = mulberry32(seed);
  let spare: number | null = null;
  return (mean, std): number => {
    if (spare !== null) {
      const v = spare * std + mean;
      spare = null;
      return v;
    }
    const [a, b] = gaussianPair(rng);
    spare = b;
    return a * std + mean;
  };
}

// ─── Task model ──────────────────────────────────────────────────────────────

/** A task: hidden numeric truth in [10, 90]. */
interface SyntheticTask {
  id: string;
  truth: number;
}

/** σ_g calibrated so |candidate - truth| > ACCURACY_THRESHOLD ≈ 50% of the time. */
const SIGMA_G = 15; // generator noise
const SIGMA_V = 0.12; // verifier noise (on normalised score scale)
const ACCURACY_THRESHOLD = 5; // |answer - truth| < 5 → correct
const N_TASKS = 30;
const N_CANDIDATES = 4; // BoN N

// Tasks: truth values spaced evenly + a prime-number offset for diversity.
function buildTasks(): SyntheticTask[] {
  const tasks: SyntheticTask[] = [];
  for (let i = 0; i < N_TASKS; i++) {
    tasks.push({ id: `task-${String(i).padStart(2, "0")}`, truth: 10 + ((i * 83) % 80) });
  }
  return tasks;
}

// ─── Synthetic generator ─────────────────────────────────────────────────────

/**
 * Returns a generator bound to a specific task.
 * Each call emits a numeric answer drawn from N(truth, σ_g).
 * Represented as `{ value: number }` to stay typed.
 */
function makeGenerator(
  task: SyntheticTask,
  genSampler: (mean: number, std: number) => number,
): (_input: string, _ctx: ComputeContext) => Promise<{ value: number }> {
  return async (_input, _ctx) => {
    const value = genSampler(task.truth, SIGMA_G);
    return { value };
  };
}

// ─── Synthetic verifiers ─────────────────────────────────────────────────────

/**
 * Verifier j returns: score = clamp(1 - |value - truth| / (3 * σ_g) + N(0, σ_v), 0, 1).
 * Three verifiers with independent noise seeds.
 */
function makeVerifier(
  name: string,
  task: SyntheticTask,
  vSampler: (mean: number, std: number) => number,
): Verifier<{ value: number }> {
  return {
    name,
    evaluate(output: { value: number }): VerifierResult {
      const raw = 1 - Math.abs(output.value - task.truth) / (3 * SIGMA_G);
      const noisy = raw + vSampler(0, SIGMA_V);
      const score = Math.max(0, Math.min(1, noisy));
      return {
        score,
        rationale: `${name}: val=${output.value.toFixed(2)} truth=${task.truth} raw=${raw.toFixed(3)} score=${score.toFixed(3)}`,
      };
    },
  };
}

// ─── Bootstrap CI ────────────────────────────────────────────────────────────

function bootstrapCI(
  values: number[],
  nResample = 1000,
  ciSeed = 0xdeadbeef,
): { mean: number; lo95: number; hi95: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, lo95: 0, hi95: 0 };
  const rng = mulberry32(ciSeed);
  const means: number[] = [];
  for (let r = 0; r < nResample; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += values[Math.floor(rng() * n)] as number;
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * nResample)] as number;
  const hi = means[Math.floor(0.975 * nResample)] as number;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return { mean, lo95: lo, hi95: hi };
}

// ─── Bench result type ────────────────────────────────────────────────────────

export interface StrategyBenchResult {
  strategyName: string;
  accuracy: number;
  accuracyCI: { lo95: number; hi95: number };
  meanCostCalls: number;
  meanLatencyMs: number;
  latencyCI: { lo95: number; hi95: number };
}

export interface BenchReport {
  capturedAt: string;
  nTasks: number;
  nCandidates: number;
  sigmaG: number;
  sigmaV: number;
  accuracyThreshold: number;
  results: StrategyBenchResult[];
}

// ─── Run bench ────────────────────────────────────────────────────────────────

export async function runBench(): Promise<BenchReport> {
  const tasks = buildTasks();

  // Separate sampler seeds so generator + each verifier draw independent noise streams.
  const genSampler = makeGaussianSampler(0xc0ffee01);
  const v1Sampler = makeGaussianSampler(0xc0ffee02);
  const v2Sampler = makeGaussianSampler(0xc0ffee03);
  const v3Sampler = makeGaussianSampler(0xc0ffee04);

  // Per-strategy arrays of (correct: 0|1, cost.calls, latency_ms)
  const ssCorrect: number[] = [];
  const ssCost: number[] = [];
  const ssLatency: number[] = [];

  const bonCorrect: number[] = [];
  const bonCost: number[] = [];
  const bonLatency: number[] = [];

  const mavMeanCorrect: number[] = [];
  const mavMedianCorrect: number[] = [];
  const mavVoteCorrect: number[] = [];
  const mavCost: number[] = [];
  const mavLatency: number[] = [];

  for (const task of tasks) {
    const gen = makeGenerator(task, genSampler);

    const v1 = makeVerifier("aspect-accuracy", task, v1Sampler);
    const v2 = makeVerifier("aspect-fluency", task, v2Sampler);
    const v3 = makeVerifier("aspect-relevance", task, v3Sampler);

    // ── single-shot ──────────────────────────────────────────────────
    {
      const strat = singleShotStrategy<string, { value: number }>();
      const r = await strat.run("solve", gen);
      const correct = Math.abs(r.result.value - task.truth) < ACCURACY_THRESHOLD ? 1 : 0;
      ssCorrect.push(correct);
      ssCost.push(r.metadata.cost.calls);
      ssLatency.push(r.metadata.latency_ms);
    }

    // ── BoN-4 (average of 3 verifiers as a composite reward model) ───
    {
      // BoN requires a single verifier or reward model; we wrap 3 verifiers
      // into a single composite reward model (average of their scores).
      const compositeRM = {
        score: async (output: { value: number }): Promise<number> => {
          const r1 = await v1.evaluate(output);
          const r2 = await v2.evaluate(output);
          const r3 = await v3.evaluate(output);
          return (
            ((r1 as VerifierResult).score +
              (r2 as VerifierResult).score +
              (r3 as VerifierResult).score) /
            3
          );
        },
      };
      const strat = bestOfNStrategy<string, { value: number }>({
        n: N_CANDIDATES,
        rewardModel: compositeRM,
      });
      const r = await strat.run("solve", gen);
      const correct = Math.abs(r.result.value - task.truth) < ACCURACY_THRESHOLD ? 1 : 0;
      bonCorrect.push(correct);
      bonCost.push(r.metadata.cost.calls);
      bonLatency.push(r.metadata.latency_ms);
    }

    // ── BoN-MAV-4 mean ───────────────────────────────────────────────
    {
      const strat = bonMavStrategy<string, { value: number }>({
        n: N_CANDIDATES,
        verifiers: [v1, v2, v3],
        aggregation: "mean",
      });
      const r = await strat.run("solve", gen);
      const correct = Math.abs(r.result.value - task.truth) < ACCURACY_THRESHOLD ? 1 : 0;
      mavMeanCorrect.push(correct);
      mavCost.push(r.metadata.cost.calls);
      mavLatency.push(r.metadata.latency_ms);
    }

    // ── BoN-MAV-4 median ─────────────────────────────────────────────
    {
      const strat = bonMavStrategy<string, { value: number }>({
        n: N_CANDIDATES,
        verifiers: [v1, v2, v3],
        aggregation: "median",
      });
      const r = await strat.run("solve", gen);
      const correct = Math.abs(r.result.value - task.truth) < ACCURACY_THRESHOLD ? 1 : 0;
      mavMedianCorrect.push(correct);
    }

    // ── BoN-MAV-4 majority-vote ──────────────────────────────────────
    {
      const strat = bonMavStrategy<string, { value: number }>({
        n: N_CANDIDATES,
        verifiers: [v1, v2, v3],
        aggregation: "majority-vote",
        voteThreshold: 0.5,
      });
      const r = await strat.run("solve", gen);
      const correct = Math.abs(r.result.value - task.truth) < ACCURACY_THRESHOLD ? 1 : 0;
      mavVoteCorrect.push(correct);
    }
  }

  const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ci = bootstrapCI;

  const ssAcc = ci(ssCorrect);
  const bonAcc = ci(bonCorrect);
  const mavMeanAcc = ci(mavMeanCorrect);
  const mavMedianAcc = ci(mavMedianCorrect);
  const mavVoteAcc = ci(mavVoteCorrect);

  const ssLat = ci(ssLatency);
  const bonLat = ci(bonLatency);
  const mavLat = ci(mavLatency);

  const results: StrategyBenchResult[] = [
    {
      strategyName: "single-shot",
      accuracy: ssAcc.mean,
      accuracyCI: { lo95: ssAcc.lo95, hi95: ssAcc.hi95 },
      meanCostCalls: mean(ssCost),
      meanLatencyMs: ssLat.mean,
      latencyCI: { lo95: ssLat.lo95, hi95: ssLat.hi95 },
    },
    {
      strategyName: "best-of-n-4 (composite reward)",
      accuracy: bonAcc.mean,
      accuracyCI: { lo95: bonAcc.lo95, hi95: bonAcc.hi95 },
      meanCostCalls: mean(bonCost),
      meanLatencyMs: bonLat.mean,
      latencyCI: { lo95: bonLat.lo95, hi95: bonLat.hi95 },
    },
    {
      strategyName: "bon-mav-4 (mean)",
      accuracy: mavMeanAcc.mean,
      accuracyCI: { lo95: mavMeanAcc.lo95, hi95: mavMeanAcc.hi95 },
      meanCostCalls: mean(mavCost),
      meanLatencyMs: mavLat.mean,
      latencyCI: { lo95: mavLat.lo95, hi95: mavLat.hi95 },
    },
    {
      strategyName: "bon-mav-4 (median)",
      accuracy: mavMedianAcc.mean,
      accuracyCI: { lo95: mavMedianAcc.lo95, hi95: mavMedianAcc.hi95 },
      meanCostCalls: mean(mavCost),
      meanLatencyMs: mavLat.mean,
      latencyCI: { lo95: mavLat.lo95, hi95: mavLat.hi95 },
    },
    {
      strategyName: "bon-mav-4 (majority-vote)",
      accuracy: mavVoteAcc.mean,
      accuracyCI: { lo95: mavVoteAcc.lo95, hi95: mavVoteAcc.hi95 },
      meanCostCalls: mean(mavCost),
      meanLatencyMs: mavLat.mean,
      latencyCI: { lo95: mavLat.lo95, hi95: mavLat.hi95 },
    },
  ];

  return {
    capturedAt: new Date().toISOString(),
    nTasks: N_TASKS,
    nCandidates: N_CANDIDATES,
    sigmaG: SIGMA_G,
    sigmaV: SIGMA_V,
    accuracyThreshold: ACCURACY_THRESHOLD,
    results,
  };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

// Only execute when this file is the entry point (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("sprint-a-bench.ts") || process.argv[1].endsWith("sprint-a-bench.js"));

if (isMain) {
  const report = await runBench();

  process.stdout.write("\n=== Sprint-A Bench Results ===\n\n");
  process.stdout.write(
    `Config: ${report.nTasks} tasks, N=${report.nCandidates}, σ_g=${report.sigmaG}, σ_v=${report.sigmaV}, threshold=${report.accuracyThreshold}\n\n`,
  );

  // Summary table (fixed-width)
  const header =
    "Strategy                          | Accuracy | ±95% CI        | Cost (calls) | Latency (ms)";
  const sep = "-".repeat(header.length);
  process.stdout.write(`${header}\n${sep}\n`);
  for (const r of report.results) {
    const name = r.strategyName.padEnd(33);
    const acc = `${(r.accuracy * 100).toFixed(1)}%`.padStart(7);
    const ciStr =
      `[${(r.accuracyCI.lo95 * 100).toFixed(1)}%, ${(r.accuracyCI.hi95 * 100).toFixed(1)}%]`.padEnd(
        15,
      );
    const cost = String(r.meanCostCalls.toFixed(1)).padStart(12);
    const lat = `${r.meanLatencyMs.toFixed(3)}`.padStart(12);
    process.stdout.write(`${name} | ${acc} | ${ciStr} | ${cost} | ${lat}\n`);
  }
  process.stdout.write("\n");

  // Gain relative to single-shot
  const ssBaseline = report.results[0];
  for (const r of report.results.slice(1)) {
    const baseAcc = ssBaseline?.accuracy ?? 0;
    const delta = ((r.accuracy - baseAcc) / Math.max(baseAcc, 0.001)) * 100;
    process.stdout.write(
      `  ${r.strategyName}: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs single-shot\n`,
    );
  }
  process.stdout.write("\n");

  const outPath = new URL("./sprint-a-results.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  process.stdout.write("Results → bench/sprint-a-results.json\n");
}
