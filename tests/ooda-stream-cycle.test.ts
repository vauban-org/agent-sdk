/**
 * OODA streamCycle() + CycleEventV010 typed union — A1 sprint-561.
 *
 * Three test groups:
 * 1. Compile-time exhaustiveness check on CycleEventV010 (all 10 variants handled).
 * 2. triggerCycle() without explicit dryRun flag throws MissingDryRunFlagError.
 * 3. streamCycle({dryRun:true}) emits phase_start + phase_complete for every
 *    OODA phase AND a final cycle_complete.
 */

import { describe, expect, it } from "vitest";
import {
  type CycleEvent,
  type CycleEventV010,
  type DbClient,
  MissingDryRunFlagError,
  type OODAAgentConfig,
  createOODAAgent,
  noopLogger,
} from "../src/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

function baseConfig(): OODAAgentConfig<unknown, number, number, number, number, number> {
  return {
    agentId: "stream-test-agent",
    intervalMs: 0,
    executionMode: "dry-run",
    db: fakeDb,
    logger: noopLogger,
    phases: {
      observe: { type: "observation", readOnly: true, fn: async () => 1 },
      orient: { type: "retrieval", readOnly: true, fn: async (i: number) => i + 1 },
      decide: { type: "decision", fn: async (i: number) => i + 1 },
      act: { type: "execution", fn: async (i: number) => i + 1 },
      feedback: { type: "feedback", fn: async (i: number) => i + 1 },
    },
  } as OODAAgentConfig<unknown, number, number, number, number, number>;
}

// ─── Group 1: Exhaustive switch on CycleEventV010 ────────────────────────────

/**
 * Compile-time exhaustiveness check — if a variant is added to CycleEventV010
 * without a corresponding case, TypeScript will error on the `_never` assignment.
 *
 * This function is never called at runtime; it only needs to compile.
 */
function assertExhaustiveCycleEventV010(evt: CycleEventV010): string {
  switch (evt.type) {
    case "phase_start":
      return `phase_start:${evt.phase}`;
    case "phase_complete":
      return `phase_complete:${evt.phase}:${evt.durationMs}ms`;
    case "phase_error":
      return `phase_error:${evt.phase}:${evt.error.message}`;
    case "guard_tripped":
      return `guard_tripped:${evt.guard}:${evt.reason}`;
    case "hitl_waiting":
      return `hitl_waiting:${evt.stepId}`;
    case "hitl_approved":
      return `hitl_approved:${evt.stepId}`;
    case "cycle_complete":
      return `cycle_complete:${evt.status}:${evt.durationMs}ms`;
    case "cycle_skipped":
      return `cycle_skipped:${evt.reason}`;
    case "cycle_error":
      return `cycle_error:${evt.error.message}`;
    case "timestamp_pending":
      return `timestamp_pending:${evt.rootHash}`;
    default: {
      // TypeScript will error here if a variant is missing above.
      const _never: never = evt;
      return `unknown:${String(_never)}`;
    }
  }
}

describe("CycleEventV010 — exhaustive switch (compile-time)", () => {
  it("all 10 variants are handled — function compiles without TS error", () => {
    // We exercise the function with one sample event to confirm runtime correctness.
    const sample: CycleEventV010 = {
      type: "cycle_complete",
      runId: "r1",
      cycleIndex: 0,
      status: "succeeded",
      durationMs: 42,
      ts: Date.now(),
    };
    expect(assertExhaustiveCycleEventV010(sample)).toMatch(/cycle_complete:succeeded/);
  });

  it("covers phase_start variant", () => {
    const evt: CycleEventV010 = {
      type: "phase_start",
      runId: "r",
      cycleIndex: 0,
      phase: "observation",
      ts: Date.now(),
    };
    expect(assertExhaustiveCycleEventV010(evt)).toMatch(/phase_start:observation/);
  });

  it("covers guard_tripped variant", () => {
    const evt: CycleEventV010 = {
      type: "guard_tripped",
      runId: "r",
      cycleIndex: 0,
      guard: "session",
      reason: "off-hours",
      ts: Date.now(),
    };
    expect(assertExhaustiveCycleEventV010(evt)).toMatch(/guard_tripped:session/);
  });
});

// ─── Group 2: MissingDryRunFlagError ─────────────────────────────────────────

