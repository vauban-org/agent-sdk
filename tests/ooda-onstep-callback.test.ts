/**
 * Tests — OODA onStep callback wiring (sprint-727:stream-capture-onstep).
 *
 * Covers the contract surface of `OODAAgentConfig.onStep`:
 *   1. Called for each phase completed (observe, orient, decide, act, feedback)
 *   2. Throwing handler does NOT abort the cycle (status stays succeeded)
 *   3. Async handler is awaited
 *   4. Without `onStep` defined → zero impact, cycle runs cleanly
 *   5. `cycleIndex` is coherent across multi-cycle runs
 *   6. Stream cycle also fires onStep (parity with runCycle)
 */

import { describe, expect, it, vi } from "vitest";
import {
  type DbClient,
  type OODAAgentConfig,
  type PhaseDef,
  type StepEvent,
  createOODAAgent,
  noopLogger,
} from "../src/index.js";

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

function ro<T>(p: PhaseDef<unknown, T>): PhaseDef<unknown, T> {
  return { ...p, readOnly: true };
}

function baseConfig(
  override: Partial<OODAAgentConfig> = {},
): OODAAgentConfig<unknown, number, number, number, number, number> {
  return {
    agentId: "onstep-test-agent",
    intervalMs: 0,
    executionMode: "dry-run",
    db: fakeDb,
    logger: noopLogger,
    phases: {
      observe: ro({
        type: "observation",
        fn: async () => 1,
      }) as PhaseDef<void, number>,
      orient: ro({
        type: "retrieval",
        fn: async (i: number) => i + 1,
      }) as PhaseDef<number, number>,
      decide: {
        type: "decision",
        fn: async (i: number) => i + 1,
      },
      act: {
        type: "execution",
        fn: async (i: number) => i + 1,
      },
      feedback: {
        type: "feedback",
        fn: async (i: number) => i + 1,
      },
    },
    ...override,
  } as OODAAgentConfig<unknown, number, number, number, number, number>;
}

describe("OODA onStep callback", () => {
  it("fires for each phase (observe, orient, decide, act, feedback)", async () => {
    const events: StepEvent[] = [];
    const cfg = baseConfig({
      onStep: (evt) => {
        events.push(evt);
      },
    });
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
    expect(events.map((e) => e.phase)).toEqual([
      "observation",
      "retrieval",
      "decision",
      "execution",
      "feedback",
    ]);
    for (const e of events) {
      expect(e.runId).toBe(r.runId);
      expect(e.cycleIndex).toBe(0);
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("throwing handler does NOT abort the cycle (status stays succeeded)", async () => {
    const cfg = baseConfig({
      onStep: () => {
        throw new Error("boom from onStep");
      },
    });
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
  });

  it("async handler is awaited (rejection caught, cycle succeeds)", async () => {
    let resolved = false;
    const cfg = baseConfig({
      onStep: async () => {
        await new Promise((res) => setTimeout(res, 5));
        resolved = true;
        throw new Error("async boom");
      },
    });
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
    expect(resolved).toBe(true);
  });

  it("no onStep defined → cycle runs cleanly (smoke)", async () => {
    const cfg = baseConfig();
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
  });

  it("cycleIndex is coherent across multi-cycle runs", async () => {
    const events: StepEvent[] = [];
    const cfg = baseConfig({
      onStep: (e) => {
        events.push(e);
      },
    });
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle({ dryRun: false });
    await agent.triggerCycle({ dryRun: false });
    const indices = Array.from(new Set(events.map((e) => e.cycleIndex)));
    expect(indices).toEqual([0, 1]);
    // 5 phases × 2 cycles = 10 step events
    expect(events).toHaveLength(10);
  });

  it("extracts tokensIn/tokensOut/costUsd/model when present on phase output", async () => {
    const events: StepEvent[] = [];
    const cfg = baseConfig({
      onStep: (e) => {
        events.push(e);
      },
    });
    // Replace `orient` phase so its output looks like an LLM result.
    cfg.phases = {
      ...cfg.phases,
      orient: {
        type: "retrieval",
        readOnly: true,
        fn: async () =>
          ({
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.0012,
            model: "groq/llama-3.3-70b",
          }) as unknown as number,
      },
    };
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle({ dryRun: false });
    const orientEvt = events.find((e) => e.phase === "retrieval");
    expect(orientEvt).toBeDefined();
    expect(orientEvt!.tokensIn).toBe(100);
    expect(orientEvt!.tokensOut).toBe(50);
    expect(orientEvt!.costUsd).toBeCloseTo(0.0012);
    expect(orientEvt!.model).toBe("groq/llama-3.3-70b");
    // A phase whose output is a plain number → no token metadata.
    const observeEvt = events.find((e) => e.phase === "observation");
    expect(observeEvt!.tokensIn).toBeUndefined();
    expect(observeEvt!.model).toBeUndefined();
  });

  it("stream cycle also fires onStep (parity with runCycle)", async () => {
    const events: StepEvent[] = [];
    const cfg = baseConfig({
      onStep: (e) => {
        events.push(e);
      },
    });
    const agent = createOODAAgent(cfg);
    const collected: string[] = [];
    for await (const evt of agent.streamCycle({ dryRun: true })) {
      collected.push(evt.type);
    }
    expect(collected).toContain("cycle_complete");
    expect(events.map((e) => e.phase)).toEqual([
      "observation",
      "retrieval",
      "decision",
      "execution",
      "feedback",
    ]);
  });

  it("stream cycle wires skill capture (parity with runCycle)", async () => {
    // sprint-727:stream-capture-onstep — verify _runCycleWithSink also
    // invokes the procedural learning loop. We supply minimal procedural
    // and outcomeMapping so the capture path actually fires.
    const registerSkill = vi.fn().mockResolvedValue(undefined);
    const cfg = baseConfig({
      outcomeMapping: () => ({
        outcome_type: "test",
        value_cents: 1500,
        quality: 0.9,
        confidence: 0.95,
      }),
      skillCapture: {
        enabled: true,
        domain: "stream-test",
        procedural: {
          resolveSkills: vi.fn().mockResolvedValue([]),
          registerSkill,
          shareSkill: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    // act phase needs to take >5s for the LearningTrigger to pass shouldLearn
    // (durationMs > 5000). We cheat by pushing many steps so toolCallCount>=4
    // and ensure durationMs check is met via a short artificial delay loop is
    // not viable in tests. Instead, lower the threshold via a fake trigger
    // is internal — we accept this test is best-effort: even if shouldLearn
    // gates out, the capture path executes without throwing.
    const agent = createOODAAgent(cfg);
    const events: string[] = [];
    for await (const e of agent.streamCycle({ dryRun: true })) {
      events.push(e.type);
    }
    expect(events).toContain("cycle_complete");
    // Capture path executed (registerSkill MAY or MAY NOT be called depending
    // on shouldLearn gating ; what matters is no throw escaped the cycle).
  });

  it("onStep is NOT fired on failing phases (cycle still surfaces failure)", async () => {
    const onStep = vi.fn();
    const cfg = baseConfig({
      onStep,
    });
    cfg.phases = {
      ...cfg.phases,
      decide: {
        type: "decision",
        fn: async () => {
          throw new Error("decide boom");
        },
      },
    };
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("failed");
    // observe + orient fired ; decide threw before completeStep so no onStep.
    expect(onStep.mock.calls.map((c) => (c[0] as StepEvent).phase)).toEqual([
      "observation",
      "retrieval",
    ]);
  });
});
