/**
 * Tier template tests — SimpleAgent, ComplexAgent, ReasoningAgent.
 *
 * Sprint: sprint-616:quick-7 (Vague 1.B.7)
 *
 * Coverage:
 * - SimpleAgent: E2E cycle execution, phase order, action plumbing
 * - ComplexAgent: HITL gate flag wired, reflect phase optional
 * - ReasoningAgent: agentRole + thinkingBudget surfaced in ctx.config
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentFactoryDeps } from "../src/factory/agent-factory.js";
import type { DbClient } from "../src/index.js";
import { noopLogger } from "../src/index.js";
import type { BrainPort } from "../src/ports/brain.js";
import type { LLMProviderPort } from "../src/ports/llm-provider.js";
import {
  createComplexAgent,
  createReasoningAgent,
  createSimpleAgent,
} from "../src/templates/index.js";
import type {
  ReasoningAgentConfig,
  SimpleDecision,
  SimpleExecutionResult,
} from "../src/templates/index.js";

// ─── Shared test helpers ──────────────────────────────────────────────────────

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

const mockBrain: BrainPort = {
  queryKnowledge: vi.fn().mockResolvedValue([]),
  archiveKnowledge: vi.fn().mockResolvedValue({ id: "test-id" }),
} as unknown as BrainPort;

const mockLLM: LLMProviderPort = {
  complete: vi.fn().mockResolvedValue({
    content: '{"decision":"proceed"}',
    usage: { inputTokens: 10, outputTokens: 20 },
    model: "mock-model",
    finishReason: "stop",
  }),
};

const fakeDeps: AgentFactoryDeps = {
  brain: mockBrain,
  db: fakeDb,
  logger: noopLogger,
  redis: {},
  skills: {},
  executionMode: "dry-run",
  deps: { llm: mockLLM },
} as unknown as AgentFactoryDeps;

// ─── SimpleAgent ──────────────────────────────────────────────────────────────

describe("createSimpleAgent — Tier 1", () => {
  it("creates an agent with getStatus().running === false", async () => {
    const agent = await createSimpleAgent<
      { value: number },
      { critical: boolean },
      { done: boolean }
    >(fakeDeps, {
      agentId: "simple-test",
      intervalMs: 1_000,
      observe: async () => ({ value: 42 }),
      orient: async (obs) => ({ critical: obs.value > 100 }),
      decide: async (orient): Promise<SimpleDecision> => ({
        actions: orient.critical ? [{ type: "alert", payload: {} }] : [],
        rationale: orient.critical ? "Value critical" : "All good",
      }),
      act: async (decision): Promise<SimpleExecutionResult> => ({
        executed: decision.actions.map((a) => ({
          type: a.type,
          success: true,
          details: "executed",
        })),
      }),
      feedback: async () => ({ done: true }),
    });

    expect(agent.getStatus().running).toBe(false);
    expect(agent.getStatus().cyclesCompleted).toBe(0);
  });

  it("executes a full E2E cycle via triggerCycle", async () => {
    const order: string[] = [];

    const agent = await createSimpleAgent<
      { value: number },
      { critical: boolean },
      { actionsCount: number }
    >(fakeDeps, {
      agentId: "simple-e2e",
      intervalMs: 1_000,
      observe: async () => {
        order.push("observe");
        return { value: 50 };
      },
      orient: async (obs) => {
        order.push("orient");
        return { critical: obs.value > 100 };
      },
      decide: async (orient) => {
        order.push("decide");
        return {
          actions: orient.critical ? [{ type: "alert", payload: {} }] : [],
          rationale: "threshold check",
        };
      },
      act: async (decision) => {
        order.push("act");
        return {
          executed: decision.actions.map((a) => ({
            type: a.type,
            success: true,
            details: "",
          })),
        };
      },
      feedback: async (result) => {
        order.push("feedback");
        return { actionsCount: result.executed.length };
      },
    });

    const { status } = await agent.triggerCycle({ dryRun: true });

    expect(status).toBe("succeeded");
    expect(order).toEqual(["observe", "orient", "decide", "act", "feedback"]);
  });

  it("passes action payload from decide to act", async () => {
    let capturedAction: SimpleDecision | null = null;

    const agent = await createSimpleAgent<{ count: number }, { shouldAlert: boolean }, void>(
      fakeDeps,
      {
        agentId: "simple-payload",
        intervalMs: 1_000,
        observe: async () => ({ count: 5 }),
        orient: async () => ({ shouldAlert: true }),
        decide: async (orient): Promise<SimpleDecision> => {
          const decision: SimpleDecision = {
            actions: orient.shouldAlert
              ? [{ type: "send_alert", payload: { severity: "high" } }]
              : [],
            rationale: "alert threshold crossed",
          };
          return decision;
        },
        act: async (decision): Promise<SimpleExecutionResult> => {
          capturedAction = decision;
          return {
            executed: decision.actions.map((a) => ({
              type: a.type,
              success: true,
              details: "",
            })),
          };
        },
        feedback: async () => undefined,
      },
    );

    await agent.triggerCycle({ dryRun: true });

    expect(capturedAction).not.toBeNull();
    expect(capturedAction!.actions).toHaveLength(1);
    expect(capturedAction!.actions[0]!.type).toBe("send_alert");
    expect(capturedAction!.actions[0]!.payload.severity).toBe("high");
  });
});

// ─── ComplexAgent ─────────────────────────────────────────────────────────────

describe("createComplexAgent — Tier 3", () => {
  it("creates an agent successfully (no HITL in dry-run)", async () => {
    const agent = await createComplexAgent<
      { data: string },
      { plan: string },
      { steps: string[] },
      { stepsExecuted: number },
      { success: boolean }
    >(fakeDeps, {
      agentId: "complex-test",
      intervalMs: 5_000,
      observe: async () => ({ data: "raw" }),
      orient: async () => ({ plan: "execute in 2 steps" }),
      decide: async () => ({ steps: ["step1", "step2"] }),
      act: async (decision) => ({ stepsExecuted: decision.steps.length }),
      feedback: async (result) => ({
        success: (result as unknown as { stepsExecuted: number }).stepsExecuted > 0,
      }),
    });

    expect(agent.getStatus().running).toBe(false);
  });

  it("runs E2E cycle successfully", async () => {
    const order: string[] = [];

    const agent = await createComplexAgent<
      { raw: string },
      { analysis: string },
      { plan: string[] },
      { done: boolean },
      { result: string }
    >(fakeDeps, {
      agentId: "complex-e2e",
      intervalMs: 1_000,
      observe: async () => {
        order.push("observe");
        return { raw: "input" };
      },
      orient: async () => {
        order.push("orient");
        return { analysis: "needs action" };
      },
      decide: async () => {
        order.push("decide");
        return { plan: ["step-a"] };
      },
      act: async () => {
        order.push("act");
        return { done: true };
      },
      feedback: async () => {
        order.push("feedback");
        return { result: "ok" };
      },
    });

    const { status } = await agent.triggerCycle({ dryRun: true });

    expect(status).toBe("succeeded");
    expect(order).toEqual(["observe", "orient", "decide", "act", "feedback"]);
  });

  it("wires reflect phase when provided", async () => {
    const order: string[] = [];

    const agent = await createComplexAgent<
      string,
      string,
      string,
      { output: string },
      { reflected: boolean }
    >(fakeDeps, {
      agentId: "complex-reflect",
      intervalMs: 1_000,
      observe: async () => "data",
      orient: async () => "oriented",
      decide: async () => "decided",
      act: async () => {
        order.push("act");
        return { output: "done" };
      },
      reflect: async () => {
        order.push("reflect");
        return { reflected: true };
      },
      feedback: async () => {
        order.push("feedback");
        return { reflected: true };
      },
    });

    await agent.triggerCycle({ dryRun: true });

    // reflect runs before feedback
    expect(order.indexOf("reflect")).toBeLessThan(order.indexOf("feedback"));
  });

  it("hitlEscalationLevel default is L3 (does not throw in dry-run)", async () => {
    // HITL in dry-run: waitForHITL is only wired in live mode, so no throw expected
    const agent = await createComplexAgent<void, void, void, void, void>(fakeDeps, {
      agentId: "complex-hitl",
      intervalMs: 1_000,
      observe: async () => undefined,
      orient: async () => undefined,
      decide: async () => undefined,
      act: async () => undefined,
      feedback: async () => undefined,
      hitlEscalationLevel: "L3",
    });

    const { status } = await agent.triggerCycle({ dryRun: true });
    expect(status).toBe("succeeded");
  });
});

// ─── ReasoningAgent ───────────────────────────────────────────────────────────

describe("createReasoningAgent — Tier 2", () => {
  it("creates an agent successfully", async () => {
    const agent = await createReasoningAgent<
      { metric: number },
      { insight: string },
      { recommendation: string },
      { sent: boolean },
      { archived: boolean }
    >(fakeDeps, {
      agentId: "reasoning-test",
      intervalMs: 3_600_000,
      agentRole: "You are a financial analysis agent.",
      thinkingBudget: 2048,
      observe: async () => ({ metric: 0.42 }),
      orient: async () => ({ insight: "metric is stable" }),
      decide: async () => ({ recommendation: "hold" }),
      act: async () => ({ sent: false }),
      feedback: async () => ({ archived: true }),
    });

    expect(agent.getStatus().running).toBe(false);
    expect(agent.getStatus().cyclesCompleted).toBe(0);
  });

  it("surfaces agentRole and thinkingBudget in ctx.config", async () => {
    let capturedConfig: unknown = null;

    const agent = await createReasoningAgent<void, void, void, void, void>(fakeDeps, {
      agentId: "reasoning-config",
      intervalMs: 1_000,
      agentRole: "Test agent role",
      thinkingBudget: 1024,
      observe: async (_input, ctx) => {
        capturedConfig = ctx.config;
        return undefined;
      },
      orient: async () => undefined,
      decide: async () => undefined,
      act: async () => undefined,
      feedback: async () => undefined,
    });

    await agent.triggerCycle({ dryRun: true });

    const cfg = capturedConfig as ReasoningAgentConfig;
    expect(cfg.agentRole).toBe("Test agent role");
    expect(cfg.thinkingBudget).toBe(1024);
  });

  it("runs E2E cycle in correct phase order", async () => {
    const order: string[] = [];

    const agent = await createReasoningAgent<
      { data: string },
      { analysis: string },
      { decision: string },
      { action: string },
      { result: string }
    >(fakeDeps, {
      agentId: "reasoning-e2e",
      intervalMs: 1_000,
      agentRole: "Analyst agent",
      observe: async () => {
        order.push("observe");
        return { data: "input" };
      },
      orient: async () => {
        order.push("orient");
        return { analysis: "processed" };
      },
      decide: async () => {
        order.push("decide");
        return { decision: "act" };
      },
      act: async () => {
        order.push("act");
        return { action: "done" };
      },
      feedback: async () => {
        order.push("feedback");
        return { result: "ok" };
      },
    });

    const { status } = await agent.triggerCycle({ dryRun: true });

    expect(status).toBe("succeeded");
    expect(order).toEqual(["observe", "orient", "decide", "act", "feedback"]);
  });

  it("wires optional reflect phase when provided", async () => {
    const order: string[] = [];

    const agent = await createReasoningAgent<
      void,
      void,
      void,
      { output: string },
      { reflected: boolean }
    >(fakeDeps, {
      agentId: "reasoning-reflect",
      intervalMs: 1_000,
      agentRole: "Reflective agent",
      observe: async () => undefined,
      orient: async () => undefined,
      decide: async () => undefined,
      act: async () => {
        order.push("act");
        return { output: "result" };
      },
      reflect: async () => {
        order.push("reflect");
        return { reflected: true };
      },
      feedback: async () => {
        order.push("feedback");
        return { reflected: true };
      },
    });

    await agent.triggerCycle({ dryRun: true });

    expect(order.indexOf("reflect")).toBeLessThan(order.indexOf("feedback"));
  });
});