describe("triggerCycle() — MissingDryRunFlagError", () => {
  it("throws MissingDryRunFlagError when dryRun is not provided", async () => {
    const agent = createOODAAgent(baseConfig());
    // @ts-expect-error — intentional: testing runtime guard against missing dryRun
    await expect(agent.triggerCycle()).rejects.toThrow(MissingDryRunFlagError);
  });

  it("throws MissingDryRunFlagError when dryRun is undefined in opts", async () => {
    const agent = createOODAAgent(baseConfig());
    // @ts-expect-error — intentional: testing runtime guard against undefined dryRun
    await expect(agent.triggerCycle({ dryRun: undefined })).rejects.toThrow(MissingDryRunFlagError);
  });

  it("does NOT throw when dryRun is true", async () => {
    const agent = createOODAAgent(baseConfig());
    const r = await agent.triggerCycle({ dryRun: true });
    expect(r.status).toBe("succeeded");
  });

  it("does NOT throw when dryRun is false", async () => {
    const agent = createOODAAgent(baseConfig());
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
  });

  it("MissingDryRunFlagError name and message are correct", () => {
    const err = new MissingDryRunFlagError();
    expect(err.name).toBe("MissingDryRunFlagError");
    expect(err.message).toContain("dryRun");
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── Group 3: streamCycle() event sequence ───────────────────────────────────

describe("streamCycle({dryRun:true}) — event sequence", () => {
  it("emits phase_start + phase_complete for each OODA phase", async () => {
    const agent = createOODAAgent(baseConfig());
    const events: CycleEvent[] = [];

    for await (const evt of agent.streamCycle({ dryRun: true })) {
      events.push(evt);
    }

    const types = events.map((e) => e.type);

    // Must contain at least one phase_start and one phase_complete per phase.
    const phases = ["observation", "retrieval", "decision", "execution", "feedback"];
    for (const phase of phases) {
      expect(types).toContain("phase_start");
      expect(types).toContain("phase_complete");
      const starts = events.filter(
        (e) => e.type === "phase_start" && "phase" in e && e.phase === phase,
      );
      const completes = events.filter(
        (e) => e.type === "phase_complete" && "phase" in e && e.phase === phase,
      );
      expect(starts.length).toBeGreaterThanOrEqual(1);
      expect(completes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("emits cycle_complete as the final event", async () => {
    const agent = createOODAAgent(baseConfig());
    const events: CycleEvent[] = [];

    for await (const evt of agent.streamCycle({ dryRun: true })) {
      events.push(evt);
    }

    const last = events[events.length - 1];
    expect(last).toBeDefined();
    expect(last?.type).toBe("cycle_complete");
  });

  it("cycle_complete has status succeeded on successful run", async () => {
    const agent = createOODAAgent(baseConfig());
    const events: CycleEvent[] = [];

    for await (const evt of agent.streamCycle({ dryRun: true })) {
      events.push(evt);
    }

    const complete = events.find((e) => e.type === "cycle_complete");
    expect(complete).toBeDefined();
    expect(complete).toMatchObject({ type: "cycle_complete", status: "succeeded" });
  });

  it("phase_start precedes phase_complete for each phase", async () => {
    const agent = createOODAAgent(baseConfig());
    const events: CycleEvent[] = [];

    for await (const evt of agent.streamCycle({ dryRun: true })) {
      events.push(evt);
    }

    const phases = ["observation", "retrieval", "decision", "execution", "feedback"];
    for (const phase of phases) {
      const startIdx = events.findIndex(
        (e) => e.type === "phase_start" && "phase" in e && e.phase === phase,
      );
      const completeIdx = events.findIndex(
        (e) => e.type === "phase_complete" && "phase" in e && e.phase === phase,
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(completeIdx).toBeGreaterThan(startIdx);
    }
  });

  it("cycle_complete is emitted even when a phase throws (status=failed)", async () => {
    const cfg = baseConfig();
    cfg.phases = {
      ...cfg.phases,
      decide: {
        type: "decision",
        fn: async () => {
          throw new Error("decide-boom");
        },
      },
    };
    const agent = createOODAAgent(cfg);
    const events: CycleEvent[] = [];

    for await (const evt of agent.streamCycle({ dryRun: true })) {
      events.push(evt);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("phase_error");
    expect(types).toContain("cycle_error");
    expect(types).toContain("cycle_complete");

    const complete = events.find((e) => e.type === "cycle_complete");
    expect(complete).toMatchObject({ type: "cycle_complete", status: "failed" });
  });

  it("dryRun:true overrides executionMode to dry-run in streamCycle", async () => {
    let capturedMode = "";
    const cfg = {
      ...baseConfig(),
      executionMode: "live" as const,
    };
    cfg.phases = {
      ...cfg.phases,
      observe: {
        type: "observation" as const,
        readOnly: true,
        // biome-ignore lint/suspicious/noConfusingVoidType: phase fn takes no input; void is the empty-arg type.
        fn: async (_: void, ctx: { executionMode: string }) => {
          capturedMode = ctx.executionMode;
          return 1;
        },
      },
    };
    const agent = createOODAAgent(
      cfg as OODAAgentConfig<unknown, number, number, number, number, number>,
    );

    // Drain all events
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _evt of agent.streamCycle({ dryRun: true })) {
      // drain
    }

    expect(capturedMode).toBe("dry-run");
  });

  it("emits exactly 5 phase_start and 5 phase_complete events on a clean run", async () => {
    const agent = createOODAAgent(baseConfig());
    const events: CycleEvent[] = [];

    for await (const evt of agent.streamCycle({ dryRun: true })) {
      events.push(evt);
    }

    const starts = events.filter((e) => e.type === "phase_start");
    const completes = events.filter((e) => e.type === "phase_complete");
    expect(starts).toHaveLength(5);
    expect(completes).toHaveLength(5);
  });
});
