/**
 * `ctx.emitStep` — SDK 1.6.1 fire-and-forget plan checkpoint helper.
 *
 * Factorises the `insertStep → completeStep | errorStep` boilerplate that
 * forge phases (publish_x, attest_run, hitl_pause, archive_brain, …) repeat
 * in every act phase. Caller-side is synchronous and never throws.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type DbClient,
  type OODAAgentConfig,
  type OODAContext,
  type PhaseDef,
  createOODAAgent,
  noopLogger,
} from "../src/index.js";

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

function ro<T>(p: PhaseDef<unknown, T>): PhaseDef<unknown, T> {
  return { ...p, readOnly: true };
}

/**
 * Build a minimal OODAAgent whose `act` phase calls `ctx.emitStep` with the
 * caller-controlled input. Captures the ctx + the spies so individual tests
 * can assert on what was invoked.
 */
function buildAgentWithEmitStep(opts: {
  emitInput: Parameters<OODAContext["emitStep"]>[0];
  insertStepFails?: boolean;
}) {
  // Each insertStep call gets a unique stepId so the framework's per-phase
  // insertSteps don't collide with the emitStep call we're testing.
  let stepCounter = 0;
  const insertStep = vi.fn(async (input: { type: string; phase: string }) => {
    stepCounter += 1;
    // The emitStep call uses opts.emitInput.phase ; framework phases use
    // "observe"/"orient"/etc. We label the emitStep one so tests can filter.
    const isEmit = input.phase === opts.emitInput.phase;
    return { stepId: isEmit ? "emit-step" : `framework-${stepCounter}` };
  });
  // Failing variant : ONLY throws when called for our emitStep phase. The
  // framework's own per-phase insertSteps succeed (otherwise the cycle would
  // crash and the swallow assertion would never reach).
  const insertStepFailing = vi.fn(async (input: { type: string; phase: string }) => {
    if (input.phase === opts.emitInput.phase) {
      throw new Error("insertStep broke");
    }
    stepCounter += 1;
    return { stepId: `framework-${stepCounter}` };
  });
  const completeStep = vi.fn(async () => ({ leafHash: "0xleaf" }));
  const errorStep = vi.fn(async () => {});
  const warn = vi.fn();
  const logger = { ...noopLogger, warn };

  const cfg: OODAAgentConfig<unknown, number, number, number, number, number> = {
    agentId: "test-emit-step",
    intervalMs: 0,
    executionMode: "dry-run",
    db: fakeDb,
    logger,
    insertStepImpl: (opts.insertStepFails
      ? insertStepFailing
      : insertStep) as OODAContext["insertStep"],
    completeStepImpl: completeStep as OODAContext["completeStep"],
    errorStepImpl: errorStep as OODAContext["errorStep"],
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
        fn: async (i: number, ctx: OODAContext): Promise<number> => {
          ctx.emitStep(opts.emitInput);
          // Yield so the IIFE has a chance to run.
          await new Promise((r) => setImmediate(r));
          return i + 1;
        },
      },
      feedback: {
        type: "feedback",
        fn: async (i: number) => i + 1,
      },
    },
  } as OODAAgentConfig<unknown, number, number, number, number, number>;

  return {
    agent: createOODAAgent(cfg),
    insertStep,
    insertStepFailing,
    completeStep,
    errorStep,
    warn,
  };
}

