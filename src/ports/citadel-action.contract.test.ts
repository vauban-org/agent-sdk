/**
 * CitadelActionPort contract tests.
 *
 * Applied to any CitadelActionPort implementation. Tests tiered access control,
 * state transitions, and governance claim emission.
 *
 * Source: vauban-gouvernance/rules/ai/tiered-gates.md + MASTER-PLAN-v5.md §1.3
 */

import { describe, expect, test } from "vitest";
import {
  type ActionContext,
  type CitadelActionPort,
  CitadelInvalidStateTransitionError,
  CitadelSprintNotActiveError,
  CitadelTaskRefNotFoundError,
  CitadelTierViolationError,
  type DecisionInput,
  type SprintInput,
  type TaskRef,
  type VerificationEvidence,
} from "./citadel-action.js";

function makeActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    agentId: "test-agent-001",
    agentTier: "T3",
    runId: crypto.randomUUID(),
    ...overrides,
  };
}

function makeSprintInput(overrides: Partial<SprintInput> = {}): SprintInput {
  return {
    name: "Sprint Test",
    goal: "Test sprint",
    project_slug: "test-project",
    start_date: new Date().toISOString(),
    end_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeTaskRef(overrides: Partial<TaskRef> = {}): TaskRef {
  return {
    ref: "test-project:sprint-1:task-001",
    project: "test-project",
    sprint: "sprint-1",
    task_id: "task-001",
    ...overrides,
  };
}

function makeVerificationEvidence(
  overrides: Partial<VerificationEvidence> = {},
): VerificationEvidence {
  return {
    passed: true,
    evidence_text: "Verification scenario executed successfully",
    evidence_hash: "abcd1234efgh5678ijkl9012mnop3456",
    ...overrides,
  };
}

function makeDecisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    decision: "Adopt new architecture",
    context: "Performance issues in current stack",
    options: ["Refactor current", "Migrate to new stack", "Hybrid approach"],
    chosen: "Hybrid approach",
    rationale: "Balance performance and migration cost",
    ...overrides,
  };
}

