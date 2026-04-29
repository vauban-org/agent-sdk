/**
 * OODA agent — 10 anti-patterns enforced by-design.
 *
 * Sprint: command-center:sprint-525:quick-1
 *
 * Each test maps 1:1 to one of the documented anti-patterns:
 *  1. Sequential while+sleep (NOT setInterval)
 *  2. Each phase persists pending → done
 *  3. HITL gate awaited on act phase when configured
 *  4. RiskGuard has no TTL bypass — re-checked every cycle
 *  5. Session guard checked at cycle start
 *  6. EXECUTION_MODE guard required at construction
 *  7. readOnly observe/orient enforced
 *  8. skip on tripped — no phase calls when a guard aborts
 *  9. configurable thresholds — defaults applied + overridable
 * 10. resource limits — heap monitored, maxStepsPerCycle enforced
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createOODAAgent,
  noopLogger,
  DEFAULT_RESOURCE_LIMITS,
  type DbClient,
  type OODAAgentConfig,
  type PhaseDef,
} from "../src/index.js";

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

function ro<I, O>(p: PhaseDef<I, O>): PhaseDef<I, O> {
  return { ...p, readOnly: true };
}

function baseCfg(): OODAAgentConfig<
  unknown,
  number,
  number,
  number,
  number,
  number
> {
  return {
    agentId: "ap-test",
    intervalMs: 0,
    executionMode: "dry-run",
    db: fakeDb,
    logger: noopLogger,
    phases: {
      observe: ro({ type: "observation", fn: async () => 1 }) as PhaseDef<
        void,
        number
      >,
      orient: ro({
        type: "retrieval",
        fn: async (i: number) => i + 1,
      }) as PhaseDef<number, number>,
      decide: { type: "decision", fn: async (i: number) => i + 1 },
      act: { type: "execution", fn: async (i: number) => i + 1 },
      feedback: { type: "feedback", fn: async (i: number) => i + 1 },
    },
  } as OODAAgentConfig<unknown, number, number, number, number, number>;
}

describe("OODA anti-pattern #1 — sequential while+sleep, never setInterval", () => {
  it("agent.ts source contains no setInterval call", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/orchestration/ooda/agent.ts"),
      "utf-8",
    );
    // Reject any unfenced setInterval — the loop is `while (this._running)`.
    expect(src.match(/setInterval\s*\(/g)).toBeNull();
  });
});

describe("OODA anti-pattern #2 — pending → done persistence", () => {
  it("each phase calls insertStep then completeStep (or errorStep)", async () => {
    const insertCalls: string[] = [];
    const completeCalls: string[] = [];
    const cfg = baseCfg();
    cfg.insertStepImpl = async (input) => {
      insertCalls.push(input.phase);
      return { stepId: `s-${insertCalls.length}` };
    };
    cfg.completeStepImpl = async (stepId) => {
      completeCalls.push(stepId);
      return { leafHash: `0x${stepId}` };
    };
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle();
    expect(insertCalls.length).toBe(5);
    expect(completeCalls.length).toBe(5);
  });
});

describe("OODA anti-pattern #3 — HITL gate awaited on act when configured", () => {
  it("waitForHITL is awaited before act completes", async () => {
    const events: string[] = [];
    const cfg = baseCfg();
    cfg.phases.act = {
      type: "execution",
      hitlGate: true,
      fn: async (i: number) => {
        events.push("act-fn");
        return i + 1;
      },
    };
    cfg.waitForHITL = async () => {
      events.push("hitl-await");
    };
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle();
    expect(events).toEqual(["act-fn", "hitl-await"]);
  });

  it("HITL rejection aborts cycle as failed", async () => {
    const cfg = baseCfg();
    cfg.phases.act = {
      type: "execution",
      hitlGate: true,
      fn: async (i: number) => i + 1,
    };
    cfg.waitForHITL = async () => {
      throw new Error("rejected");
    };
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("failed");
  });
});

describe("OODA anti-pattern #4 — risk guard no TTL bypass", () => {
  it("riskGuard.check is called every cycle, not cached", async () => {
    const checkFn = vi.fn(async () => ({ proceed: true }));
    const cfg = baseCfg();
    cfg.riskGuards = [{ name: "g", check: checkFn }];
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle();
    await agent.triggerCycle();
    await agent.triggerCycle();
    expect(checkFn).toHaveBeenCalledTimes(3);
  });
});

describe("OODA anti-pattern #5 — session guard at cycle start", () => {
  it("session guard isActive checked before any phase", async () => {
    const events: string[] = [];
    const cfg = baseCfg();
    cfg.phases.observe = {
      type: "observation",
      readOnly: true,
      fn: async () => {
        events.push("observe");
        return 1;
      },
    };
    cfg.sessionGuards = [
      {
        name: "sg",
        isActive: async () => {
          events.push("guard");
          return true;
        },
      },
    ];
    const agent = createOODAAgent(cfg);
    await agent.triggerCycle();
    expect(events[0]).toBe("guard");
    expect(events).toContain("observe");
  });
});

describe("OODA anti-pattern #6 — EXECUTION_MODE required", () => {
  it("missing executionMode throws", () => {
    const cfg = baseCfg();
    expect(() =>
      // @ts-expect-error — intentional
      createOODAAgent({ ...cfg, executionMode: undefined }),
    ).toThrow(/executionMode is REQUIRED/);
  });

  it("invalid executionMode throws", () => {
    const cfg = baseCfg();
    expect(() =>
      createOODAAgent({
        ...cfg,
        executionMode: "yolo" as unknown as "live",
      }),
    ).toThrow(/executionMode is REQUIRED/);
  });
});

describe("OODA anti-pattern #7 — readOnly observe/orient enforced", () => {
  it("non-readOnly observe rejected", () => {
    const cfg = baseCfg();
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
    ).toThrow(/readOnly/);
  });

  it("non-readOnly orient rejected", () => {
    const cfg = baseCfg();
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
    ).toThrow(/readOnly/);
  });
});

describe("OODA anti-pattern #8 — skip on tripped (no phase calls)", () => {
  it("riskGuard tripped → no phase fn called", async () => {
    const observe = vi.fn(async () => 1);
    const decide = vi.fn(async (i: number) => i);
    const cfg = baseCfg();
    cfg.phases.observe = { type: "observation", readOnly: true, fn: observe };
    cfg.phases.decide = { type: "decision", fn: decide };
    cfg.riskGuards = [
      {
        name: "tripped",
        check: async () => ({ proceed: false, reason: "open" }),
      },
    ];
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("skipped");
    expect(observe).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("OODA anti-pattern #9 — configurable thresholds w/ defaults", () => {
  it("DEFAULT_RESOURCE_LIMITS exposes 60s/200/256MB defaults", () => {
    expect(DEFAULT_RESOURCE_LIMITS.phaseTimeoutMs).toBe(60_000);
    expect(DEFAULT_RESOURCE_LIMITS.maxStepsPerCycle).toBe(200);
    expect(DEFAULT_RESOURCE_LIMITS.maxHeapMb).toBe(256);
  });

  it("custom resourceLimits accepted and applied", async () => {
    const cfg = baseCfg();
    cfg.resourceLimits = { phaseTimeoutMs: 25 };
    cfg.phases.decide = {
      type: "decision",
      fn: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 1;
      },
    };
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("failed");
  });
});

describe("OODA anti-pattern #10 — resource limits enforced", () => {
  it("maxStepsPerCycle bounded at runtime", async () => {
    const cfg = baseCfg();
    cfg.resourceLimits = { maxStepsPerCycle: 2 };
    // Force >2 insertStep calls by calling within a phase fn.
    cfg.phases.decide = {
      type: "decision",
      fn: async (_i, ctx) => {
        // First step is the phase's own insertStep; this is the 4th call.
        await ctx.insertStep({ type: "decision", phase: "extra-1" });
        await ctx.insertStep({ type: "decision", phase: "extra-2" });
        return 1;
      },
    };
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("failed");
  });

  it("heap exceeded triggers skip with warn log", async () => {
    const warn = vi.fn();
    const cfg = baseCfg();
    cfg.logger = { ...noopLogger, warn };
    cfg.resourceLimits = { maxHeapMb: 0.0001 }; // absurdly low → trip
    const agent = createOODAAgent(cfg);
    const r = await agent.triggerCycle();
    expect(r.status).toBe("skipped");
    expect(warn).toHaveBeenCalled();
  });
});
