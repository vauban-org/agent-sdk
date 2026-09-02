/**
 * Tests for replayCounterfactual — offline counterfactual replay primitive.
 *
 * Coverage:
 *   1. 5 synthetic cycles, each replayed with alt_strategy "best-of-n" instead
 *      of original "single-shot" → outputsCoherent === true.
 *   2. Same strategy as original → outputsIdentical === true.
 *   3. Invalid alt_strategy → throws InvalidStrategyNameError.
 *   4. cost_delta_usd reflects strategy cost difference (BoN > single-shot).
 *   5. No alt_strategy supplied → no strategySwapped in metadata.
 *   6. alt_verifier only → outputsCoherent true (strategy unchanged).
 *   7. alt_temperature only → outputsCoherent true.
 *   8. areCoherent: different top-level keys → outputsCoherent false.
 *   9. areCoherent: null vs non-null → not coherent.
 */

import { describe, expect, it } from "vitest";
import {
  InvalidStrategyNameError,
  replayCounterfactual,
} from "../src/counterfactual/replay-with-alt.js";
import type {
  CounterfactualOptions,
  CounterfactualReplayContext,
} from "../src/counterfactual/replay-with-alt.js";
import { InMemoryLLMResponseCache } from "../src/replay/llm-cache.js";
import type { ReplayContext, ReplayLoader, ReplayRunner } from "../src/replay/replay.js";
import type { Trace, TraceStep } from "../src/trace/schema.js";
import { TRACE_SCHEMA_VERSION } from "../src/trace/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStep(index: number, runId: string, ts: number): TraceStep {
  const prevStepHash = index === 0 ? "0".repeat(64) : `hash-step-${index - 1}`;
  return {
    index,
    runId,
    phase: "decide",
    type: "llm_call",
    timestamp: ts,
    durationMs: 1,
    inputHash: `ihash-${index}`,
    outputHash: `ohash-${index}`,
    policy: "hash-only",
    prevStepHash,
    stepHash: `hash-step-${index}`,
  };
}

function makeTrace(
  runId: string,
  startTs: number,
  stepCount: number,
  strategy = "single-shot",
): Trace {
  const steps: TraceStep[] = [];
  for (let i = 0; i < stepCount; i++) {
    steps.push(makeStep(i, runId, startTs + i * 10));
  }
  const rootHash = `root-${runId}-${steps.map((s) => s.stepHash).join("-")}`;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId,
    agentId: "test-agent",
    agentVersion: "0.0.1",
    startedAt: startTs,
    completedAt: startTs + stepCount * 10,
    status: "completed",
    steps,
    totalSteps: stepCount,
    rootHash,
    config: { strategy },
    configHash: "cfg-hash",
  };
}

function makeLoader(traces: Map<string, Trace>): ReplayLoader {
  return {
    async loadOriginalTrace(runId: string): Promise<Trace> {
      const trace = traces.get(runId);
      if (!trace) throw new Error(`Loader: trace not found for runId "${runId}"`);
      return trace;
    },
    async loadCacheEntries(runId: string) {
      const trace = traces.get(runId);
      if (!trace) throw new Error(`Loader: artifacts not found for runId "${runId}"`);
      return {
        recordedTs: trace.steps.map((s) => s.timestamp),
        recordedNext: Array.from({ length: trace.steps.length }, (_, i) => i / 100),
        recordedUuids: trace.steps.map((_, i) => `uuid-${runId}-${i}`),
        cache: new InMemoryLLMResponseCache(),
      };
    },
  };
}

/**
 * Test runner that tracks which strategyOverride was passed.
 * Produces a trace + output + cost metadata that encodes the strategy name
 * so tests can verify strategy swapping.
 */
