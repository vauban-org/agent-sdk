/**
 * Eval harness — strategy × dataset → {accuracy, cost, latency, rationale}.
 *
 * Sprint-579: eval-harness. Product-agnostic; consumer apps supply their own datasets.
 *
 * Usage:
 *   const result = await evalSuite(singleShotStrategy, EVAL_DATASET_30);
 *   console.log(result.accuracy); // 0.73
 */

import type { EvalTask } from "./datasets/index.js";

// ─── Strategy ────────────────────────────────────────────────────────────────

export interface StrategyOutput {
  output: string;
  costUsd?: number;
  latencyMs?: number;
  candidates?: string[];
}

export interface EvalStrategy {
  name: string;
  run(prompt: string): Promise<StrategyOutput>;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface EvalTaskResult {
  taskId: string;
  category: string;
  difficulty: string;
  passed: boolean;
  output: string;
  score: number;
  latencyMs: number;
  costUsd: number;
  rationale?: string;
}

export interface EvalSuiteResult {
  strategy: string;
  accuracy: number;
  costUsd: number;
  latencyMs: number;
  rationale: EvalTaskResult[];
  meta: {
    totalTasks: number;
    passedTasks: number;
    failedTasks: number;
    durationMs: number;
  };
}

// ─── Scorers ─────────────────────────────────────────────────────────────────

function scoreExact(output: string, groundTruth: string | string[]): number {
  const normalized = output.trim().toLowerCase();
  const truths = Array.isArray(groundTruth) ? groundTruth : [groundTruth];
  return truths.some((gt) => normalized === gt.trim().toLowerCase()) ? 1 : 0;
}

function scoreContains(output: string, groundTruth: string | string[]): number {
  const normalized = output.toLowerCase();
  const truths = Array.isArray(groundTruth) ? groundTruth : [groundTruth];
  return truths.some((gt) => normalized.includes(gt.trim().toLowerCase())) ? 1 : 0;
}

function scoreNumericTolerance(
  output: string,
  groundTruth: string | string[],
  tolerance: number,
): number {
  const truths = Array.isArray(groundTruth) ? groundTruth : [groundTruth];
  const outputNum = Number.parseFloat(output.replace(/[^0-9.\-]/g, ""));
  if (Number.isNaN(outputNum)) return 0;
  return truths.some((gt) => {
    const gtNum = Number.parseFloat(gt.replace(/[^0-9.\-]/g, ""));
    return !Number.isNaN(gtNum) && Math.abs(outputNum - gtNum) <= tolerance;
  })
    ? 1
    : 0;
}

export function scoreTask(task: EvalTask, output: string): number {
  switch (task.scorer ?? "contains") {
    case "exact":
      return scoreExact(output, task.groundTruth);
    case "contains":
      return scoreContains(output, task.groundTruth);
    case "numeric_tolerance":
      return scoreNumericTolerance(output, task.groundTruth, task.tolerance ?? 0);
    case "code_output":
      // Placeholder: falls back to contains for now.
      return scoreContains(output, task.groundTruth);
    default:
      return scoreContains(output, task.groundTruth);
  }
}

// ─── Main harness ─────────────────────────────────────────────────────────────

/**
 * Run a strategy against a dataset of eval tasks.
 * Returns accuracy (0-1), total cost in USD, median latency in ms,
 * and per-task rationale.
 */
export async function evalSuite(
  strategy: EvalStrategy,
  dataset: EvalTask[],
): Promise<EvalSuiteResult> {
  const t0 = Date.now();
  const results: EvalTaskResult[] = [];

  for (const task of dataset) {
    const taskT0 = Date.now();
    let output = "";
    let costUsd = 0;
    let latencyMs = 0;
    let rationale: string | undefined;

    try {
      const stratOut = await strategy.run(task.prompt);
      output = stratOut.output;
      costUsd = stratOut.costUsd ?? 0;
      latencyMs = stratOut.latencyMs ?? Date.now() - taskT0;
    } catch (err) {
      output = "";
      rationale = `strategy.run threw: ${err instanceof Error ? err.message : String(err)}`;
      latencyMs = Date.now() - taskT0;
    }

    const score = scoreTask(task, output);

    results.push({
      taskId: task.id,
      category: task.category,
      difficulty: task.difficulty,
      passed: score >= 1,
      output,
      score,
      latencyMs,
      costUsd,
      rationale,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const accuracy = dataset.length > 0 ? passed / dataset.length : 0;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);

  const sortedLatencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const medianLatency =
    sortedLatencies.length > 0
      ? (sortedLatencies[Math.floor((sortedLatencies.length - 1) / 2)] ?? 0)
      : 0;

  return {
    strategy: strategy.name,
    accuracy,
    costUsd: totalCost,
    latencyMs: medianLatency,
    rationale: results,
    meta: {
      totalTasks: dataset.length,
      passedTasks: passed,
      failedTasks: dataset.length - passed,
      durationMs: Date.now() - t0,
    },
  };
}
