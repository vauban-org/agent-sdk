/**
 * tests/eval-framework.test.ts
 *
 * Sprint-563: B6 — Behavioral eval framework tests.
 */

import { describe, expect, it } from "vitest";
import type { CycleEvent, CycleStatus, OODAAgent } from "../src/orchestration/index.js";
import { createPhaseCountScorer, runEval, runEvalSuite } from "../src/testing/eval.js";
import type { EvalScenario, LLMScorer } from "../src/testing/eval.js";

// Minimal fake agent that produces deterministic events
function fakeAgent(phaseEvents: CycleEvent[]): OODAAgent {
  return {
    streamCycle(_opts: { dryRun: boolean }): AsyncIterable<CycleEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of phaseEvents) {
            yield event;
          }
        },
      };
    },
    start: async () => {},
    stop: async () => {},
    triggerCycle: async () => ({ runId: "fake", status: "succeeded" as CycleStatus }),
    getStatus: () => ({ running: false, cyclesCompleted: 0 }),
  };
}

const successEvents: CycleEvent[] = [
  { type: "phase_start", runId: "r1", cycleIndex: 0, phase: "observe", ts: 100 },
  { type: "phase_complete", runId: "r1", cycleIndex: 0, phase: "observe", durationMs: 50, ts: 150 },
  { type: "phase_start", runId: "r1", cycleIndex: 0, phase: "orient", ts: 151 },
  { type: "phase_complete", runId: "r1", cycleIndex: 0, phase: "orient", durationMs: 100, ts: 251 },
  {
    type: "cycle_complete",
    runId: "r1",
    cycleIndex: 0,
    status: "succeeded",
    durationMs: 250,
    ts: 300,
  },
];

describe("runEval", () => {
  it("passes when assertions return true", async () => {
    const result = await runEval({
      name: "happy-path",
      agent: fakeAgent(successEvents),
      assertions: (events) => events.some((e) => e.type === "cycle_complete"),
    });

    expect(result.passed).toBe(true);
    expect(result.status).toBe("succeeded");
  });

  it("fails when assertion returns false", async () => {
    const result = await runEval({
      name: "failing",
      agent: fakeAgent(successEvents),
      assertions: () => false,
    });

    expect(result.passed).toBe(false);
    expect(result.assertionFailure).toContain("Custom assertions failed");
  });

  it("fails when expectedStatus mismatches", async () => {
    const result = await runEval({
      name: "wrong-status",
      agent: fakeAgent(successEvents),
      expectedStatus: "failed",
    });

    expect(result.passed).toBe(false);
    expect(result.assertionFailure).toContain("Expected status");
  });

  it("records duration", async () => {
    const result = await runEval({
      name: "timed",
      agent: fakeAgent(successEvents),
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures all events", async () => {
    const result = await runEval({
      name: "events-check",
      agent: fakeAgent(successEvents),
    });

    expect(result.events).toHaveLength(successEvents.length);
  });
});

describe("runEvalSuite", () => {
  it("aggregates results across scenarios", async () => {
    const suite = await runEvalSuite([
      { name: "pass1", agent: fakeAgent(successEvents) },
      {
        name: "fail1",
        agent: fakeAgent(successEvents),
        assertions: () => false,
      },
    ]);

    expect(suite.total).toBe(2);
    expect(suite.passed).toBe(1);
    expect(suite.failed).toBe(1);
  });

  it("counts passed and failed correctly", async () => {
    const suite = await runEvalSuite([
      { name: "a", agent: fakeAgent(successEvents) },
      {
        name: "b",
        agent: fakeAgent(successEvents),
        expectedStatus: "skipped",
      },
    ]);

    expect(suite.passed).toBe(1);
    expect(suite.failed).toBe(1);
    expect(suite.total).toBe(2);
  });
});

describe("createPhaseCountScorer", () => {
  it("scores 100 when all expected phases present", async () => {
    const scorer = createPhaseCountScorer(["observe", "orient"]);
    const score = await scorer.score(successEvents, { name: "test", agent: fakeAgent([]) });
    expect(score).toBe(100);
  });

  it("scores less than 100 when phases missing", async () => {
    const scorer = createPhaseCountScorer(["observe", "orient", "decide"]);
    const score = await scorer.score(successEvents, { name: "test", agent: fakeAgent([]) });
    expect(score).toBeLessThan(100);
  });
});
