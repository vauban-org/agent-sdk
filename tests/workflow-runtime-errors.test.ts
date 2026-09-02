/**
 * Tests for workflow error classes in src/ports/workflow-runtime.ts
 *
 * Coverage:
 *   WorkflowNotFoundError — .name, .runId, message
 *   WorkflowNonDeterminismError — .name, .runId, .stepIndex, .expected, .actual, message
 *   WorkflowSignalTimeoutError — .name, .runId, .signalName, .timeoutMs, message
 *   WorkflowLeaseConflictError — .name, .runId, .currentOwner, message
 *   WorkflowVersionMismatchError — .name, .runId, .expected, .actual, message
 *
 * Ref: test coverage for workflow runtime error classes (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  WorkflowLeaseConflictError,
  WorkflowNonDeterminismError,
  WorkflowNotFoundError,
  WorkflowSignalTimeoutError,
  WorkflowVersionMismatchError,
} from "../src/ports/workflow-runtime.js";

describe("WorkflowNotFoundError", () => {
  it(".name is 'WorkflowNotFoundError'", () => {
    expect(new WorkflowNotFoundError("run-1").name).toBe("WorkflowNotFoundError");
  });

  it("stores runId", () => {
    expect(new WorkflowNotFoundError("run-abc").runId).toBe("run-abc");
  });

  it("message contains runId", () => {
    expect(new WorkflowNotFoundError("run-abc").message).toContain("run-abc");
  });

  it("instanceof Error and WorkflowNotFoundError", () => {
    const err = new WorkflowNotFoundError("r");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorkflowNotFoundError);
  });
});

describe("WorkflowNonDeterminismError", () => {
  it(".name is 'WorkflowNonDeterminismError'", () => {
    expect(new WorkflowNonDeterminismError("run-1", 3, "step_a", "step_b").name).toBe(
      "WorkflowNonDeterminismError",
    );
  });

  it("stores all fields", () => {
    const err = new WorkflowNonDeterminismError("run-1", 5, "expected_step", "actual_step");
    expect(err.runId).toBe("run-1");
    expect(err.stepIndex).toBe(5);
    expect(err.expected).toBe("expected_step");
    expect(err.actual).toBe("actual_step");
  });

  it("message contains stepIndex, expected, actual", () => {
    const err = new WorkflowNonDeterminismError("run-1", 2, "A", "B");
    expect(err.message).toContain("2");
    expect(err.message).toContain("A");
    expect(err.message).toContain("B");
  });
});

describe("WorkflowSignalTimeoutError", () => {
  it(".name is 'WorkflowSignalTimeoutError'", () => {
    expect(new WorkflowSignalTimeoutError("run-1", "approval", 5000).name).toBe(
      "WorkflowSignalTimeoutError",
    );
  });

  it("stores runId, signalName, timeoutMs", () => {
    const err = new WorkflowSignalTimeoutError("run-1", "hitl_approval", 30000);
    expect(err.runId).toBe("run-1");
    expect(err.signalName).toBe("hitl_approval");
    expect(err.timeoutMs).toBe(30000);
  });

  it("message contains signalName and timeoutMs", () => {
    const err = new WorkflowSignalTimeoutError("r", "my_signal", 10000);
    expect(err.message).toContain("my_signal");
    expect(err.message).toContain("10000");
  });
});

describe("WorkflowLeaseConflictError", () => {
  it(".name is 'WorkflowLeaseConflictError'", () => {
    expect(new WorkflowLeaseConflictError("run-1", "worker-2").name).toBe(
      "WorkflowLeaseConflictError",
    );
  });

  it("stores runId and currentOwner", () => {
    const err = new WorkflowLeaseConflictError("run-abc", "worker-99");
    expect(err.runId).toBe("run-abc");
    expect(err.currentOwner).toBe("worker-99");
  });

  it("message contains runId and currentOwner", () => {
    const err = new WorkflowLeaseConflictError("run-1", "owner-7");
    expect(err.message).toContain("run-1");
    expect(err.message).toContain("owner-7");
  });
});

describe("WorkflowVersionMismatchError", () => {
  it(".name is 'WorkflowVersionMismatchError'", () => {
    expect(new WorkflowVersionMismatchError("run-1", "v1", "v2").name).toBe(
      "WorkflowVersionMismatchError",
    );
  });

  it("stores runId, expected, actual", () => {
    const err = new WorkflowVersionMismatchError("run-1", "1.0.0", "1.1.0");
    expect(err.runId).toBe("run-1");
    expect(err.expected).toBe("1.0.0");
    expect(err.actual).toBe("1.1.0");
  });

  it("message contains expected and actual versions", () => {
    const err = new WorkflowVersionMismatchError("r", "v1", "v3");
    expect(err.message).toContain("v1");
    expect(err.message).toContain("v3");
  });
});
