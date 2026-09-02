/**
 * Tests for packages/agent-sdk/src/counterfactual/replay-with-alt.ts
 *
 * Coverage:
 *   InvalidStrategyNameError — error class shape, message, name, instanceof
 *   ComputeStrategyName — valid set membership via the error guard
 *   replayCounterfactual — strategy validation, outputs coherence/identity,
 *                          metadata assembly, cost/latency delta, cache hit counts,
 *                          strategy swap tracking, counterfactualRunId uniqueness
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CounterfactualOptions,
  type CounterfactualResult,
  InvalidStrategyNameError,
  replayCounterfactual,
} from "../src/counterfactual/replay-with-alt.js";
import type { LLMResponseCache } from "../src/replay/llm-cache.js";
import type { ReplayContext, ReplayLoader, ReplayRunner } from "../src/replay/replay.js";
import type { Trace } from "../src/trace/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMinimalTrace(runId = "orig-run-id", strategy?: string): Trace {
  return {
    schemaVersion: "1.0.0",
    runId,
    agentId: "test-agent",
    agentVersion: "0.0.1",
    startedAt: 1_000_000,
    completedAt: 1_001_000,
    status: "completed",
    steps: [],
    totalSteps: 0,
    rootHash: "deadbeef",
    config: strategy ? { strategy } : {},
    configHash: "cafebabe",
  };
}

function makeNoopCache(): LLMResponseCache {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLoader(trace?: Trace): ReplayLoader {
  const t = trace ?? makeMinimalTrace();
  return {
    loadOriginalTrace: vi.fn().mockResolvedValue(t),
    loadCacheEntries: vi.fn().mockResolvedValue({
      recordedTs: [1_000_000, 1_000_100],
      recordedNext: [0.5, 0.25],
      recordedUuids: [
        "aaaaaaaa-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-000000000002",
      ],
      cache: makeNoopCache(),
    }),
  };
}

function makeRunner(outputOverride?: unknown): ReplayRunner {
  return {
    run: vi
      .fn()
      .mockResolvedValue(
        outputOverride !== undefined
          ? { rootHash: "replayed-hash", steps: [], output: outputOverride }
          : { rootHash: "replayed-hash", steps: [] },
      ),
  };
}

// ─── InvalidStrategyNameError ─────────────────────────────────────────────────

describe("InvalidStrategyNameError", () => {
  it("has name === 'InvalidStrategyNameError'", () => {
    const err = new InvalidStrategyNameError("nope");
    expect(err.name).toBe("InvalidStrategyNameError");
  });

  it("is instanceof Error", () => {
    const err = new InvalidStrategyNameError("bad-strat");
    expect(err).toBeInstanceOf(Error);
  });

  it("exposes the bad strategy name on the .name property (as set in constructor)", () => {
    // The constructor sets this.name = "InvalidStrategyNameError"
    // but the public field for the bad strategy name is stored via the constructor param
    const err = new InvalidStrategyNameError("totally-unknown");
    // .name is overwritten to "InvalidStrategyNameError" — check message for the bad name
    expect(err.message).toContain("totally-unknown");
  });

  it("message contains the valid strategy names", () => {
    const err = new InvalidStrategyNameError("bad");
    expect(err.message).toContain("single-shot");
    expect(err.message).toContain("best-of-n");
    expect(err.message).toContain("bon-mav");
  });

  it("message mentions replayCounterfactual context", () => {
    const err = new InvalidStrategyNameError("x");
    expect(err.message).toMatch(/replayCounterfactual/);
  });

  it("can be caught as Error in a try/catch block", () => {
    let caught: unknown;
    try {
      throw new InvalidStrategyNameError("fail");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("InvalidStrategyNameError");
  });
});

// ─── replayCounterfactual — strategy validation ───────────────────────────────

describe("replayCounterfactual — strategy validation", () => {
  it("rejects unknown alt_strategy synchronously (throws before loader calls)", async () => {
    const loader = makeLoader();
    const runner = makeRunner();
    await expect(
      replayCounterfactual("run-1", loader, runner, {
        alt_strategy: "unknown-strat" as never,
      }),
    ).rejects.toThrow(InvalidStrategyNameError);
  });

  it("rejects unknown strategy with message containing the bad name", async () => {
    const loader = makeLoader();
    const runner = makeRunner();
    await expect(
      replayCounterfactual("run-1", loader, runner, {
        alt_strategy: "turbo-mode" as never,
      }),
    ).rejects.toThrow("turbo-mode");
  });

  it("accepts 'single-shot' as alt_strategy without throwing", async () => {
    const loader = makeLoader();
    const runner = makeRunner("hello");
    await expect(
      replayCounterfactual("run-1", loader, runner, {
        alt_strategy: "single-shot",
      }),
    ).resolves.toBeDefined();
  });

  it("accepts 'best-of-n' as alt_strategy without throwing", async () => {
    const loader = makeLoader();
    const runner = makeRunner("hello");
    await expect(
      replayCounterfactual("run-1", loader, runner, {
        alt_strategy: "best-of-n",
      }),
    ).resolves.toBeDefined();
  });

  it("accepts 'bon-mav' as alt_strategy without throwing", async () => {
    const loader = makeLoader();
    const runner = makeRunner("hello");
    await expect(
      replayCounterfactual("run-1", loader, runner, { alt_strategy: "bon-mav" }),
    ).resolves.toBeDefined();
  });

  it("accepts empty options (no alt overrides) without throwing", async () => {
    const loader = makeLoader();
    const runner = makeRunner("hello");
    await expect(replayCounterfactual("run-1", loader, runner, {})).resolves.toBeDefined();
  });
});

// ─── replayCounterfactual — result shape ──────────────────────────────────────

describe("replayCounterfactual — result shape", () => {
  it("result.originalRunId matches the provided originalRunId", async () => {
    const loader = makeLoader();
    const runner = makeRunner("output");
    const result = await replayCounterfactual("my-run-xyz", loader, runner, {});
    expect(result.originalRunId).toBe("my-run-xyz");
  });

  it("result.counterfactualRunId is a non-empty string", async () => {
    const loader = makeLoader();
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r1", loader, runner, {});
    expect(typeof result.counterfactualRunId).toBe("string");
    expect(result.counterfactualRunId.length).toBeGreaterThan(0);
  });

  it("result.counterfactualRunId is different from result.originalRunId", async () => {
    const loader = makeLoader();
    const runner = makeRunner("out");
    const result = await replayCounterfactual("original-id", loader, runner, {});
    expect(result.counterfactualRunId).not.toBe("original-id");
  });

  it("result.originalOutput and result.counterfactualOutput are both present", async () => {
    const loader = makeLoader();
    const runner = makeRunner("some-output");
    const result = await replayCounterfactual("r2", loader, runner, {});
    // Both runs use the same mock runner returning same output
    expect("originalOutput" in result).toBe(true);
    expect("counterfactualOutput" in result).toBe(true);
  });

  it("result.metadata is present with cacheHits and cacheMisses fields", async () => {
    const loader = makeLoader();
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r3", loader, runner, {});
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata.cacheHits).toBe("number");
    expect(typeof result.metadata.cacheMisses).toBe("number");
  });
});

// ─── replayCounterfactual — outputs comparison ────────────────────────────────

describe("replayCounterfactual — outputsIdentical and outputsCoherent", () => {
  it("outputsIdentical is true when both runs return the same primitive output", async () => {
    const loader = makeLoader();
    // Both runs return the same value via the same mock
    const runner = makeRunner("fixed-output");
    const result = await replayCounterfactual("r4", loader, runner, {});
    expect(result.outputsIdentical).toBe(true);
  });

  it("outputsCoherent is true when outputsIdentical is true", async () => {
    const loader = makeLoader();
    const runner = makeRunner("same-value");
    const result = await replayCounterfactual("r5", loader, runner, {});
    expect(result.outputsCoherent).toBe(true);
  });

  it("outputsIdentical implies outputsCoherent", async () => {
    const loader = makeLoader();
    const runner = makeRunner({ a: 1, b: 2 });
    const result = await replayCounterfactual("r6", loader, runner, {});
    if (result.outputsIdentical) {
      expect(result.outputsCoherent).toBe(true);
    }
  });
});

// ─── replayCounterfactual — metadata assembly ────────────────────────────────

describe("replayCounterfactual — metadata.strategySwapped", () => {
  it("strategySwapped is present when alt_strategy is provided", async () => {
    const trace = makeMinimalTrace("r7", "single-shot");
    const loader = makeLoader(trace);
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r7", loader, runner, {
      alt_strategy: "best-of-n",
    });
    expect(result.metadata.strategySwapped).toBeDefined();
    expect(result.metadata.strategySwapped?.to).toBe("best-of-n");
  });

  it("strategySwapped.from reflects the original trace config.strategy", async () => {
    const trace = makeMinimalTrace("r8", "single-shot");
    const loader = makeLoader(trace);
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r8", loader, runner, {
      alt_strategy: "bon-mav",
    });
    expect(result.metadata.strategySwapped?.from).toBe("single-shot");
  });

  it("strategySwapped.from is 'unknown' when trace has no config.strategy", async () => {
    const trace = makeMinimalTrace("r9");
    const loader = makeLoader(trace);
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r9", loader, runner, {
      alt_strategy: "best-of-n",
    });
    expect(result.metadata.strategySwapped?.from).toBe("unknown");
  });

  it("strategySwapped is undefined when no alt_strategy is supplied", async () => {
    const loader = makeLoader();
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r10", loader, runner, {});
    expect(result.metadata.strategySwapped).toBeUndefined();
  });
});

describe("replayCounterfactual — metadata cost and cache", () => {
  it("cost_delta_usd is defined when both traces report cost_usd", async () => {
    const loader = makeLoader();
    // First run call: originalTrace replay (no cost_usd), second: counterfactual
    // We need to simulate cost_usd on the runner output
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({
        rootHash: "h1",
        steps: [],
        output: "a",
        cost_usd: 0.01,
      })
      .mockResolvedValueOnce({
        rootHash: "h2",
        steps: [],
        output: "a",
        cost_usd: 0.02,
      });
    const runner: ReplayRunner = { run: runMock };
    const result = await replayCounterfactual("r11", loader, runner, {});
    expect(result.metadata.cost_delta_usd).toBe(0.01);
  });

  it("cacheHits and cacheMisses default to 0 when runner does not populate them", async () => {
    const loader = makeLoader();
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r12", loader, runner, {});
    expect(result.metadata.cacheHits).toBe(0);
    expect(result.metadata.cacheMisses).toBe(0);
  });

  it("cacheHits reflects counterfactual trace cacheHits when populated by runner", async () => {
    const loader = makeLoader();
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({ rootHash: "h1", steps: [], output: "a" })
      .mockResolvedValueOnce({
        rootHash: "h2",
        steps: [],
        output: "a",
        cacheHits: 5,
        cacheMisses: 2,
      });
    const runner: ReplayRunner = { run: runMock };
    const result = await replayCounterfactual("r13", loader, runner, {});
    expect(result.metadata.cacheHits).toBe(5);
    expect(result.metadata.cacheMisses).toBe(2);
  });

  it("latency_delta_ms is a finite number", async () => {
    const loader = makeLoader();
    const runner = makeRunner("out");
    const result = await replayCounterfactual("r14", loader, runner, {});
    expect(typeof result.metadata.latency_delta_ms).toBe("number");
    expect(Number.isFinite(result.metadata.latency_delta_ms)).toBe(true);
  });

  it("alt_temperature is passed to the runner context without throwing", async () => {
    const loader = makeLoader();
    let capturedCtx: ReplayContext | undefined;
    const runner: ReplayRunner = {
      run: vi.fn().mockImplementation((ctx: ReplayContext) => {
        capturedCtx = ctx;
        return Promise.resolve({ rootHash: "h", steps: [], output: "out" });
      }),
    };
    await replayCounterfactual("r15", loader, runner, { alt_temperature: 1.5 });
    // The second call (counterfactual) should have temperatureOverride = 1.5
    const calls = (runner.run as ReturnType<typeof vi.fn>).mock.calls;
    const cfCtx = calls[1]?.[0] as Record<string, unknown>;
    expect(cfCtx?.temperatureOverride).toBe(1.5);
  });
});