describe("ctx.emitStep — SDK 1.6.1", () => {
  it("happy path: default status='completed' → insertStep + completeStep with merged payload", async () => {
    const { agent, insertStep, completeStep, errorStep, warn } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "publish_x",
        payload: { postsPublished: 3, durationMs: 42 },
      },
    });

    await agent.triggerCycle({ dryRun: true });
    // Give the fire-and-forget IIFE time to flush.
    await new Promise((r) => setImmediate(r));

    expect(insertStep).toHaveBeenCalledWith({
      type: "execution",
      phase: "publish_x",
      payload: { postsPublished: 3, durationMs: 42 },
    });
    expect(completeStep).toHaveBeenCalledWith("emit-step", {
      postsPublished: 3,
      durationMs: 42,
      status: "completed",
    });
    expect(errorStep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "[emitStep] failed");
  });

  it("explicit status='completed' merges payload with status", async () => {
    const { agent, completeStep } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "archive_brain",
        payload: { entriesArchived: 1 },
        status: "completed",
      },
    });
    await agent.triggerCycle({ dryRun: true });
    await new Promise((r) => setImmediate(r));
    expect(completeStep).toHaveBeenCalledWith("emit-step", {
      entriesArchived: 1,
      status: "completed",
    });
  });

  it("status='failed' with Error → errorStep called with the Error instance", async () => {
    const err = new Error("publish rate-limited");
    const { agent, insertStep, completeStep, errorStep } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "publish_x",
        payload: { attempted: 1 },
        status: "failed",
        error: err,
      },
    });
    await agent.triggerCycle({ dryRun: true });
    await new Promise((r) => setImmediate(r));

    expect(insertStep).toHaveBeenCalled();
    expect(errorStep).toHaveBeenCalledWith("emit-step", err);
    expect(completeStep).not.toHaveBeenCalledWith("emit-step", expect.anything());
  });

  it("status='failed' with string error → wraps in new Error", async () => {
    const { agent, errorStep } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "publish_x",
        status: "failed",
        error: "429 rate limit",
      },
    });
    await agent.triggerCycle({ dryRun: true });
    await new Promise((r) => setImmediate(r));

    expect(errorStep).toHaveBeenCalledTimes(1);
    const callArgs = errorStep.mock.calls[0] as [string, Error];
    expect(callArgs[1]).toBeInstanceOf(Error);
    expect(callArgs[1].message).toBe("429 rate limit");
  });

  it("status='failed' with no error → wraps a synthesised Error", async () => {
    const { agent, errorStep } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "publish_x",
        status: "failed",
      },
    });
    await agent.triggerCycle({ dryRun: true });
    await new Promise((r) => setImmediate(r));

    expect(errorStep).toHaveBeenCalledTimes(1);
    const callArgs = errorStep.mock.calls[0] as [string, Error];
    expect(callArgs[1]).toBeInstanceOf(Error);
    expect(callArgs[1].message).toContain("publish_x");
  });

  it("status='skipped' merges payload with status='skipped' on completeStep", async () => {
    const { agent, completeStep, errorStep } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "hitl_pause",
        payload: { reason: "human-approved" },
        status: "skipped",
      },
    });
    await agent.triggerCycle({ dryRun: true });
    await new Promise((r) => setImmediate(r));
    expect(completeStep).toHaveBeenCalledWith("emit-step", {
      reason: "human-approved",
      status: "skipped",
    });
    expect(errorStep).not.toHaveBeenCalled();
  });

  it("throw swallowed: insertStep rejects → caller doesn't throw, logger.warn called", async () => {
    const { agent, warn, completeStep, errorStep } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "publish_x",
      },
      insertStepFails: true,
    });

    // The cycle must complete normally despite the inner throw.
    await expect(agent.triggerCycle({ dryRun: true })).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));

    // emitStep's own follow-up did not fire (insertStep rejected for our phase).
    expect(completeStep).not.toHaveBeenCalledWith("emit-step", expect.anything());
    expect(errorStep).not.toHaveBeenCalledWith("emit-step", expect.anything());
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "publish_x" }),
      "[emitStep] failed",
    );
  });

  it("emitStep is synchronous (returns void, never a Promise)", async () => {
    let returnValue: unknown = "untouched";
    const { agent } = buildAgentWithEmitStep({
      emitInput: {
        type: "execution",
        phase: "noop",
      },
    });
    // Override act to capture the return value of emitStep itself.
    const probe = vi.fn();
    (
      agent as unknown as {
        _config: { phases: { act: PhaseDef<number, number> } };
      }
    )._config.phases.act = {
      type: "execution",
      fn: async (i: number, ctx: OODAContext): Promise<number> => {
        returnValue = ctx.emitStep({ type: "execution", phase: "noop" });
        probe();
        return i + 1;
      },
    };

    await agent.triggerCycle({ dryRun: true });
    expect(probe).toHaveBeenCalled();
    expect(returnValue).toBeUndefined();
  });
});