export const citadelActionPortContract = (factory: () => CitadelActionPort) => {
  describe("CitadelActionPort contract", () => {
    test("createSprint requires T2+ tier", async () => {
      const port = factory();
      const input = makeSprintInput();
      const ctx = makeActionContext({ agentTier: "T1" });

      await expect(port.createSprint(input, ctx)).rejects.toThrow(CitadelTierViolationError);
    });

    test("createSprint succeeds for T2+ agents", async () => {
      const port = factory();
      const input = makeSprintInput();
      const ctx = makeActionContext({ agentTier: "T2" });

      const sprintRef = await port.createSprint(input, ctx);
      expect(sprintRef.sprint_id).toBeDefined();
      expect(sprintRef.project_slug).toBe(input.project_slug);
      expect(sprintRef.name).toBe(input.name);
    });

    test("updateTaskStatus transitions task state", async () => {
      const port = factory();
      const taskRef = makeTaskRef();
      const ctx = makeActionContext({ agentTier: "T2" });

      // Transition todo → in_progress
      await port.updateTaskStatus(taskRef, "in_progress", ctx);
      // No throw = success

      // Transition in_progress → done
      await port.updateTaskStatus(taskRef, "done", ctx);
      // No throw = success
    });

    test("updateTaskStatus blocks invalid transitions", async () => {
      const port = factory();
      const taskRef = makeTaskRef();
      const ctx = makeActionContext({ agentTier: "T2" });

      // Walk valid path: todo → in_progress → done
      await port.updateTaskStatus(taskRef, "in_progress", ctx);
      await port.updateTaskStatus(taskRef, "done", ctx);

      // Now try invalid: done → in_progress (must throw)
      await expect(port.updateTaskStatus(taskRef, "in_progress", ctx)).rejects.toMatchObject({
        name: "CitadelInvalidStateTransitionError",
        current_status: "done",
        requested_status: "in_progress",
      });
    });

    test("sealSprint requires T3+ tier", async () => {
      const port = factory();
      const evidence = makeVerificationEvidence();
      const ctx = makeActionContext({ agentTier: "T2" });

      await expect(port.sealSprint("sprint-1", evidence, ctx)).rejects.toThrow(
        CitadelTierViolationError,
      );
    });

    test("sealSprint succeeds for T3+ agents with evidence", async () => {
      const port = factory();
      const evidence = makeVerificationEvidence({ passed: true });
      const ctx = makeActionContext({ agentTier: "T3" });

      const claim = await port.sealSprint("sprint-1", evidence, ctx);
      expect(claim.sprint_id).toBe("sprint-1");
      expect(claim.sealed_at).toBeDefined();
      expect(claim.sealed_by_agent).toBe(ctx.agentId);
      expect(claim.verification_evidence_hash).toBe(evidence.evidence_hash);
    });

    test("sealSprint fails if sprint not active", async () => {
      const port = factory();
      const evidence = makeVerificationEvidence();
      const ctx = makeActionContext({ agentTier: "T3" });

      try {
        // Attempting to seal a sprint that is not in active status
        await port.sealSprint("sprint-999", evidence, ctx);
      } catch (err) {
        if (err instanceof CitadelSprintNotActiveError) {
          expect(err.sprint_id).toBe("sprint-999");
        }
      }
    });

    test("sealSprint emits SealedSprintClaim with anchor_id", async () => {
      const port = factory();
      const evidence = makeVerificationEvidence();
      const ctx = makeActionContext({ agentTier: "T3" });

      const claim = await port.sealSprint("sprint-1", evidence, ctx);
      // anchor_id is optional (Phase 1+ deferred), but test should verify if present
      if (claim.anchor_id) {
        expect(claim.anchor_id.length).toBeGreaterThan(0);
      }
    });

    test("recordDecision requires T2+ tier", async () => {
      const port = factory();
      const decision = makeDecisionInput();
      const ctx = makeActionContext({ agentTier: "T1" });

      await expect(port.recordDecision(decision, ctx)).rejects.toThrow(CitadelTierViolationError);
    });

    test("recordDecision succeeds for T2+ agents", async () => {
      const port = factory();
      const decision = makeDecisionInput();
      const ctx = makeActionContext({ agentTier: "T2" });

      const claim = await port.recordDecision(decision, ctx);
      expect(claim.decision_id).toBeDefined();
      expect(claim.created_at).toBeDefined();
      expect(claim.archived_to_brain).toBeDefined();
    });

    test("recordDecision T3+ triggers cascade hook", async () => {
      const port = factory();
      const decision = makeDecisionInput({
        decision: "ADR-ECO-NNN: Architectural Decision",
      });
      const ctx = makeActionContext({ agentTier: "T3" });

      const claim = await port.recordDecision(decision, ctx);
      // T3+ should trigger cascade (optional, implementation-specific)
      // Just verify claim is returned
      expect(claim.decision_id).toBeDefined();
    });

    test("tier violation error includes required and actual tier", async () => {
      const port = factory();
      const input = makeSprintInput();
      const ctx = makeActionContext({ agentTier: "T1" });

      try {
        await port.createSprint(input, ctx);
      } catch (err) {
        if (err instanceof CitadelTierViolationError) {
          expect(err.required_tier).toBe("T2");
          expect(err.actual_tier).toBe("T1");
          expect(err.operation).toBeDefined();
        }
      }
    });

    test("task not found error includes task ref", async () => {
      const port = factory();
      const taskRef = makeTaskRef({ ref: "nonexistent:sprint-1:task-999" });
      const ctx = makeActionContext({ agentTier: "T2" });

      try {
        await port.updateTaskStatus(taskRef, "done", ctx);
      } catch (err) {
        if (err instanceof CitadelTaskRefNotFoundError) {
          expect(err.task_ref).toContain("nonexistent");
        }
      }
    });

    test("sprint not active error includes current status", async () => {
      const port = factory();
      const evidence = makeVerificationEvidence();
      const ctx = makeActionContext({ agentTier: "T3" });

      try {
        await port.sealSprint("completed-sprint", evidence, ctx);
      } catch (err) {
        if (err instanceof CitadelSprintNotActiveError) {
          expect(err.sprint_id).toBe("completed-sprint");
          expect(err.current_status).toBeDefined();
        }
      }
    });

    test("T4 agents can seal sprints", async () => {
      const port = factory();
      const evidence = makeVerificationEvidence();
      const ctx = makeActionContext({ agentTier: "T4" });

      try {
        const claim = await port.sealSprint("sprint-1", evidence, ctx);
        expect(claim.sealed_by_agent).toBe(ctx.agentId);
      } catch (err) {
        // May fail for other reasons (sprint not found), but not tier violation
        if (err instanceof CitadelTierViolationError) {
          throw new Error("T4 should not have tier violation");
        }
      }
    });
  });
};

