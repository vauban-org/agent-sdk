/**
 * Tests for packages/agent-sdk/src/orchestration/ooda/plan-execute.ts
 *
 * Coverage:
 *   decomposeTask — delegates to decomposer function, returns plan
 *   executeStep — completed status with output, failed status on throw,
 *                 error message captured, durationMs is non-negative
 *
 * Ref: test coverage for agent-sdk/orchestration/ooda/plan-execute.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { decomposeTask, executeStep } from "../src/orchestration/ooda/plan-execute.js";
import type { Plan, PlanStep } from "../src/orchestration/ooda/plan-execute.js";

const PLAN: Plan = {
  goal: "refactor auth module",
  steps: [
    { index: 0, description: "read current files" },
    { index: 1, description: "write new module" },
  ],
};

const STEP: PlanStep = {
  index: 0,
  description: "read current files",
  tool: "read_file",
};

// ─── decomposeTask ────────────────────────────────────────────────────────────

describe("decomposeTask", () => {
  it("calls decomposer with the task description", async () => {
    const decomposer = vi.fn().mockResolvedValue(PLAN);
    await decomposeTask("refactor auth module", decomposer);
    expect(decomposer).toHaveBeenCalledWith("refactor auth module");
  });

  it("returns the plan from the decomposer", async () => {
    const result = await decomposeTask("task", async () => PLAN);
    expect(result).toBe(PLAN);
  });

  it("propagates decomposer rejection", async () => {
    await expect(
      decomposeTask("task", async () => {
        throw new Error("LLM timeout");
      }),
    ).rejects.toThrow("LLM timeout");
  });
});

// ─── executeStep ─────────────────────────────────────────────────────────────

describe("executeStep", () => {
  it("returns completed status with output on success", async () => {
    const result = await executeStep(STEP, async () => ({
      files: ["auth.ts"],
    }));
    expect(result.stepIndex).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ files: ["auth.ts"] });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns failed status with error message on throw", async () => {
    const result = await executeStep(STEP, async () => {
      throw new Error("file not found");
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("file not found");
    expect(result.output).toBeUndefined();
  });

  it("captures non-Error throw as string", async () => {
    const result = await executeStep(STEP, async () => {
      throw "string error"; // eslint-disable-line @typescript-eslint/no-throw-literal
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("string error");
  });

  it("passes step to executor", async () => {
    const executor = vi.fn().mockResolvedValue("ok");
    await executeStep(STEP, executor);
    expect(executor).toHaveBeenCalledWith(STEP);
  });

  it("stepIndex matches step.index", async () => {
    const step: PlanStep = { index: 3, description: "step 3" };
    const result = await executeStep(step, async () => "done");
    expect(result.stepIndex).toBe(3);
  });
});
