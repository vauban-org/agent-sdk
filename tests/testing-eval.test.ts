/**
 * Unit tests for the eval framework — runEval, runEvalSuite, createPhaseCountScorer.
 *
 * Sprint: command-center:sprint-563:B6
 */

import { describe, expect, it, vi } from "vitest";
import type { CycleEvent, OODAAgent } from "../src/orchestration/index.js";
import {
  type EvalScenario,
  type LLMScorer,
  createPhaseCountScorer,
  runEval,
  runEvalSuite,
} from "../src/testing/eval.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCycleCompleteEvent(status: "succeeded" | "failed" | "skipped"): CycleEvent {
  return {
    type: "cycle_complete",
    runId: "test-run",
    cycleIndex: 0,
    status,
    durationMs: 10,
    ts: Date.now(),
  };
}

function makeCycleStartEvent(): CycleEvent {
  return {
    type: "phase_start",
    runId: "test-run",
    cycleIndex: 0,
    phase: "observe",
    ts: Date.now(),
  };
}

function makeAgent(
  opts: {
    status?: "succeeded" | "failed" | "skipped";
    events?: CycleEvent[];
  } = {},
): OODAAgent {
  const events: CycleEvent[] = opts.events ?? [
    {
      type: "phase_start",
      runId: "test-run",
      cycleIndex: 0,
      phase: "observe",
      ts: Date.now(),
    } as CycleEvent,
    makeCycleCompleteEvent(opts.status ?? "succeeded"),
  ];
  return {
    streamCycle: vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    }),
    start: vi.fn(),
    stop: vi.fn(),
    triggerCycle: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ running: false, cyclesCompleted: 0 }),
  } as unknown as OODAAgent;
}

function makeScenario(overrides: Partial<EvalScenario> = {}): EvalScenario {
  return {
    name: "default-scenario",
    agent: makeAgent(),
    ...overrides,
  };
}

// ─── runEval ─────────────────────────────────────────────────────────────────