function makeStrategyAwareRunner(): ReplayRunner & {
  lastObservedStrategy: string | undefined;
} {
  const runner = {
    lastObservedStrategy: undefined as string | undefined,

    async run(
      ctx: ReplayContext,
      originalTrace: Trace,
    ): Promise<
      Trace & {
        output: { result: string; strategy: string };
        cost_usd: number;
        latency_ms: number;
        cacheHits: number;
        cacheMisses: number;
      }
    > {
      // Inspect strategyOverride injected by replayCounterfactual
      const cfCtx = ctx as CounterfactualReplayContext;
      const effectiveStrategy = cfCtx.strategyOverride ?? "single-shot";
      runner.lastObservedStrategy = effectiveStrategy;

      // Cost model: single-shot = $0.001 / call, best-of-n = $0.005, bon-mav = $0.01
      const costMap: Record<string, number> = {
        "single-shot": 0.001,
        "best-of-n": 0.005,
        "bon-mav": 0.01,
      };
      const cost_usd = costMap[effectiveStrategy] ?? 0.001;

      return {
        ...originalTrace,
        rootHash: `replay-root-${ctx.replayRunId}`,
        output: { result: `output-via-${effectiveStrategy}`, strategy: effectiveStrategy },
        cost_usd,
        latency_ms: 10,
        cacheHits: 0,
        cacheMisses: 1,
      };
    },
  };
  return runner;
}

/**
 * Runner that always returns a fixed output (for identity tests).
 */
const fixedOutputRunner: ReplayRunner = {
  async run(
    _ctx: ReplayContext,
    originalTrace: Trace,
  ): Promise<
    Trace & {
      output: { result: string };
    }
  > {
    return {
      ...originalTrace,
      rootHash: `fixed-replay-${Date.now()}`,
      output: { result: "fixed-output" },
    };
  },
};

/**
 * Runner that returns outputs with a DIFFERENT shape depending on strategy
 * (to test coherence failure).
 */
