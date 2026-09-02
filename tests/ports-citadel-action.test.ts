/**
 * Tests for src/ports/citadel-action.ts
 *
 * Coverage:
 *   CitadelTierViolationError — .name, fields, message, instanceof chain
 *   CitadelTaskRefNotFoundError — .name, .task_ref, message, instanceof chain
 *   CitadelSprintNotActiveError — .name, .sprint_id, .current_status, message, instanceof chain
 *   CitadelInvalidStateTransitionError — .name, .current_status, .requested_status, message, instanceof chain
 *   Cross-class: errors are distinct, do not share prototype chains
 */

import { describe, expect, it } from "vitest";
import {
  CitadelInvalidStateTransitionError,
  CitadelSprintNotActiveError,
  CitadelTaskRefNotFoundError,
  CitadelTierViolationError,
} from "../src/ports/citadel-action.js";

// ─── CitadelTierViolationError ────────────────────────────────────────────────

describe("CitadelTierViolationError", () => {
  it(".name is 'CitadelTierViolationError'", () => {
    const err = new CitadelTierViolationError("tier violation", "T3", "T1", "sealSprint");
    expect(err.name).toBe("CitadelTierViolationError");
  });

  it("stores required_tier field", () => {
    const err = new CitadelTierViolationError("tier violation", "T3", "T1", "sealSprint");
    expect(err.required_tier).toBe("T3");
  });

  it("stores actual_tier field", () => {
    const err = new CitadelTierViolationError("tier violation", "T3", "T1", "sealSprint");
    expect(err.actual_tier).toBe("T1");
  });

  it("stores operation field", () => {
    const err = new CitadelTierViolationError("tier violation", "T2", "T1", "createSprint");
    expect(err.operation).toBe("createSprint");
  });

  it("uses the provided message", () => {
    const err = new CitadelTierViolationError(
      "agent tier T1 cannot seal sprint",
      "T3",
      "T1",
      "sealSprint",
    );
    expect(err.message).toBe("agent tier T1 cannot seal sprint");
  });

  it("stores optional cause field when provided", () => {
    const cause = new Error("upstream");
    const err = new CitadelTierViolationError("tier violation", "T4", "T2", "signOnChain", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause field is undefined when not provided", () => {
    const err = new CitadelTierViolationError("tier violation", "T3", "T1", "sealSprint");
    expect(err.cause).toBeUndefined();
  });

  it("instanceof Error", () => {
    const err = new CitadelTierViolationError("tier violation", "T3", "T1", "sealSprint");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof CitadelTierViolationError", () => {
    const err = new CitadelTierViolationError("tier violation", "T3", "T1", "sealSprint");
    expect(err).toBeInstanceOf(CitadelTierViolationError);
  });
});

// ─── CitadelTaskRefNotFoundError ──────────────────────────────────────────────

describe("CitadelTaskRefNotFoundError", () => {
  it(".name is 'CitadelTaskRefNotFoundError'", () => {
    const err = new CitadelTaskRefNotFoundError("myproject:sprint-1:task-42");
    expect(err.name).toBe("CitadelTaskRefNotFoundError");
  });

  it("stores task_ref field", () => {
    const err = new CitadelTaskRefNotFoundError("myproject:sprint-1:task-42");
    expect(err.task_ref).toBe("myproject:sprint-1:task-42");
  });

  it("message includes the task ref", () => {
    const err = new CitadelTaskRefNotFoundError("myproject:sprint-1:task-99");
    expect(err.message).toContain("myproject:sprint-1:task-99");
  });

  it("message indicates not found", () => {
    const err = new CitadelTaskRefNotFoundError("abc:sprint-3:t1");
    expect(err.message.toLowerCase()).toContain("not found");
  });

  it("stores optional cause when provided", () => {
    const cause = new Error("db error");
    const err = new CitadelTaskRefNotFoundError("proj:s1:t1", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new CitadelTaskRefNotFoundError("proj:s1:t1");
    expect(err.cause).toBeUndefined();
  });

  it("instanceof Error", () => {
    const err = new CitadelTaskRefNotFoundError("proj:s1:t1");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof CitadelTaskRefNotFoundError", () => {
    const err = new CitadelTaskRefNotFoundError("proj:s1:t1");
    expect(err).toBeInstanceOf(CitadelTaskRefNotFoundError);
  });
});

// ─── CitadelSprintNotActiveError ──────────────────────────────────────────────

describe("CitadelSprintNotActiveError", () => {
  it(".name is 'CitadelSprintNotActiveError'", () => {
    const err = new CitadelSprintNotActiveError("sprint-77", "planned");
    expect(err.name).toBe("CitadelSprintNotActiveError");
  });

  it("stores sprint_id field", () => {
    const err = new CitadelSprintNotActiveError("sprint-77", "planned");
    expect(err.sprint_id).toBe("sprint-77");
  });

  it("stores current_status field", () => {
    const err = new CitadelSprintNotActiveError("sprint-77", "completed");
    expect(err.current_status).toBe("completed");
  });

  it("message includes sprint_id", () => {
    const err = new CitadelSprintNotActiveError("sprint-77", "planned");
    expect(err.message).toContain("sprint-77");
  });

  it("message includes current_status", () => {
    const err = new CitadelSprintNotActiveError("sprint-77", "planned");
    expect(err.message).toContain("planned");
  });

  it("stores optional cause when provided", () => {
    const cause = new Error("conflict");
    const err = new CitadelSprintNotActiveError("s-1", "completed", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new CitadelSprintNotActiveError("s-1", "planned");
    expect(err.cause).toBeUndefined();
  });

  it("instanceof Error", () => {
    const err = new CitadelSprintNotActiveError("s-1", "planned");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof CitadelSprintNotActiveError", () => {
    const err = new CitadelSprintNotActiveError("s-1", "planned");
    expect(err).toBeInstanceOf(CitadelSprintNotActiveError);
  });
});

// ─── CitadelInvalidStateTransitionError ──────────────────────────────────────

describe("CitadelInvalidStateTransitionError", () => {
  it(".name is 'CitadelInvalidStateTransitionError'", () => {
    const err = new CitadelInvalidStateTransitionError("done", "todo");
    expect(err.name).toBe("CitadelInvalidStateTransitionError");
  });

  it("stores current_status field", () => {
    const err = new CitadelInvalidStateTransitionError("done", "in_progress");
    expect(err.current_status).toBe("done");
  });

  it("stores requested_status field", () => {
    const err = new CitadelInvalidStateTransitionError("done", "in_progress");
    expect(err.requested_status).toBe("in_progress");
  });

  it("message includes both statuses", () => {
    const err = new CitadelInvalidStateTransitionError("rejected", "in_progress");
    expect(err.message).toContain("rejected");
    expect(err.message).toContain("in_progress");
  });

  it("stores optional cause when provided", () => {
    const cause = new Error("constraint");
    const err = new CitadelInvalidStateTransitionError("done", "todo", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new CitadelInvalidStateTransitionError("done", "todo");
    expect(err.cause).toBeUndefined();
  });

  it("instanceof Error", () => {
    const err = new CitadelInvalidStateTransitionError("blocked", "done");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof CitadelInvalidStateTransitionError", () => {
    const err = new CitadelInvalidStateTransitionError("blocked", "done");
    expect(err).toBeInstanceOf(CitadelInvalidStateTransitionError);
  });
});

// ─── Cross-class isolation ────────────────────────────────────────────────────

describe("error class isolation", () => {
  it("CitadelTierViolationError is not instanceof CitadelTaskRefNotFoundError", () => {
    const err = new CitadelTierViolationError("v", "T3", "T1", "op");
    expect(err).not.toBeInstanceOf(CitadelTaskRefNotFoundError);
  });

  it("CitadelTaskRefNotFoundError is not instanceof CitadelSprintNotActiveError", () => {
    const err = new CitadelTaskRefNotFoundError("ref");
    expect(err).not.toBeInstanceOf(CitadelSprintNotActiveError);
  });

  it("CitadelSprintNotActiveError is not instanceof CitadelInvalidStateTransitionError", () => {
    const err = new CitadelSprintNotActiveError("s", "planned");
    expect(err).not.toBeInstanceOf(CitadelInvalidStateTransitionError);
  });

  it("CitadelInvalidStateTransitionError is not instanceof CitadelTierViolationError", () => {
    const err = new CitadelInvalidStateTransitionError("done", "todo");
    expect(err).not.toBeInstanceOf(CitadelTierViolationError);
  });

  it("all four error classes are catchable as Error", () => {
    const errors: Error[] = [
      new CitadelTierViolationError("v", "T3", "T1", "op"),
      new CitadelTaskRefNotFoundError("ref"),
      new CitadelSprintNotActiveError("s", "planned"),
      new CitadelInvalidStateTransitionError("done", "todo"),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("all four error classes have distinct .name values", () => {
    const names = [
      new CitadelTierViolationError("v", "T3", "T1", "op").name,
      new CitadelTaskRefNotFoundError("ref").name,
      new CitadelSprintNotActiveError("s", "planned").name,
      new CitadelInvalidStateTransitionError("done", "todo").name,
    ];
    const unique = new Set(names);
    expect(unique.size).toBe(4);
  });
});