describe("runEval", () => {
  it("returns EvalResult with name matching scenario.name", async () => {
    const scenario = makeScenario({ name: "my-scenario" });
    const result = await runEval(scenario);
    expect(result.name).toBe("my-scenario");
  });

  it("returns EvalResult with required fields", async () => {
    const scenario = makeScenario();
    const result = await runEval(scenario);
    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("durationMs");
  });

  it("passes when expectedStatus='succeeded' and cycle succeeds", async () => {
    const scenario = makeScenario({
      agent: makeAgent({ status: "succeeded" }),
      expectedStatus: "succeeded",
    });
    const result = await runEval(scenario);
    expect(result.passed).toBe(true);
  });

  it("fails when expectedStatus='failed' but cycle succeeds", async () => {
    const scenario = makeScenario({
      agent: makeAgent({ status: "succeeded" }),
      expectedStatus: "failed",
    });
    const result = await runEval(scenario);
    expect(result.passed).toBe(false);
    expect(result.assertionFailure).toMatch(/Expected status "failed"/);
  });

  it("calls setup() before streamCycle", async () => {
    const callOrder: string[] = [];
    const agent = {
      ...makeAgent(),
      streamCycle: vi.fn().mockImplementation(async function* () {
        callOrder.push("stream");
        yield makeCycleCompleteEvent("succeeded");
      }),
    } as unknown as OODAAgent;

    const scenario = makeScenario({
      agent,
      setup: async () => {
        callOrder.push("setup");
      },
    });

    await runEval(scenario);
    expect(callOrder[0]).toBe("setup");
    expect(callOrder[1]).toBe("stream");
  });

  it("calls assertions() with the events array", async () => {
    const receivedEvents: CycleEvent[][] = [];
    const scenario = makeScenario({
      assertions: async (events) => {
        receivedEvents.push(events);
        return true;
      },
    });

    const result = await runEval(scenario);
    expect(receivedEvents).toHaveLength(1);
    expect(Array.isArray(receivedEvents[0])).toBe(true);
    expect(result.events).toEqual(receivedEvents[0]);
  });

  it("passed=true when assertions returns true", async () => {
    const scenario = makeScenario({
      assertions: async () => true,
    });
    const result = await runEval(scenario);
    expect(result.passed).toBe(true);
  });

  it("passed=false when assertions returns false", async () => {
    const scenario = makeScenario({
      assertions: async () => false,
    });
    const result = await runEval(scenario);
    expect(result.passed).toBe(false);
    expect(result.assertionFailure).toBe("Custom assertions failed");
  });

  it("events array contains all streamed events", async () => {
    const customEvents: CycleEvent[] = [
      makeCycleStartEvent(),
      {
        type: "phase_start",
        runId: "r",
        cycleIndex: 0,
        phase: "orient",
        ts: Date.now(),
      },
      makeCycleCompleteEvent("succeeded"),
    ];
    const scenario = makeScenario({
      agent: makeAgent({ events: customEvents }),
    });
    const result = await runEval(scenario);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].type).toBe("phase_start");
    expect(result.events[2].type).toBe("cycle_complete");
  });

  it("durationMs is a non-negative number", async () => {
    const scenario = makeScenario();
    const result = await runEval(scenario);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls streamCycle with dryRun: true", async () => {
    const agent = makeAgent();
    const scenario = makeScenario({ agent });
    await runEval(scenario);
    expect(agent.streamCycle).toHaveBeenCalledWith({ dryRun: true });
  });

  it("calls llmScorer when provided and scenario has minScore", async () => {
    const scorer: LLMScorer = {
      score: vi.fn().mockResolvedValue(80),
    };
    const scenario = makeScenario({ minScore: 50 });
    const result = await runEval(scenario, { llmScorer: scorer });
    expect(scorer.score).toHaveBeenCalledWith(result.events, scenario);
  });

  it("llmScore is present in result when scorer is provided with minScore", async () => {
    const scorer: LLMScorer = {
      score: vi.fn().mockResolvedValue(75),
    };
    const scenario = makeScenario({ minScore: 50 });
    const result = await runEval(scenario, { llmScorer: scorer });
    expect(result.llmScore).toBe(75);
  });

  it("passed=false when score < minScore", async () => {
    const scorer: LLMScorer = {
      score: vi.fn().mockResolvedValue(70),
    };
    const scenario = makeScenario({ minScore: 90 });
    const result = await runEval(scenario, { llmScorer: scorer });
    expect(result.passed).toBe(false);
    expect(result.assertionFailure).toMatch(/LLM score 70 below minimum 90/);
  });

  it("passed=true when score >= minScore", async () => {
    const scorer: LLMScorer = {
      score: vi.fn().mockResolvedValue(70),
    };
    const scenario = makeScenario({ minScore: 50 });
    const result = await runEval(scenario, { llmScorer: scorer });
    expect(result.passed).toBe(true);
  });

  it("passed=true with no assertions and correct expected status", async () => {
    const scenario = makeScenario({
      agent: makeAgent({ status: "succeeded" }),
      expectedStatus: "succeeded",
    });
    const result = await runEval(scenario);
    expect(result.passed).toBe(true);
    expect(result.assertionFailure).toBeUndefined();
  });

  it("status is 'error' when no cycle_complete event is emitted", async () => {
    const events: CycleEvent[] = [
      {
        type: "phase_start",
        runId: "r",
        cycleIndex: 0,
        phase: "observe",
        ts: Date.now(),
      },
    ];
    const scenario = makeScenario({ agent: makeAgent({ events }) });
    const result = await runEval(scenario);
    expect(result.status).toBe("error");
  });

  it("assertionFailure is set when assertions throw", async () => {
    const scenario = makeScenario({
      assertions: async () => {
        throw new Error("boom");
      },
    });
    const result = await runEval(scenario);
    expect(result.passed).toBe(false);
    expect(result.assertionFailure).toMatch(/boom/);
  });

  it("does not call llmScorer when assertions already failed", async () => {
    const scorer: LLMScorer = {
      score: vi.fn().mockResolvedValue(100),
    };
    const scenario = makeScenario({
      assertions: async () => false,
      minScore: 50,
    });
    await runEval(scenario, { llmScorer: scorer });
    expect(scorer.score).not.toHaveBeenCalled();
  });

  it("handles cycle_skipped event — status reported as 'error' (no cycle_complete)", async () => {
    const events: CycleEvent[] = [
      {
        type: "cycle_skipped",
        runId: "r",
        cycleIndex: 0,
        reason: "guard-tripped",
        ts: Date.now(),
      },
    ];
    const scenario = makeScenario({ agent: makeAgent({ events }) });
    const result = await runEval(scenario);
    // cycle_skipped does not set cycle_complete; status falls back to 'error'
    expect(result.status).toBe("error");
  });
});

