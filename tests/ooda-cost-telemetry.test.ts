/**
 * Regression — LLM cost/token metadata returned by an OODA phase MUST reach the
 * telemetry sink (telemetry.step.costUsd + telemetry.finish.totalCostUsd) so a
 * sink can persist agent_run.cost_usd / input_tokens / output_tokens.
 *
 * Before the 2026-05-28 fix, `_runOodaPhase` completed each step with
 * `{ output_hash, output: out }` — the phase return value was nested under
 * `output`, so `emitStepEvent` (which reads costUsd/inputTokens/outputTokens
 * from the TOP LEVEL of the merged payload) saw 0. Result: every OODA agent
 * reported $0 cost and 0 tokens even when its phases did real LLM work.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type DbClient,
  type OODAAgentConfig,
  type PhaseDef,
  createOODAAgent,
  noopLogger,
} from "../src/index.js";
import type { TelemetryRunFinish, TelemetryRunStep, TelemetrySink } from "../src/telemetry/port.js";

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

function ro<T>(p: PhaseDef<unknown, T>): PhaseDef<unknown, T> {
  return { ...p, readOnly: true };
}

function buildSinkSpy() {
  const steps: TelemetryRunStep[] = [];
  let finishEvent: TelemetryRunFinish | null = null;
  const sink: TelemetrySink = {
    name: "test-capture",
    start: vi.fn(async () => "run-ref"),
    step: vi.fn(async (_runId: string, delta: TelemetryRunStep) => {
      steps.push(delta);
    }),
    finish: vi.fn(async (_runId: string, ev: TelemetryRunFinish) => {
      finishEvent = ev;
    }),
  };
  return { sink, steps, getFinish: () => finishEvent };
}

/** Flush the fire-and-forget telemetry promise chains. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("OODA cost telemetry — phase output cost reaches the sink", () => {
  it("lifts costUsd/inputTokens/outputTokens from the decide phase output", async () => {
    const { sink, steps, getFinish } = buildSinkSpy();

    const cfg = {
      agentId: "test-cost-telemetry",
      agentVersion: "1.0.0",
      intervalMs: 0,
      executionMode: "dry-run",
      db: fakeDb,
      deps: {},
      logger: noopLogger,
      telemetry: sink,
      phases: {
        observe: ro({
          type: "observation",
          fn: async () => ({ ok: true }),
        }) as PhaseDef<unknown, unknown>,
        orient: ro({
          type: "retrieval",
          fn: async () => ({ ok: true }),
        }) as PhaseDef<unknown, unknown>,
        decide: {
          type: "decision",
          // A real generative phase returns its LLM accounting at the TOP LEVEL.
          fn: async () => ({
            verified: true,
            costUsd: 0.05,
            inputTokens: 100,
            outputTokens: 200,
          }),
        },
        // act returns its own execution result ; it does NOT echo the decide
        // output, so cost is reported exactly once (per-phase contract: each
        // phase surfaces only its OWN LLM accounting at the top level).
        act: { type: "execution", fn: async () => ({ published: true }) },
        feedback: { type: "feedback", fn: async () => ({ done: true }) },
      },
    } as unknown as OODAAgentConfig<unknown, unknown, unknown, unknown, unknown, unknown>;

    const agent = createOODAAgent(cfg);
    await agent.triggerCycle({ dryRun: true });
    await flush();

    // The decision step carries the lifted cost/token deltas.
    const decisionStep = steps.find((s) => s.kind === "decision");
    expect(decisionStep, "decision step emitted").toBeDefined();
    expect(decisionStep?.costUsd).toBe(0.05);
    expect(decisionStep?.inputTokens).toBe(100);
    expect(decisionStep?.outputTokens).toBe(200);

    // A non-LLM phase contributes zero (no false positive from the lift).
    const observeStep = steps.find((s) => s.kind === "observation");
    expect(observeStep?.costUsd ?? 0).toBe(0);

    // Aggregated on the finish event → CC sink persists agent_run.cost_usd.
    const finish = getFinish();
    expect(finish?.totalCostUsd).toBe(0.05);
    expect(finish?.totalInputTokens).toBe(100);
    expect(finish?.totalOutputTokens).toBe(200);
  });
});
