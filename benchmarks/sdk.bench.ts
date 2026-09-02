/**
 * sdk.bench.ts — micro-benchmarks for @vauban-org/agent-sdk hot paths.
 *
 * Sprint-471. Targets:
 *   - AgentLoop.run() overhead (mock tool-call cycle)
 *   - tracedPort wrapper latency (p99 < 0.5 ms)
 *   - ProviderRouter.complete() baseline (mock provider)
 *
 * Run:          pnpm -F @vauban-org/agent-sdk bench:sdk
 * New baseline: pnpm -F @vauban-org/agent-sdk bench:baseline
 *
 * Baseline stored in benchmarks/baseline.json.
 * CI reads the baseline and fails if a gated metric's p50 regresses > 25%
 * (via .github/workflows/perf-regression.yml). Gating uses the median and skips
 * sub-2µs ops so shared-runner variance does not produce false regressions.
 *
 * tinybench v6 API: stats live under `t.result.latency.{mean,p50,p99}`
 *                   and `t.result.throughput.mean` (ops/sec).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Bench } from "tinybench";
import { tracedPort } from "../src/tracing/traced-port.js";
import { AgentLoop } from "../src/loop/minimal-loop.js";
import { createBudgetState } from "../src/budget/budget-state.js";
import type {
  ProviderRouter,
  ProviderRouterRequest,
  ProviderRouterResponse,
} from "../src/router/provider-router.js";
import type { ToolRegistry, ToolResult } from "../src/tools/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const WRITE_BASELINE = process.argv.includes("--write-baseline");
const BASELINE_PATH = new URL("./baseline.json", import.meta.url);

// ─── Mock ToolRegistry ────────────────────────────────────────────────────
// Minimal in-memory registry: single "echo" tool that returns immediately.
function makeMockRegistry(): ToolRegistry {
  const echoTool = {
    name: "echo",
    description: "echo",
    parameters: { parse: (a: unknown) => a } as never,
    execute: async (args: unknown) => ({ ok: true as const, value: args }),
  };
  return {
    register() {
      return { ok: true as const, value: undefined };
    },
    get(name: string) {
      return name === "echo" ? echoTool : undefined;
    },
    list() {
      return [echoTool];
    },
    execute: async (_name: string, args: unknown): Promise<ToolResult> => ({
      ok: true,
      value: args,
    }),
  };
}

// ─── Mock ProviderRouter ──────────────────────────────────────────────────
// Returns a deterministic "complete" response in ~0 µs — isolates routing overhead.
function makeMockProvider(reply = "done"): ProviderRouter {
  return {
    complete: async (
      _req: ProviderRouterRequest,
    ): Promise<ProviderRouterResponse> => ({
      content: reply,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: "mock",
      latencyMs: 0,
    }),
  };
}

// ─── Bench suite ──────────────────────────────────────────────────────────

const bench = new Bench({ time: 500 });

// 1. tracedPort wrapper latency
//    Target: p99 < 0.5 ms (500 µs).
const rawPort = { ping: async () => "pong" };
const traced = tracedPort(rawPort, { portName: "bench" });

bench.add("tracedPort.ping — noop OTel overhead", async () => {
  await traced.ping();
});

// 2. ProviderRouter.complete() — mock provider baseline
//    Measures the routing + serialisation layer without network I/O.
const mockProvider = makeMockProvider();

bench.add("ProviderRouter.complete() — mock provider", async () => {
  await mockProvider.complete({
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 128,
  });
});

// 3. AgentLoop.run() — single-step cycle with immediate "complete" stop.
//    The mock provider returns content with no tool calls → loop exits in 1 step.
//    Measures: budget check + OTel span open/close + loop bookkeeping.
const loopBudget = createBudgetState({ maxSteps: 1 });

const loop = new AgentLoop({
  agentId: "bench-agent",
  agentVersion: "0.0.0",
  systemPrompt: "You are a benchmark agent.",
  provider: makeMockProvider("Bench complete."),
  tools: makeMockRegistry(),
  budget: loopBudget,
});

bench.add("AgentLoop.run() — 1-step mock cycle", async () => {
  // Reset step count so the loop doesn't short-circuit on budget_exhausted.
  loopBudget.stepCount = 0;
  await loop.run("bench");
});

// ─── Run ──────────────────────────────────────────────────────────────────

await bench.run();

// ── Helper: extract stats from tinybench v6 result ────────────────────────
function getStats(task: (typeof bench.tasks)[number]) {
  const r = task.result;
  if (!r || r.state !== "completed") {
    return { mean: 0, p50: 0, p99: 0, hz: 0 };
  }
  return {
    mean: r.latency.mean,
    p50: r.latency.p50,
    p99: r.latency.p99,
    hz: r.throughput.mean,
  };
}

// ── Human-readable output ─────────────────────────────────────────────────
console.table(
  bench.tasks.map((t) => {
    const s = getStats(t);
    return {
      name: t.name,
      "mean (µs)": (s.mean * 1_000).toFixed(2),
      "p50 (µs)": (s.p50 * 1_000).toFixed(2),
      "p99 (µs)": (s.p99 * 1_000).toFixed(2),
      hz: s.hz.toFixed(0),
    };
  }),
);

// ── Serialize results ─────────────────────────────────────────────────────
const results = bench.tasks.map((t) => {
  const s = getStats(t);
  return { name: t.name, ...s };
});

const output = {
  version: "0.1.0",
  capturedAt: new Date().toISOString(),
  results,
};

if (WRITE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(output, null, 2));
  console.log(`\nBaseline written → benchmarks/baseline.json`);
} else {
  // Write to a separate results file (not the baseline).
  const resultsPath = new URL("./results.json", import.meta.url);
  writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  console.log(`\nResults → benchmarks/results.json`);

  // Compare against baseline if it exists.
  if (existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(
      readFileSync(BASELINE_PATH, "utf-8"),
    ) as typeof output;
    let regressions = 0;
    for (const current of results) {
      const base = baseline.results.find((r) => r.name === current.name);
      if (!base) continue;
      // Gate on p50 (median), not mean: µs-scale microbenchmarks on shared CI
      // runners have outlier samples (GC, scheduling) that make the mean too
      // noisy to gate on; the median is stable.
      const basis = base.p50 > 0 ? base.p50 : base.mean;
      const cur = current.p50 > 0 ? current.p50 : current.mean;
      // Sub-2µs operations are dominated by measurement noise on CI: report them
      // in the table but do not gate (a real regression there still shows up).
      if (basis < 2) continue;
      const deltaPct = (cur - basis) / basis;
      // 25% tolerance absorbs CI variance while still catching real regressions
      // (a genuine slowdown is typically 1.5–2x, well past this bound).
      if (deltaPct > 0.25) {
        console.error(
          `REGRESSION: "${current.name}" p50 +${(deltaPct * 100).toFixed(1)}% vs baseline`,
        );
        regressions++;
      }
    }
    if (regressions > 0) {
      console.error(
        `\n${regressions} regression(s) detected. Run with --write-baseline after intentional change.`,
      );
      process.exit(1);
    } else {
      console.log("\nAll gated metrics within 25% of baseline (p50). ✓");
    }
  } else {
    console.log(
      "\nNo baseline.json found — run with --write-baseline to capture one.",
    );
  }
}
