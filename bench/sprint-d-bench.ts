/**
 * bench/sprint-d-bench.ts
 *
 * Sprint-584 — DeepSeek baseline cost reduction bench.
 *
 * Simulates 100 synthetic cycles across 4 categories (25 each: simple,
 * standard, complex, reasoning). Each cycle has deterministic random token
 * counts drawn from a seeded LCG (seed=42).
 *
 * Baseline: all cycles routed to deepseek-v4-pro (premium tier).
 * Router: EconomyRouter with DefaultTierPolicy in degraded mode.
 *
 * Metric: reduction = (baseline_total - router_total) / baseline_total * 100
 * Acceptance gate: reduction ≥ 10 %
 * Failure budget: if reduction < 5 % → emit recommendation to skip router.
 *
 * Run: pnpm tsx bench/sprint-d-bench.ts
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { DefaultTierPolicy } from "../src/economy/tier-policy.js";
import type { ModelTier } from "../src/economy/tier-policy.js";
import { OutcomeTracker } from "../src/economy/outcome-tracker.js";
import { EconomyRouter } from "../src/economy/router.js";
import { FleetCircuitBreaker } from "../src/economy/circuit-breaker.js";

// ─── PRNG (LCG, seed=42) ──────────────────────────────────────────────────

/**
 * Linear Congruential Generator — Numerical Recipes params.
 * Returns a function that yields floats in [0, 1).
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    // LCG: Xn+1 = (a * Xn + c) mod m
    // a=1664525, c=1013904223, m=2^32
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Return a random integer in [lo, hi] (inclusive) using rng.
 */
function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ─── Pricing (hardcoded, per task spec) ──────────────────────────────────

const PRICING: Record<string, { in: number; out: number }> = {
  "deepseek-v4-pro": { in: 0.27, out: 1.1 },
  "deepseek-v4-flash": { in: 0.07, out: 0.28 },
  "llama-3.3-70b-versatile": { in: 0.0, out: 0.0 },
  "default-fast": { in: 0.0, out: 0.0 },
};

function cycleCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model];
  if (p === undefined) return 0;
  return (inputTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
}

// ─── Cycle shape ──────────────────────────────────────────────────────────

export interface CycleSample {
  category: string;
  inputTokens: number;
  outputTokens: number;
}

export interface BenchResult {
  nCycles: number;
  baselineTotalUsd: number;
  routerTotalUsd: number;
  reductionPct: number;
  cycleRows: Array<{
    idx: number;
    category: string;
    inputTokens: number;
    outputTokens: number;
    baselineCostUsd: number;
    routerCostUsd: number;
    routerTier: string;
    routerReason: string;
  }>;
  verdict: "PASS" | "FAIL" | "SKIP_ROUTER";
  recommendation: string;
}

// ─── Main bench ───────────────────────────────────────────────────────────