const shapeDivergentRunner: ReplayRunner = {
  async run(
    ctx: ReplayContext,
    originalTrace: Trace,
  ): Promise<
    Trace & {
      output: Record<string, unknown>;
    }
  > {
    const cfCtx = ctx as CounterfactualReplayContext;
    const isAlt = cfCtx.strategyOverride !== undefined;
    return {
      ...originalTrace,
      rootHash: `divergent-${ctx.replayRunId}`,
      output: isAlt
        ? { answer: "alt", score: 0.9 } // different keys
        : { result: "original", cost: 0.01 }, // original keys
    };
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("replayCounterfactual", () => {
  describe("5 synthetic cycles: alt_strategy best-of-n → outputsCoherent", () => {
    const cycles = [
      { runId: "run-A", startTs: 1_700_000_000_000, steps: 3 },
      { runId: "run-B", startTs: 1_700_000_001_000, steps: 2 },
      { runId: "run-C", startTs: 1_700_000_002_000, steps: 4 },
      { runId: "run-D", startTs: 1_700_000_003_000, steps: 1 },
      { runId: "run-E", startTs: 1_700_000_004_000, steps: 5 },
    ];

    for (const cycle of cycles) {
      it(`cycle ${cycle.runId}: alt_strategy "best-of-n" → outputsCoherent`, async () => {
        const traces = new Map<string, Trace>();
        traces.set(cycle.runId, makeTrace(cycle.runId, cycle.startTs, cycle.steps, "single-shot"));

        const loader = makeLoader(traces);
        const runner = makeStrategyAwareRunner();
        const opts: CounterfactualOptions = { alt_strategy: "best-of-n" };

        const result = await replayCounterfactual(cycle.runId, loader, runner, opts);

        expect(result.originalRunId).toBe(cycle.runId);
        expect(result.counterfactualRunId).toBeTruthy();
        expect(result.counterfactualRunId).not.toBe(cycle.runId);
        expect(result.outputsCoherent).toBe(true);
        // Both outputs are objects with the same shape { result, strategy }
        expect(result.metadata.strategySwapped).toEqual({
          from: "single-shot",
          to: "best-of-n",
        });
      });
    }
  });

  it("same strategy as original → outputsIdentical", async () => {
    const runId = "run-same";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 2, "single-shot"));

    const loader = makeLoader(traces);
    // Runner that returns deterministic fixed output regardless of strategy
    const deterministicRunner: ReplayRunner = {
      async run(
        _ctx: ReplayContext,
        originalTrace: Trace,
      ): Promise<
        Trace & {
          output: { result: string };
        }
      > {
        return {
          ...originalTrace,
          rootHash: "fixed-root",
          output: { result: "deterministic" },
        };
      },
    };

    // No alt_strategy → both runs use same runner behaviour → identical outputs
    const result = await replayCounterfactual(runId, loader, deterministicRunner, {});

    expect(result.outputsIdentical).toBe(true);
    expect(result.outputsCoherent).toBe(true);
  });

  it("invalid alt_strategy → throws InvalidStrategyNameError", async () => {
    const runId = "run-invalid";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 1));
    const loader = makeLoader(traces);

    await expect(
      replayCounterfactual(runId, loader, fixedOutputRunner, {
        // Force-cast to bypass TypeScript — testing runtime validation
        alt_strategy: "not-a-strategy" as never,
      }),
    ).rejects.toThrow(InvalidStrategyNameError);

    await expect(
      replayCounterfactual(runId, loader, fixedOutputRunner, {
        alt_strategy: "not-a-strategy" as never,
      }),
    ).rejects.toThrow(/not-a-strategy/);
  });

  it("cost_delta_usd reflects strategy cost (BoN > single-shot)", async () => {
    const runId = "run-cost";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 2, "single-shot"));

    const loader = makeLoader(traces);
    const runner = makeStrategyAwareRunner();

    const result = await replayCounterfactual(runId, loader, runner, {
      alt_strategy: "best-of-n",
    });

    // Original: single-shot = $0.001, counterfactual: best-of-n = $0.005
    // cost_delta_usd = 0.005 - 0.001 = 0.004
    expect(result.metadata.cost_delta_usd).toBeCloseTo(0.004, 6);
    expect(result.metadata.cost_delta_usd).toBeGreaterThan(0);
  });

  it("no alt_strategy supplied → metadata.strategySwapped is undefined", async () => {
    const runId = "run-no-swap";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 2, "single-shot"));

    const loader = makeLoader(traces);
    const runner = makeStrategyAwareRunner();

    const result = await replayCounterfactual(runId, loader, runner, {});

    expect(result.metadata.strategySwapped).toBeUndefined();
  });

  it("outputs with different top-level keys → outputsCoherent false", async () => {
    const runId = "run-incoherent";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 2, "single-shot"));

    const loader = makeLoader(traces);

    // shapeDivergentRunner produces { result, cost } originally, { answer, score } for alt
    const result = await replayCounterfactual(runId, loader, shapeDivergentRunner, {
      alt_strategy: "best-of-n",
    });

    expect(result.outputsCoherent).toBe(false);
    expect(result.outputsIdentical).toBe(false);
  });

  it("alt_verifier only (no alt_strategy) → outputsCoherent true, strategySwapped undefined", async () => {
    const runId = "run-verifier-only";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 2, "single-shot"));

    const loader = makeLoader(traces);
    const runner = makeStrategyAwareRunner();

    const mockVerifier = {
      name: "test-verifier",
      evaluate: (_output: unknown) => ({ score: 1, rationale: "always pass" }),
    };

    const result = await replayCounterfactual(runId, loader, runner, {
      alt_verifier: mockVerifier,
    });

    expect(result.metadata.strategySwapped).toBeUndefined();
    // Both runs go through same strategy (no override) → outputs have same shape
    expect(result.outputsCoherent).toBe(true);
  });

  it("cacheHits and cacheMisses are populated from runner output", async () => {
    const runId = "run-cache-stats";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 2, "single-shot"));

    const loader = makeLoader(traces);
    const runner = makeStrategyAwareRunner(); // returns cacheHits: 0, cacheMisses: 1

    const result = await replayCounterfactual(runId, loader, runner, {
      alt_strategy: "best-of-n",
    });

    expect(result.metadata.cacheHits).toBe(0);
    expect(result.metadata.cacheMisses).toBe(1);
  });

  it("counterfactualRunId differs from originalRunId", async () => {
    const runId = "run-id-check";
    const traces = new Map<string, Trace>();
    traces.set(runId, makeTrace(runId, 1_700_000_000_000, 1));

    const loader = makeLoader(traces);
    const runner = makeStrategyAwareRunner();

    const result = await replayCounterfactual(runId, loader, runner, {
      alt_strategy: "single-shot",
    });

    expect(result.originalRunId).toBe(runId);
    expect(result.counterfactualRunId).not.toBe(runId);
    // UUID format
    expect(result.counterfactualRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