// ─── runEvalSuite ─────────────────────────────────────────────────────────────

describe("runEvalSuite", () => {
  it("returns EvalSuite with results, passed, failed, total", async () => {
    const scenarios = [makeScenario({ name: "s1" }), makeScenario({ name: "s2" })];
    const suite = await runEvalSuite(scenarios);
    expect(suite).toHaveProperty("results");
    expect(suite).toHaveProperty("passed");
    expect(suite).toHaveProperty("failed");
    expect(suite).toHaveProperty("total");
  });

  it("all passing scenarios → passed equals total", async () => {
    const scenarios = [
      makeScenario({ name: "a", expectedStatus: "succeeded" }),
      makeScenario({ name: "b", expectedStatus: "succeeded" }),
    ];
    const suite = await runEvalSuite(scenarios);
    expect(suite.passed).toBe(suite.total);
    expect(suite.failed).toBe(0);
  });

  it("one failing scenario → failed=1", async () => {
    const scenarios = [
      makeScenario({ name: "pass", expectedStatus: "succeeded" }),
      makeScenario({
        name: "fail",
        agent: makeAgent({ status: "succeeded" }),
        expectedStatus: "failed",
      }),
    ];
    const suite = await runEvalSuite(scenarios);
    expect(suite.failed).toBe(1);
    expect(suite.passed).toBe(1);
  });

  it("empty scenarios array → total=0, passed=0, failed=0", async () => {
    const suite = await runEvalSuite([]);
    expect(suite.total).toBe(0);
    expect(suite.passed).toBe(0);
    expect(suite.failed).toBe(0);
  });

  it("results array has one entry per scenario", async () => {
    const scenarios = [
      makeScenario({ name: "x" }),
      makeScenario({ name: "y" }),
      makeScenario({ name: "z" }),
    ];
    const suite = await runEvalSuite(scenarios);
    expect(suite.results).toHaveLength(3);
    expect(suite.results.map((r) => r.name)).toEqual(["x", "y", "z"]);
  });

  it("total equals results.length", async () => {
    const scenarios = [makeScenario(), makeScenario(), makeScenario()];
    const suite = await runEvalSuite(scenarios);
    expect(suite.total).toBe(suite.results.length);
  });
});

// ─── createPhaseCountScorer ───────────────────────────────────────────────────

describe("createPhaseCountScorer", () => {
  it("scores 100 when all expected phases are present", async () => {
    const scorer = createPhaseCountScorer(["observe", "orient"]);
    const events: CycleEvent[] = [
      {
        type: "phase_start",
        runId: "r",
        cycleIndex: 0,
        phase: "observe",
        ts: Date.now(),
      },
      {
        type: "phase_start",
        runId: "r",
        cycleIndex: 0,
        phase: "orient",
        ts: Date.now(),
      },
    ];
    const score = await scorer.score(events, makeScenario());
    expect(score).toBe(100);
  });

  it("scores 0 when no expected phases are present", async () => {
    const scorer = createPhaseCountScorer(["observe", "orient"]);
    const events: CycleEvent[] = [makeCycleCompleteEvent("succeeded")];
    const score = await scorer.score(events, makeScenario());
    expect(score).toBe(0);
  });

  it("scores 50 when half the expected phases are present", async () => {
    const scorer = createPhaseCountScorer(["observe", "orient"]);
    const events: CycleEvent[] = [
      {
        type: "phase_start",
        runId: "r",
        cycleIndex: 0,
        phase: "observe",
        ts: Date.now(),
      },
    ];
    const score = await scorer.score(events, makeScenario());
    expect(score).toBe(50);
  });

  it("only counts phase_start events, not phase_complete", async () => {
    const scorer = createPhaseCountScorer(["observe"]);
    const events: CycleEvent[] = [
      {
        type: "phase_complete",
        runId: "r",
        cycleIndex: 0,
        phase: "observe",
        durationMs: 5,
        ts: Date.now(),
      },
    ];
    const score = await scorer.score(events, makeScenario());
    expect(score).toBe(0);
  });
});