export function runBench(seed = 42): BenchResult {
  const rng = lcg(seed);
  const categories = ["simple", "standard", "complex", "reasoning"] as const;
  const N = 100;
  const perCategory = N / categories.length; // 25 each

  // Build cycle samples — deterministic
  const samples: CycleSample[] = [];
  for (const cat of categories) {
    for (let i = 0; i < perCategory; i++) {
      samples.push({
        category: cat,
        inputTokens: randInt(rng, 500, 4000),
        outputTokens: randInt(rng, 100, 800),
      });
    }
  }

  // ── Baseline: all cycles to deepseek-v4-pro ──────────────────────────
  const PREMIUM_MODEL = "deepseek-v4-pro";
  let baselineTotalUsd = 0;
  for (const s of samples) {
    baselineTotalUsd += cycleCostUsd(PREMIUM_MODEL, s.inputTokens, s.outputTokens);
  }

  // ── Router: EconomyRouter + DefaultTierPolicy ────────────────────────
  const policy = new DefaultTierPolicy();
  // High threshold so breaker never trips during bench
  const breaker = new FleetCircuitBreaker({ thresholdUsd: 1_000_000 });
  const tracker = new OutcomeTracker(policy);
  const router = new EconomyRouter({
    mode: "degraded",
    policy,
    tracker,
    breaker,
  });

  let routerTotalUsd = 0;
  const cycleRows: BenchResult["cycleRows"] = [];

  for (let idx = 0; idx < samples.length; idx++) {
    const s = samples[idx]!;
    const decision = router.route(s.category);
    const tier: ModelTier = decision.tier;
    const routerCost = cycleCostUsd(tier.model, s.inputTokens, s.outputTokens);
    const baselineCost = cycleCostUsd(PREMIUM_MODEL, s.inputTokens, s.outputTokens);

    routerTotalUsd += routerCost;

    // Record outcome so tracker accumulates history (enables "full" mode later)
    router.recordOutcome(`bench-run-${idx}`, tier, s.inputTokens, s.outputTokens, 0, {
      category: s.category,
    });

    cycleRows.push({
      idx,
      category: s.category,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      baselineCostUsd: baselineCost,
      routerCostUsd: routerCost,
      routerTier: tier.label,
      routerReason: decision.reason,
    });
  }

  const reductionPct =
    baselineTotalUsd > 0 ? ((baselineTotalUsd - routerTotalUsd) / baselineTotalUsd) * 100 : 0;

  let verdict: BenchResult["verdict"];
  let recommendation: string;

  if (reductionPct >= 10) {
    verdict = "PASS";
    recommendation = "EconomyRouter delivers ≥10 % cost reduction. Ship router.";
  } else if (reductionPct < 5) {
    verdict = "SKIP_ROUTER";
    recommendation =
      `Reduction < 5 % (${reductionPct.toFixed(2)} %). ` +
      "Router overhead not justified — ship cost tracking only, defer routing.";
  } else {
    verdict = "FAIL";
    recommendation =
      `Reduction ${reductionPct.toFixed(2)} % is between 5-10 %. ` +
      "Insufficient for acceptance. Tune policy or defer router.";
  }

  return {
    nCycles: N,
    baselineTotalUsd,
    routerTotalUsd,
    reductionPct,
    cycleRows,
    verdict,
    recommendation,
  };
}

// ─── CLI output ───────────────────────────────────────────────────────────

