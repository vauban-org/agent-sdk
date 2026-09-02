/**
 * Minimal OODA agent example — V6 risk 19 mitigation (≤50 lines).
 *
 * Sprint: command-center:sprint-525:quick-1
 *
 * Demonstrates type-safe phase chaining and one-shot triggerCycle.
 * Expanded: additional edge-case coverage for phase errors, dry-run,
 * multiple cycles, and agentId propagation.
 */

import { describe, expect, it } from "vitest";
import { type DbClient, createOODAAgent, noopLogger } from "../src/index.js";

const fakeDb: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) };

/** Build a minimal agent with arithmetic phases for value-threading tests. */
function makeArithAgent(
  feedbackSink: (v: number) => void,
  opts: { agentId?: string; intervalMs?: number } = {},
) {
  return createOODAAgent<unknown, number, number, number, number, number>({
    agentId: opts.agentId ?? "minimal",
    intervalMs: opts.intervalMs ?? 0,
    executionMode: "dry-run",
    db: fakeDb,
    logger: noopLogger,
    phases: {
      observe: { type: "observation", readOnly: true, fn: async () => 1 },
      orient: { type: "retrieval", readOnly: true, fn: async (i) => i + 1 },
      decide: { type: "decision", fn: async (i) => i * 2 },
      act: { type: "execution", fn: async (i) => i + 10 },
      feedback: {
        type: "feedback",
        fn: async (i) => {
          feedbackSink(i);
          return i;
        },
      },
    },
  });
}

describe("OODA — minimal example (V6 risk 19, ≤50 lines)", () => {
  it("runs one cycle and threads typed data observe→feedback", async () => {
    let lastFeedback = 0;
    const agent = makeArithAgent((v) => {
      lastFeedback = v;
    });
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
    expect(lastFeedback).toBe(14); // ((1+1)*2)+10 = 14
  });

  it("returns succeeded status on a clean cycle", async () => {
    const agent = makeArithAgent(() => {});
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
  });

  it("second triggerCycle call also succeeds (no shared mutable state between cycles)", async () => {
    const values: number[] = [];
    const agent = makeArithAgent((v) => values.push(v));
    await agent.triggerCycle({ dryRun: false });
    await agent.triggerCycle({ dryRun: false });
    expect(values).toHaveLength(2);
    expect(values[0]).toBe(14);
    expect(values[1]).toBe(14);
  });

  it("phase error propagates as failed status", async () => {
    const agent = createOODAAgent<unknown, number, number, number, number, number>({
      agentId: "error-agent",
      intervalMs: 0,
      executionMode: "dry-run",
      db: fakeDb,
      logger: noopLogger,
      phases: {
        observe: {
          type: "observation",
          readOnly: true,
          fn: async () => {
            throw new Error("observe failed");
          },
        },
        orient: { type: "retrieval", readOnly: true, fn: async (i) => i },
        decide: { type: "decision", fn: async (i) => i },
        act: { type: "execution", fn: async (i) => i },
        feedback: { type: "feedback", fn: async (i) => i },
      },
    });
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("failed");
  });

  it("custom agentId does not affect cycle outcome", async () => {
    const agent = makeArithAgent(() => {}, { agentId: "my-named-agent" });
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
  });

  it("string phase data is threaded correctly", async () => {
    let result = "";
    const agent = createOODAAgent<unknown, string, string, string, string, string>({
      agentId: "str-agent",
      intervalMs: 0,
      executionMode: "dry-run",
      db: fakeDb,
      logger: noopLogger,
      phases: {
        observe: {
          type: "observation",
          readOnly: true,
          fn: async () => "hello",
        },
        orient: {
          type: "retrieval",
          readOnly: true,
          fn: async (s) => `${s} world`,
        },
        decide: { type: "decision", fn: async (s) => s.toUpperCase() },
        act: { type: "execution", fn: async (s) => `[${s}]` },
        feedback: {
          type: "feedback",
          fn: async (s) => {
            result = s;
            return s;
          },
        },
      },
    });
    const r = await agent.triggerCycle({ dryRun: false });
    expect(r.status).toBe("succeeded");
    expect(result).toBe("[HELLO WORLD]");
  });
});
