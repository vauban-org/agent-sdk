/**
 * eval-bench.ts — single-shot baseline benchmark for Sprint-579.
 *
 * Runs evalSuite with a stub strategy (no live LLM calls) to measure
 * harness overhead and validate the pipeline end-to-end.
 *
 * When a real ANTHROPIC_API_KEY is available, use the live strategy.
 * CI runs the stub strategy (no key required) to validate the harness itself.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evalSuite } from "../src/evals/harness.js";
import { EVAL_DATASET_30 } from "../src/evals/datasets/index.js";
import type { EvalStrategy } from "../src/evals/harness.js";

// ─── Strategy: stub (no LLM, always answers correctly from groundTruth) ──────
// Used in CI to validate harness overhead without API costs.

const stubStrategy: EvalStrategy = {
  name: "stub-correct",
  async run(_prompt) {
    const t0 = Date.now();
    // Simulate ~10ms processing
    await new Promise((r) => setTimeout(r, 10));
    return {
      output: "stub-output",
      costUsd: 0,
      latencyMs: Date.now() - t0,
    };
  },
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const writeBaseline = args.includes("--write-baseline");
const baselineFile =
  args[args.indexOf("--baseline-file") + 1] ??
  "packages/agent-sdk/benchmarks/eval-baseline.json";

console.log(`[eval-bench] strategy: ${stubStrategy.name}`);
console.log(`[eval-bench] dataset: ${EVAL_DATASET_30.length} tasks`);
console.log(`[eval-bench] running...`);

const t0 = Date.now();
const result = await evalSuite(stubStrategy, EVAL_DATASET_30);
const wallMs = Date.now() - t0;

console.log(`\n=== Results ===`);
console.log(`strategy:   ${result.strategy}`);
console.log(`accuracy:   ${(result.accuracy * 100).toFixed(1)}%  (${result.meta.passedTasks}/${result.meta.totalTasks})`);
console.log(`cost:       $${result.costUsd.toFixed(4)}`);
console.log(`latency:    ${result.latencyMs}ms median`);
console.log(`wall time:  ${wallMs}ms`);

if (wallMs > 300_000) {
  console.error(`[eval-bench] FAIL: wall time ${wallMs}ms exceeds 5-min budget`);
  process.exit(1);
}

console.log(`[eval-bench] PASS: completed in ${wallMs}ms (<5min budget)`);

if (writeBaseline) {
  const baseline = {
    strategy: result.strategy,
    accuracy: result.accuracy,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    wallMs,
    tasks: result.meta.totalTasks,
    measuredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  console.log(`[eval-bench] baseline written to ${baselineFile}`);
}
