/**
 * tests/outcomes-trajectory.test.ts
 *
 * Sprint-563: B3 — Trajectory export RLHF/DPO + tokens + costUsd.
 */

import { describe, expect, it } from "vitest";
import { exportTrajectory, serializeTrajectory } from "../src/outcomes/trajectory.js";
import type { TrajectoryStep } from "../src/outcomes/trajectory.js";

function fakeDb(rows: Record<string, unknown>[]) {
  return {
    query: async () => ({ rows }),
  } as any;
}

describe("exportTrajectory", () => {
  it("exports steps from DB rows", async () => {
    const db = fakeDb([
      {
        step_index: "0",
        phase: "observe",
        type: "retrieval",
        payload: JSON.stringify({ query: "market" }),
        model: "llama-3.3-70b",
        provider: "groq",
        input_tokens: "100",
        output_tokens: "50",
        cost_usd: "0.0001",
        duration_ms: "200",
        created_at: "2026-01-01T00:00:00Z",
        outcome_value_cents: "100",
      },
    ]);

    const exp = await exportTrajectory("run-1", db);
    expect(exp.steps).toHaveLength(1);
    expect(exp.steps[0]!.label).toBe("positive");
    expect(exp.steps[0]!.model).toBe("llama-3.3-70b");
    expect(exp.totalCost).toBe(0.0001);
    expect(exp.totalTokens).toBe(150);
  });

  it("labels negative when value_cents < 0", async () => {
    const db = fakeDb([
      {
        step_index: "0",
        phase: "act",
        type: "execution",
        outcome_value_cents: "-50",
        input_tokens: "10",
        output_tokens: "5",
        cost_usd: "0",
        duration_ms: "100",
      },
    ]);

    const exp = await exportTrajectory("run-1", db);
    expect(exp.steps[0]!.label).toBe("negative");
  });

  it("labels neutral when value_cents is null", async () => {
    const db = fakeDb([
      {
        step_index: "0",
        phase: "observe",
        type: "retrieval",
        outcome_value_cents: null,
        input_tokens: "10",
        output_tokens: "5",
        cost_usd: "0",
        duration_ms: "100",
      },
    ]);

    const exp = await exportTrajectory("run-1", db);
    expect(exp.steps[0]!.label).toBe("neutral");
  });

  it("skips steps below minTokens threshold", async () => {
    const db = fakeDb([
      {
        step_index: "0",
        phase: "observe",
        type: "retrieval",
        input_tokens: "0",
        output_tokens: "0",
        cost_usd: "0",
        duration_ms: "50",
        outcome_value_cents: null,
      },
      {
        step_index: "1",
        phase: "orient",
        type: "decision",
        input_tokens: "200",
        output_tokens: "100",
        cost_usd: "0.001",
        duration_ms: "500",
        outcome_value_cents: "10",
      },
    ]);

    const exp = await exportTrajectory("run-1", db, {
      format: "jsonl",
      minTokens: 50,
    });

    expect(exp.steps).toHaveLength(1);
    expect(exp.steps[0]!.phase).toBe("orient");
  });
});

describe("serializeTrajectory", () => {
  it("serializes as JSONL", () => {
    const steps: TrajectoryStep[] = [
      {
        runId: "r1",
        stepIndex: 0,
        phase: "observe",
        type: "retrieval",
        label: "neutral",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0,
        durationMs: 100,
      },
    ];

    const jsonl = serializeTrajectory({
      steps,
      totalCost: 0,
      totalTokens: 15,
      format: "jsonl",
    });

    const parsed = JSON.parse(jsonl.split("\n")[0]!);
    expect(parsed.runId).toBe("r1");
  });

  it("serializes as OpenAI DPO pairs", () => {
    const steps: TrajectoryStep[] = [
      {
        runId: "r1",
        stepIndex: 0,
        phase: "act",
        type: "execution",
        label: "positive",
        output: "Success",
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 500,
      },
      {
        runId: "r1",
        stepIndex: 1,
        phase: "act",
        type: "execution",
        label: "negative",
        output: "Failure",
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 500,
      },
    ];

    const dpo = serializeTrajectory({
      steps,
      totalCost: 0.02,
      totalTokens: 300,
      format: "openai-dpo",
    });

    const pair = JSON.parse(dpo.split("\n")[0]!);
    expect(pair.chosen).toBeDefined();
    expect(pair.rejected).toBeDefined();
  });
});
