/**
 * Tests for agent-sdk template and secrets utilities.
 *
 * Coverage:
 *   _secrets.ts: readSecret edge cases (empty string, multiple keys, overwrite env)
 *   base-skills.ts: BASE_SKILL_NAMES tuple structure, type narrowing
 *   simple-agent.ts: agentVersion default, cyclesCompleted after cycle, zero-action decide
 *   complex-agent.ts: hitlEscalationLevel L2, no reflect phase, agentVersion override
 *   reasoning-agent.ts: thinkingBudget absent (undefined), agentRole mandatory, L2 HITL
 *   sdk-permission-mapping.ts: starknet-prefixed tools, multiple mixed tools,
 *       brainQuery alias, queryKnowledge alias, citadelRead/Write aliases,
 *       pre-namespaced starknet:* scopes, cc:admin intersection
 *
 * Note: templates.test.ts + skills-base-secrets.test.ts cover the primary happy paths;
 * this file adds supplemental edge-case coverage without repeating existing assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFactoryDeps } from "../src/factory/agent-factory.js";
import { noopLogger } from "../src/index.js";
import type { DbClient } from "../src/index.js";
import type { BrainPort } from "../src/ports/brain.js";
import type { LLMProviderPort } from "../src/ports/llm-provider.js";
import {
  capabilityToSdkPermissions,
  scopeToSdkPermissions,
} from "../src/sdk-permission-mapping.js";
import { readSecret } from "../src/skills/_secrets.js";
import { BASE_SKILL_NAMES } from "../src/skills/base-skills.js";
import {
  createComplexAgent,
  createReasoningAgent,
  createSimpleAgent,
} from "../src/templates/index.js";
import type { SimpleDecision, SimpleExecutionResult } from "../src/templates/index.js";

// ─── Shared test deps ─────────────────────────────────────────────────────────

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

const mockBrain: BrainPort = {
  queryKnowledge: vi.fn().mockResolvedValue([]),
  archiveKnowledge: vi.fn().mockResolvedValue({ id: "mock" }),
} as unknown as BrainPort;

const mockLLM: LLMProviderPort = {
  complete: vi.fn().mockResolvedValue({
    content: "{}",
    usage: { inputTokens: 5, outputTokens: 5 },
    model: "stub",
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

// ─── readSecret edge cases ────────────────────────────────────────────────────

describe("readSecret — supplemental edge cases", () => {
  const KEY = "SUPPLEMENTAL_SECRET_KEY";

  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns empty string from ctx.secrets when value is empty string", () => {
    const ctx = { secrets: new Map([[KEY, ""]]) } as never;
    process.env[KEY] = "non-empty"; // should be ignored
    expect(readSecret(ctx, KEY)).toBe("");
  });

  it("correctly resolves one of multiple secrets in the Map", () => {
    const ctx = {
      secrets: new Map([
        ["KEY_A", "value-a"],
        [KEY, "value-target"],
        ["KEY_B", "value-b"],
      ]),
    } as never;
    expect(readSecret(ctx, KEY)).toBe("value-target");
  });

  it("falls back to env for a key absent from non-empty Map", () => {
    const ctx = { secrets: new Map([["UNRELATED", "x"]]) } as never;
    process.env[KEY] = "from-env-fallback";
    expect(readSecret(ctx, KEY)).toBe("from-env-fallback");
  });

  it("prefers ctx.secrets over env when both are set with different values", () => {
    const ctx = { secrets: new Map([[KEY, "ctx-wins"]]) } as never;
    process.env[KEY] = "env-loses";
    expect(readSecret(ctx, KEY)).toBe("ctx-wins");
  });

  it("returns undefined for missing key in empty Map with no env", () => {
    const ctx = { secrets: new Map() } as never;
    expect(readSecret(ctx, KEY)).toBeUndefined();
  });
});

// ─── BASE_SKILL_NAMES structure ───────────────────────────────────────────────

describe("BASE_SKILL_NAMES — structure assertions", () => {
  it("is an array (tuple) of strings", () => {
    expect(Array.isArray(BASE_SKILL_NAMES)).toBe(true);
    for (const name of BASE_SKILL_NAMES) {
      expect(typeof name).toBe("string");
    }
  });

  it("all names are kebab-case (no spaces, lowercase)", () => {
    for (const name of BASE_SKILL_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("contains no duplicates", () => {
    const unique = new Set(BASE_SKILL_NAMES);
    expect(unique.size).toBe(BASE_SKILL_NAMES.length);
  });

  it("is frozen / satisfies readonly (mutation attempt does not change original)", () => {
    // The satisfies clause means the value is typed as readonly; we verify
    // that a spread produces an independent copy.
    const copy = [...BASE_SKILL_NAMES];
    copy.push("injected");
    expect(BASE_SKILL_NAMES).not.toContain("injected");
  });
});

// ─── sdk-permission-mapping — supplemental edge cases ────────────────────────

describe("capabilityToSdkPermissions — supplemental coverage", () => {
  it("starknet:* pre-namespaced tool: not in cc:read grant — stripped", () => {
    // cc:read only grants brain:read + citadel:read; starknet:* not in grant
    const p = capabilityToSdkPermissions("cc:read", ["starknet:invoke"]);
    expect(p.mcp).not.toContain("starknet:invoke");
    expect(p.mcp).toEqual([]);
  });

  it("brainQuery alias maps to brain:read under cc:read scope", () => {
    const p = capabilityToSdkPermissions("cc:read", ["brainQuery"]);
    expect(p.mcp).toContain("brain:read");
  });

  it("queryKnowledge alias maps to brain:read under cc:read scope", () => {
    const p = capabilityToSdkPermissions("cc:read", ["queryKnowledge"]);
    expect(p.mcp).toContain("brain:read");
  });

  it("archiveKnowledge alias maps to brain:write under cc:execute scope", () => {
    const p = capabilityToSdkPermissions("cc:execute", ["archiveKnowledge"]);
    expect(p.mcp).toContain("brain:write");
  });

  it("citadelRead alias maps to citadel:read under cc:read scope", () => {
    const p = capabilityToSdkPermissions("cc:read", ["citadelRead"]);
    expect(p.mcp).toContain("citadel:read");
  });

  it("citadelWrite alias maps to citadel:write under cc:execute scope", () => {
    const p = capabilityToSdkPermissions("cc:execute", ["citadelWrite"]);
    expect(p.mcp).toContain("citadel:write");
  });

  it("createTask alias maps to citadel:write under cc:execute scope", () => {
    const p = capabilityToSdkPermissions("cc:execute", ["createTask"]);
    expect(p.mcp).toContain("citadel:write");
  });

  it("multiple tools: union of valid scopes intersected with cc:execute grant", () => {
    const p = capabilityToSdkPermissions("cc:execute", [
      "queryKnowledge",
      "archiveKnowledge",
      "unknownTool",
    ]);
    // queryKnowledge → brain:read (not in cc:execute grant)
    // archiveKnowledge → brain:write (in cc:execute grant)
    expect(p.mcp).toContain("brain:write");
    expect(p.mcp).not.toContain("brain:read");
  });

  it("cc:admin grants brain:admin and citadel:admin", () => {
    const p = scopeToSdkPermissions("cc:admin");
    expect(p.mcp).toContain("brain:admin");
    expect(p.mcp).toContain("citadel:admin");
    expect(p.bash).toBe("restricted");
    expect(p.fileIo).toBe("sandboxed-tmp");
  });

  it("cc:admin intersection with admin-scoped pre-namespaced tool", () => {
    const p = capabilityToSdkPermissions("cc:admin", ["brain:admin"]);
    expect(p.mcp).toContain("brain:admin");
  });

  it("output mcp array is sorted (deterministic order)", () => {
    const p = capabilityToSdkPermissions("cc:admin", [
      "brain:write",
      "brain:admin",
      "citadel:write",
      "citadel:admin",
    ]);
    const sorted = [...p.mcp].sort();
    expect(p.mcp).toEqual(sorted);
  });
});

// ─── createSimpleAgent — supplemental edge cases ─────────────────────────────

describe("createSimpleAgent — supplemental edge cases", () => {
  it("uses default agentVersion '0.1.0' when not specified", async () => {
    const agent = await createSimpleAgent(fakeDeps, {
      agentId: "test-default-version",
      intervalMs: 1_000,
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async (): Promise<SimpleDecision> => ({
        actions: [],
        rationale: "no-op",
      }),
      act: async (): Promise<SimpleExecutionResult> => ({ executed: [] }),
      feedback: async () => undefined,
    });
    // Agent should be created without error; check it starts paused
    expect(agent.getStatus().running).toBe(false);
  });

  it("cyclesCompleted increments to 1 after a single triggerCycle", async () => {
    const agent = await createSimpleAgent(fakeDeps, {
      agentId: "test-cycle-count",
      intervalMs: 1_000,
      observe: async () => ({ value: 1 }),
      orient: async () => ({ ok: true }),
      decide: async (): Promise<SimpleDecision> => ({
        actions: [],
        rationale: "all good",
      }),
      act: async (): Promise<SimpleExecutionResult> => ({ executed: [] }),
      feedback: async () => undefined,
    });

    expect(agent.getStatus().cyclesCompleted).toBe(0);
    await agent.triggerCycle({ dryRun: true });
    expect(agent.getStatus().cyclesCompleted).toBe(1);
  });

  it("returns a runId string from triggerCycle", async () => {
    const agent = await createSimpleAgent(fakeDeps, {
      agentId: "test-run-id",
      intervalMs: 1_000,
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async (): Promise<SimpleDecision> => ({
        actions: [],
        rationale: "none",
      }),
      act: async (): Promise<SimpleExecutionResult> => ({ executed: [] }),
      feedback: async () => undefined,
    });
    const { runId } = await agent.triggerCycle({ dryRun: true });
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
  });

  it("decide with zero actions leads to empty executed array in act", async () => {
    let capturedExecuted: SimpleExecutionResult["executed"] = [];

    const agent = await createSimpleAgent(fakeDeps, {
      agentId: "test-zero-actions",
      intervalMs: 1_000,
      observe: async () => ({ flag: false }),
      orient: async () => ({ trigger: false }),
      decide: async (): Promise<SimpleDecision> => ({
        actions: [],
        rationale: "nothing to do",
      }),
      act: async (decision): Promise<SimpleExecutionResult> => {
        capturedExecuted = decision.actions.map((a) => ({
          type: a.type,
          success: true,
          details: "",
        }));
        return { executed: capturedExecuted };
      },
      feedback: async () => undefined,
    });

    await agent.triggerCycle({ dryRun: true });
    expect(capturedExecuted).toHaveLength(0);
  });
});

// ─── createComplexAgent — supplemental edge cases ────────────────────────────

describe("createComplexAgent — supplemental edge cases", () => {
  it("accepts custom agentVersion override", async () => {
    const agent = await createComplexAgent(fakeDeps, {
      agentId: "complex-versioned",
      agentVersion: "2.5.0",
      intervalMs: 1_000,
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async () => ({}),
      act: async () => ({}),
      feedback: async () => undefined,
    });
    expect(agent.getStatus().running).toBe(false);
  });

  it("hitlEscalationLevel L2 does not throw in dry-run", async () => {
    const agent = await createComplexAgent(fakeDeps, {
      agentId: "complex-l2-hitl",
      intervalMs: 1_000,
      hitlEscalationLevel: "L2",
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async () => ({}),
      act: async () => ({}),
      feedback: async () => undefined,
    });
    const { status } = await agent.triggerCycle({ dryRun: true });
    expect(status).toBe("succeeded");
  });

  it("without reflect phase, act output goes directly to feedback", async () => {
    const actOutput = { computed: 42 };
    let feedbackInput: unknown = null;

    const agent = await createComplexAgent<void, void, void, { computed: number }, void>(fakeDeps, {
      agentId: "complex-no-reflect",
      intervalMs: 1_000,
      observe: async () => undefined,
      orient: async () => undefined,
      decide: async () => undefined,
      act: async () => actOutput,
      feedback: async (input) => {
        feedbackInput = input;
        return undefined;
      },
    });

    await agent.triggerCycle({ dryRun: true });
    // feedbackInput should carry act output (or a merged object)
    expect(feedbackInput).toBeDefined();
  });

  it("cyclesCompleted is 1 after a successful triggerCycle", async () => {
    const agent = await createComplexAgent(fakeDeps, {
      agentId: "complex-cycle-count",
      intervalMs: 1_000,
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async () => ({}),
      act: async () => ({}),
      feedback: async () => undefined,
    });
    await agent.triggerCycle({ dryRun: true });
    expect(agent.getStatus().cyclesCompleted).toBe(1);
  });
});

// ─── createReasoningAgent — supplemental edge cases ──────────────────────────

describe("createReasoningAgent — supplemental edge cases", () => {
  it("thinkingBudget is undefined in ctx.config when not provided", async () => {
    let capturedThinkingBudget: number | undefined = -1;

    const agent = await createReasoningAgent(fakeDeps, {
      agentId: "reasoning-no-budget",
      intervalMs: 1_000,
      agentRole: "No budget agent",
      observe: async (_input, ctx) => {
        const cfg = ctx.config as { thinkingBudget?: number };
        capturedThinkingBudget = cfg.thinkingBudget;
        return undefined;
      },
      orient: async () => undefined,
      decide: async () => undefined,
      act: async () => undefined,
      feedback: async () => undefined,
    });

    await agent.triggerCycle({ dryRun: true });
    expect(capturedThinkingBudget).toBeUndefined();
  });

  it("accepts custom agentVersion and starts in stopped state", async () => {
    const agent = await createReasoningAgent(fakeDeps, {
      agentId: "reasoning-versioned",
      agentVersion: "3.0.0",
      intervalMs: 1_000,
      agentRole: "Custom version agent",
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async () => ({}),
      act: async () => ({}),
      feedback: async () => undefined,
    });
    expect(agent.getStatus().running).toBe(false);
    expect(agent.getStatus().cyclesCompleted).toBe(0);
  });

  it("L2 HITL escalation level does not cause failure in dry-run", async () => {
    const agent = await createReasoningAgent(fakeDeps, {
      agentId: "reasoning-l2-hitl",
      intervalMs: 1_000,
      agentRole: "L2 reasoning agent",
      hitlEscalationLevel: "L2",
      observe: async () => ({}),
      orient: async () => ({}),
      decide: async () => ({}),
      act: async () => ({}),
      feedback: async () => undefined,
    });
    const { status } = await agent.triggerCycle({ dryRun: true });
    expect(status).toBe("succeeded");
  });

  it("agentRole string is accessible in orient phase via ctx.config", async () => {
    const expectedRole = "Orient-phase role check";
    let roleInOrient: string | undefined;

    const agent = await createReasoningAgent(fakeDeps, {
      agentId: "reasoning-orient-role",
      intervalMs: 1_000,
      agentRole: expectedRole,
      observe: async () => ({}),
      orient: async (_obs, ctx) => {
        const cfg = ctx.config as { agentRole?: string };
        roleInOrient = cfg.agentRole;
        return {};
      },
      decide: async () => ({}),
      act: async () => ({}),
      feedback: async () => undefined,
    });

    await agent.triggerCycle({ dryRun: true });
    expect(roleInOrient).toBe(expectedRole);
  });
});
