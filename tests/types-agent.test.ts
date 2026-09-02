/**
 * Tests for shared agent types (Vague 1.B.1).
 *
 * Verifies:
 * - EscalationLevel exhaustiveness
 * - AgentAction shape (no floats for cost)
 * - AgentDependencies structural compatibility
 * - toSdkEscalationLevel mapping correctness
 */

import { describe, expect, test } from "vitest";
import type { AgentAction, AgentDependencies, EscalationLevel } from "../src/types/agent.js";
import { type SdkEscalationLevel, toSdkEscalationLevel } from "../src/types/escalation-mapping.js";

// ─── EscalationLevel ──────────────────────────────────────────────────────────

describe("EscalationLevel", () => {
  const allLevels: EscalationLevel[] = ["L0", "L1", "L2", "L3"];

  test("covers 4 levels", () => {
    expect(allLevels).toHaveLength(4);
  });

  test("all levels are strings", () => {
    for (const level of allLevels) {
      expect(typeof level).toBe("string");
    }
  });
});

// ─── toSdkEscalationLevel ─────────────────────────────────────────────────────

describe("toSdkEscalationLevel", () => {
  test("L0 → L1_autonomous", () => {
    expect(toSdkEscalationLevel("L0")).toBe("L1_autonomous");
  });

  test("L1 → L1_autonomous (audit-logged, still autonomous)", () => {
    expect(toSdkEscalationLevel("L1")).toBe("L1_autonomous");
  });

  test("L2 → L2_async_review", () => {
    expect(toSdkEscalationLevel("L2")).toBe("L2_async_review");
  });

  test("L3 → L3_hitl_required", () => {
    expect(toSdkEscalationLevel("L3")).toBe("L3_hitl_required");
  });

  test("return type is SdkEscalationLevel", () => {
    const result: SdkEscalationLevel = toSdkEscalationLevel("L2");
    expect(result).toBe("L2_async_review");
  });

  test("exhaustive: all 4 levels map without throwing", () => {
    const levels: EscalationLevel[] = ["L0", "L1", "L2", "L3"];
    const validOutputs: SdkEscalationLevel[] = [
      "L1_autonomous",
      "L2_async_review",
      "L3_hitl_required",
    ];
    for (const level of levels) {
      expect(validOutputs).toContain(toSdkEscalationLevel(level));
    }
  });
});

// ─── AgentAction ──────────────────────────────────────────────────────────────

describe("AgentAction", () => {
  test("minimal valid action (no optional fields)", () => {
    const action: AgentAction = {
      type: "post_tweet",
      escalationLevel: "L1",
      reversible: false,
      payload: { text: "Hello" },
    };
    expect(action.type).toBe("post_tweet");
    expect(action.escalationLevel).toBe("L1");
    expect(action.reversible).toBe(false);
    expect(action.payload).toEqual({ text: "Hello" });
  });

  test("action with estimatedCostCents (integer centimes)", () => {
    const action: AgentAction = {
      type: "record_outcome",
      escalationLevel: "L0",
      reversible: true,
      estimatedCostCents: 100, // 1 EUR in centimes
      payload: { outcome: "conversion" },
    };
    // Must be integer — verify no float slips through
    expect(Number.isInteger(action.estimatedCostCents)).toBe(true);
    expect(action.estimatedCostCents).toBe(100);
  });

  test("action with L3 escalation requires HITL", () => {
    const action: AgentAction = {
      type: "deploy_contract",
      escalationLevel: "L3",
      reversible: false,
      payload: { contractAddress: "0x123" },
    };
    const sdkLevel = toSdkEscalationLevel(action.escalationLevel);
    expect(sdkLevel).toBe("L3_hitl_required");
  });
});

// ─── AgentDependencies structural test ───────────────────────────────────────

describe("AgentDependencies", () => {
  test("minimal implementation satisfies interface", () => {
    // Build a minimal mock that satisfies the interface at type level.
    // BrainPort requires only archiveKnowledge; optional tiers are omitted.
    const mockDeps: AgentDependencies = {
      brain: {
        archiveKnowledge: async () => null,
      },
      db: {
        query: async () => ({ rows: [] }),
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      redis: null,
      skills: {},
      executionMode: "dry-run",
    };

    expect(mockDeps.executionMode).toBe("dry-run");
    expect(mockDeps.redis).toBeNull();
  });

  test("optional fields can be omitted", () => {
    const deps: AgentDependencies = {
      brain: {} as AgentDependencies["brain"],
      db: {} as AgentDependencies["db"],
      logger: {} as AgentDependencies["logger"],
      redis: null,
      skills: {},
      executionMode: "live",
    };
    expect(deps.litellmUrl).toBeUndefined();
    expect(deps.databaseUrl).toBeUndefined();
    expect(deps.eventBus).toBeUndefined();
  });

  test("optional fields can be provided", () => {
    const deps: AgentDependencies = {
      brain: {} as AgentDependencies["brain"],
      db: {} as AgentDependencies["db"],
      logger: {} as AgentDependencies["logger"],
      redis: null,
      skills: {},
      executionMode: "live",
      litellmUrl: "http://localhost:4000",
      databaseUrl: "postgres://localhost/test",
    };
    expect(deps.litellmUrl).toBe("http://localhost:4000");
    expect(deps.databaseUrl).toBe("postgres://localhost/test");
  });
});