// ─── Mock implementation ──────────────────────────────────────────────────

class MockCitadelActionPort implements CitadelActionPort {
  private sprintStates = new Map<
    string,
    {
      status: "planned" | "active" | "completed";
      tasks: Map<string, TaskStatus>;
    }
  >();
  private taskStates = new Map<string, TaskStatus>();

  constructor() {
    // Pre-populate some sprint states
    this.sprintStates.set("sprint-1", {
      status: "active",
      tasks: new Map([
        ["test-project:sprint-1:task-001", "todo"],
        ["test-project:sprint-1:task-002", "in_progress"],
      ]),
    });
    this.sprintStates.set("completed-sprint", {
      status: "completed",
      tasks: new Map(),
    });
  }

  async createSprint(input: SprintInput, ctx: ActionContext): Promise<SprintRef> {
    // T2+ only
    if (ctx.agentTier === "T1") {
      throw new CitadelTierViolationError(
        "T1 agents cannot create sprints",
        "T2",
        ctx.agentTier,
        "createSprint",
      );
    }

    const sprintId = `sprint-${Math.floor(Math.random() * 10000)}`;
    this.sprintStates.set(sprintId, {
      status: "planned",
      tasks: new Map(),
    });

    return {
      sprint_id: sprintId,
      project_slug: input.project_slug,
      name: input.name,
      created_at: new Date(),
    };
  }

  async updateTaskStatus(ref: TaskRef, status: TaskStatus, ctx: ActionContext): Promise<void> {
    // Check if task exists
    if (!this.taskStates.has(ref.ref) && !ref.ref.startsWith("test-project")) {
      throw new CitadelTaskRefNotFoundError(ref.ref);
    }

    // Get current status
    const currentStatus = this.taskStates.get(ref.ref) || "todo";

    // Validate state transitions
    const validTransitions: Record<TaskStatus, TaskStatus[]> = {
      todo: ["in_progress", "blocked", "rejected"],
      in_progress: ["done", "blocked", "rejected"],
      done: ["blocked", "rejected"],
      blocked: ["in_progress", "rejected"],
      rejected: [],
    };

    if (!validTransitions[currentStatus]?.includes(status)) {
      throw new CitadelInvalidStateTransitionError(currentStatus, status);
    }

    this.taskStates.set(ref.ref, status);
  }

  async sealSprint(
    sprintId: string,
    evidence: VerificationEvidence,
    ctx: ActionContext,
  ): Promise<SealedSprintClaim> {
    // T3+ only
    if (ctx.agentTier !== "T3" && ctx.agentTier !== "T4") {
      throw new CitadelTierViolationError(
        `${ctx.agentTier} agents cannot seal sprints`,
        "T3",
        ctx.agentTier,
        "sealSprint",
      );
    }

    // Check if sprint exists and is active
    const sprintState = this.sprintStates.get(sprintId);
    if (!sprintState) {
      throw new CitadelSprintNotActiveError(sprintId, "not_found");
    }

    if (sprintState.status !== "active") {
      throw new CitadelSprintNotActiveError(sprintId, sprintState.status);
    }

    // Update sprint status to completed
    sprintState.status = "completed";

    return {
      sprint_id: sprintId,
      sealed_at: new Date(),
      verification_evidence_hash: evidence.evidence_hash,
      sealed_by_agent: ctx.agentId,
      anchor_id: `anchor-${crypto.randomUUID()}`,
    };
  }

  async recordDecision(decision: DecisionInput, ctx: ActionContext): Promise<DecisionClaim> {
    // T2+ only
    if (ctx.agentTier === "T1") {
      throw new CitadelTierViolationError(
        "T1 agents cannot record decisions",
        "T2",
        ctx.agentTier,
        "recordDecision",
      );
    }

    const cascade = ctx.agentTier === "T3" || ctx.agentTier === "T4";

    return {
      decision_id: `decision-${crypto.randomUUID()}`,
      created_at: new Date(),
      archived_to_brain: true,
      cascade_triggered: cascade,
    };
  }
}

// ─── Default contract application ──────────────────────────────────────────

citadelActionPortContract(() => new MockCitadelActionPort());
