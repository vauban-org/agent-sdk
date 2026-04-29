/**
 * OODA agent — core behavior tests.
 *
 * Sprint: command-center:sprint-525:quick-1
 */

import { describe, it, expect, vi } from "vitest";
import {
  createOODAAgent,
  noopLogger,
  type OODAAgentConfig,
  type PhaseDef,
} from "../src/index.js";
import type { DbClient } from "../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    agentId: "test-agent",
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OODA agent — construction", () => {
  it("throws when executionMode missing", () => {
    expect(() =>
      // @ts-expect-error — intentional missing required field
      createOODAAgent({ ...baseConfig(), executionMode: undefined }),
    ).toThrow(/executionMode is REQUIRED/);
  });

  it("throws when observe is not readOnly", () => {
    const cfg = baseConfig();
    expect(() =>
      createOODAAgent({
        ...cfg,
        phases: {
          ...cfg.phases,
          observe: { type: "observation", fn: async () => 1 } as PhaseDef<
            void,
            number
          >,
        },
      } as OODAAgentConfig<unknown, number, number, number, number, number>),
    ).toThrow(/observe MUST be readOnly/);
  });

  it("throws when orient is not readOnly", () => {
    const cfg = baseConfig();
    expect(() =>
      createOODAAgent({
        ...cfg,
        phases: {
          ...cfg.phases,
          orient: {
            type: "retrieval",
            fn: async (i: number) => i + 1,
          } as PhaseDef<number, number>,
        },
      } as OODAAgentConfig<unknown, number, number, number, number, number>),
    ).toThrow(/orient MUST be readOnly/);
  });

  it("accepts a valid config", () => {
    const agent = createOODAAgent(baseConfig());
    expect(agent.getStatus().running).toBe(false);
    expect(agent.getStatus().cyclesCompleted).toBe(0);
  });
});

describe("OODA agent — cycle execution", () => {
  it("runs all 5 phases in order on triggerCycle", async () => {
    const order: string[] = [];
    const cfg = baseConfig();
    cfg.phases = {
      observe: {
        type: "observation",
        readOnly: true,
        fn: async () => {
          order.push("observe");
          return 1;
        },
      },
      orient: {
        type: "retrieval",
        readOnly: true,
        fn: async (i: number) => {
          order.push("orient");
          return i + 1;
        },
      },
      decide: {
        type: "decision",
        fn: async (i: number) => {
          order.push("decide");
          return i + 1;
        },
      },
      act: {
        type: "execution",
        fn: async (i: number) => {
          order.push("act");
          return i + 1;
        },
      },
      feedback: {
        type: "feedback",
        fn: async (i: number) => {
          order.push("feedback");
          return i + 1;
        },
      },
    };
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("succeeded");
    expect(order).toEqual([
      "observe",
      "orient",
      "decide",
      "act",
      "feedback",
    ]);
  });

  it("phase exception → status failed, errorStep called", async () => {
    const errorStep = vi.fn(async () => {});
    const cfg = baseConfig();
    cfg.phases = {
      ...cfg.phases,
      decide: {
        type: "decision",
        fn: async () => {
          throw new Error("boom");
        },
      },
    };
    cfg.errorStepImpl = errorStep;
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("failed");
    expect(errorStep).toHaveBeenCalledTimes(1);
    expect(errorStep.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("sessionGuard returns false → cycle skipped", async () => {
    const observeFn = vi.fn(async () => 1);
    const cfg = baseConfig();
    cfg.phases.observe = {
      type: "observation",
      readOnly: true,
      fn: observeFn,
    };
    cfg.sessionGuards = [
      {
        name: "off-hours",
        isActive: async () => false,
      },
    ];
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("skipped");
    expect(observeFn).not.toHaveBeenCalled();
  });

  it("riskGuard tripped → cycle skipped", async () => {
    const observeFn = vi.fn(async () => 1);
    const cfg = baseConfig();
    cfg.phases.observe = {
      type: "observation",
      readOnly: true,
      fn: observeFn,
    };
    cfg.riskGuards = [
      {
        name: "circuit-breaker",
        check: async () => ({ proceed: false, reason: "open" }),
      },
    ];
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("skipped");
    expect(observeFn).not.toHaveBeenCalled();
  });

  it("phaseTimeoutMs enforced → cycle fails", async () => {
    const cfg = baseConfig();
    cfg.resourceLimits = { phaseTimeoutMs: 50 };
    cfg.phases = {
      ...cfg.phases,
      decide: {
        type: "decision",
        fn: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 1;
        },
      },
    };
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("failed");
  });

  it("triggerCycle({dryRun:true}) overrides executionMode", async () => {
    let observedMode = "";
    const cfg = baseConfig({
      executionMode: "live",
    });
    cfg.phases.observe = {
      type: "observation",
      readOnly: true,
      fn: async (_, ctx) => {
        observedMode = ctx.executionMode;
        return 1;
      },
    };
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle({ dryRun: true });
    expect(observedMode).toBe("dry-run");
  });

  it("getStatus reflects cyclesCompleted", async () => {
    const agent = createOODAAgent(baseConfig());
    expect(agent.getStatus().cyclesCompleted).toBe(0);
    await agent.triggerCycle();
    expect(agent.getStatus().cyclesCompleted).toBe(1);
    await agent.triggerCycle();
    expect(agent.getStatus().cyclesCompleted).toBe(2);
  });
});