function formatUsd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function main(): void {
  const result = runBench(42);

  // Summary table header
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         Sprint-584 — DeepSeek Baseline Cost Reduction Bench      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  console.log(`Cycles       : ${result.nCycles}`);
  console.log(`Baseline     : ${formatUsd(result.baselineTotalUsd)}  (all deepseek-v4-pro)`);
  console.log(`Router       : ${formatUsd(result.routerTotalUsd)}  (EconomyRouter degraded mode)`);
  console.log(`Reduction    : ${result.reductionPct.toFixed(2)} %  (acceptance gate: ≥10 %)`);
  console.log(`Verdict      : ${result.verdict}`);
  console.log(`Recommendation: ${result.recommendation}\n`);

  // Per-category breakdown
  const categories = ["simple", "standard", "complex", "reasoning"];
  console.log("Category breakdown:");
  console.log("  Category    | Cycles | Baseline total  | Router total    | Reduction %");
  console.log("  ------------|--------|-----------------|-----------------|------------");
  for (const cat of categories) {
    const rows = result.cycleRows.filter((r) => r.category === cat);
    const bTotal = rows.reduce((s, r) => s + r.baselineCostUsd, 0);
    const rTotal = rows.reduce((s, r) => s + r.routerCostUsd, 0);
    const red = bTotal > 0 ? ((bTotal - rTotal) / bTotal) * 100 : 0;
    console.log(
      `  ${cat.padEnd(11)} | ${String(rows.length).padStart(6)} | ${formatUsd(bTotal).padStart(15)} | ${formatUsd(rTotal).padStart(15)} | ${red.toFixed(2)} %`,
    );
  }
  console.log();

  // Tier distribution
  const tierCounts: Record<string, number> = {};
  for (const row of result.cycleRows) {
    tierCounts[row.routerTier] = (tierCounts[row.routerTier] ?? 0) + 1;
  }
  console.log("Tier distribution (router):");
  for (const [tier, count] of Object.entries(tierCounts)) {
    console.log(`  ${tier.padEnd(10)}: ${count} cycles`);
  }
  console.log();

  // Write results.md
  const mdLines: string[] = [
    "# Sprint-584 Bench Results — DeepSeek Baseline Cost Reduction",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Seed: 42 (deterministic LCG)`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Cycles | ${result.nCycles} |`,
    `| Baseline total (all premium) | ${formatUsd(result.baselineTotalUsd)} |`,
    `| Router total | ${formatUsd(result.routerTotalUsd)} |`,
    `| Cost reduction | **${result.reductionPct.toFixed(2)} %** |`,
    `| Acceptance gate | ≥ 10 % |`,
    `| Verdict | **${result.verdict}** |`,
    "",
    `**Recommendation**: ${result.recommendation}`,
    "",
    "## Category Breakdown",
    "",
    "| Category | Cycles | Baseline total | Router total | Reduction % |",
    "|----------|--------|----------------|--------------|-------------|",
  ];

  for (const cat of categories) {
    const rows = result.cycleRows.filter((r) => r.category === cat);
    const bTotal = rows.reduce((s, r) => s + r.baselineCostUsd, 0);
    const rTotal = rows.reduce((s, r) => s + r.routerCostUsd, 0);
    const red = bTotal > 0 ? ((bTotal - rTotal) / bTotal) * 100 : 0;
    mdLines.push(
      `| ${cat} | ${rows.length} | ${formatUsd(bTotal)} | ${formatUsd(rTotal)} | ${red.toFixed(2)} % |`,
    );
  }

  mdLines.push("", "## Tier Distribution (Router)", "", "| Tier | Cycles |", "|------|--------|");
  for (const [tier, count] of Object.entries(tierCounts)) {
    mdLines.push(`| ${tier} | ${count} |`);
  }

  mdLines.push(
    "",
    "## Pricing Used",
    "",
    "| Model | In ($/M) | Out ($/M) | Tier |",
    "|-------|----------|-----------|------|",
    "| deepseek-v4-pro | 0.27 | 1.10 | premium |",
    "| deepseek-v4-flash | 0.07 | 0.28 | cheap |",
    "| llama-3.3-70b-versatile (Groq) | 0.00 | 0.00 | mid |",
    "| default-fast (LiteLLM/Qwen3-8B) | 0.00 | 0.00 | free |",
    "",
    "## Methodology",
    "",
    "- 100 synthetic cycles, 25 per category (simple / standard / complex / reasoning).",
    "- inputTokens ~ Uniform[500, 4000], outputTokens ~ Uniform[100, 800].",
    "- Deterministic LCG PRNG, seed=42 — 100 % reproducible.",
    "- Baseline: all cycles to `deepseek-v4-pro` (premium).",
    "- Router: `EconomyRouter` + `DefaultTierPolicy` in `degraded` mode (no prior history → policy defaults).",
    "- Circuit breaker threshold set to $1,000,000 to prevent trips during bench.",
  );

  const mdPath = new URL("./sprint-d-results.md", import.meta.url).pathname;
  if (process.env.BENCH_WRITE_RESULTS === "1") {
    // Extract existing frontmatter (YAML header between --- markers)
    let frontmatter = "";
    if (existsSync(mdPath)) {
      const existing = readFileSync(mdPath, "utf-8");
      const match = existing.match(/^---\n([\s\S]*?)\n---\n/);
      if (match) {
        frontmatter = `---\n${match[1]}\n---\n`;
      }
    }

    const content = frontmatter + mdLines.join("\n") + "\n";
    writeFileSync(mdPath, content);
    console.log(`Results written to ${mdPath}`);
  } else {
    console.log(
      `\n⚠️  Results NOT written (set BENCH_WRITE_RESULTS=1 to overwrite sprint-d-results.md)\n`,
    );
  }
}

main();
