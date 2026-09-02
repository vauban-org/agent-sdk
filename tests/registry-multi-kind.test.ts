/**
 * registry-multi-kind.test.ts — TDD for AgentCapabilityCard registration + discovery.
 *
 * Sprint-580 / registry-multi-kind
 * Checkpoint 4: register + discover
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentCapabilityCard } from "../src/registry/agent-capability.js";
import { AGENT_KINDS } from "../src/registry/agent-capability.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";

// ─── Fixture factory ──────────────────────────────────────────────────────────

function makeCard(
  overrides: Partial<AgentCapabilityCard> & Pick<AgentCapabilityCard, "agentId" | "kind">,
): AgentCapabilityCard {
  return {
    skills: [],
    costTier: "medium",
    latencyTier: "medium",
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AgentRegistry — multi-kind capability", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  // ── AGENT_KINDS enum ────────────────────────────────────────────────────────

  it("AGENT_KINDS exposes all 9 expected kinds", () => {
    const expected = [
      "ARCHITECT",
      "BUILDER",
      "SCRIBE",
      "TESTER",
      "SYNERGY",
      "OODA",
      "LLM_ROUTER",
      "PLUGIN",
      "MCP",
    ] as const;
    expect([...AGENT_KINDS].sort()).toEqual([...expected].sort());
  });

  // ── registerCapability + discoverByKind ─────────────────────────────────────

  it("register a card → discoverByKind returns it", () => {
    const card = makeCard({ agentId: "builder-01", kind: "BUILDER" });
    registry.registerCapability(card);

    const found = registry.discoverByKind("BUILDER");
    expect(found).toHaveLength(1);
    expect(found[0]?.agentId).toBe("builder-01");
    expect(found[0]?.kind).toBe("BUILDER");
  });

  it("multiple kinds coexist; discoverByKind filters correctly", () => {
    registry.registerCapability(makeCard({ agentId: "arch-01", kind: "ARCHITECT" }));
    registry.registerCapability(makeCard({ agentId: "build-01", kind: "BUILDER" }));
    registry.registerCapability(makeCard({ agentId: "build-02", kind: "BUILDER" }));
    registry.registerCapability(makeCard({ agentId: "scribe-01", kind: "SCRIBE" }));

    expect(registry.discoverByKind("ARCHITECT")).toHaveLength(1);
    expect(registry.discoverByKind("BUILDER")).toHaveLength(2);
    expect(registry.discoverByKind("SCRIBE")).toHaveLength(1);
    expect(registry.discoverByKind("TESTER")).toHaveLength(0);
  });

  it("discoverByKind returns empty array when no cards of that kind are registered", () => {
    registry.registerCapability(makeCard({ agentId: "ooda-01", kind: "OODA" }));
    expect(registry.discoverByKind("LLM_ROUTER")).toEqual([]);
  });

  // ── re-register upsert ───────────────────────────────────────────────────────

  it("re-register same agentId upserts (replaces) the card", () => {
    const v1 = makeCard({ agentId: "tester-01", kind: "TESTER", costTier: "low" });
    const v2 = makeCard({ agentId: "tester-01", kind: "TESTER", costTier: "high" });

    registry.registerCapability(v1);
    registry.registerCapability(v2);

    const found = registry.discoverByKind("TESTER");
    expect(found).toHaveLength(1);
    expect(found[0]?.costTier).toBe("high");
  });

  it("upsert preserves kind; re-register with different kind replaces card", () => {
    registry.registerCapability(makeCard({ agentId: "agent-x", kind: "PLUGIN" }));
    registry.registerCapability(makeCard({ agentId: "agent-x", kind: "MCP" }));

    expect(registry.discoverByKind("PLUGIN")).toHaveLength(0);
    expect(registry.discoverByKind("MCP")).toHaveLength(1);
  });

  // ── discoverBySkills ─────────────────────────────────────────────────────────

  it("discoverBySkills matchAll:false — returns cards matching ANY skill (default)", () => {
    registry.registerCapability(
      makeCard({ agentId: "a1", kind: "BUILDER", skills: ["typescript", "node"] }),
    );
    registry.registerCapability(
      makeCard({ agentId: "a2", kind: "BUILDER", skills: ["python", "sql"] }),
    );
    registry.registerCapability(
      makeCard({ agentId: "a3", kind: "SCRIBE", skills: ["docs", "markdown"] }),
    );

    const found = registry.discoverBySkills(["typescript", "sql"]);
    const ids = found.map((c) => c.agentId).sort();
    expect(ids).toEqual(["a1", "a2"]);
  });

  it("discoverBySkills matchAll:true — requires ALL skills present", () => {
    registry.registerCapability(
      makeCard({ agentId: "b1", kind: "ARCHITECT", skills: ["zk", "cairo", "starknet"] }),
    );
    registry.registerCapability(
      makeCard({ agentId: "b2", kind: "ARCHITECT", skills: ["zk", "solidity"] }),
    );

    const allMatch = registry.discoverBySkills(["zk", "cairo"], { matchAll: true });
    expect(allMatch).toHaveLength(1);
    expect(allMatch[0]?.agentId).toBe("b1");

    const anyMatch = registry.discoverBySkills(["zk", "cairo"], { matchAll: false });
    expect(anyMatch).toHaveLength(2);
  });

  it("discoverBySkills with kind filter restricts results", () => {
    registry.registerCapability(
      makeCard({ agentId: "c1", kind: "BUILDER", skills: ["typescript"] }),
    );
    registry.registerCapability(
      makeCard({ agentId: "c2", kind: "TESTER", skills: ["typescript"] }),
    );

    const builderOnly = registry.discoverBySkills(["typescript"], { kind: "BUILDER" });
    expect(builderOnly).toHaveLength(1);
    expect(builderOnly[0]?.agentId).toBe("c1");
  });

  it("discoverBySkills returns empty array when no skill matches", () => {
    registry.registerCapability(
      makeCard({ agentId: "d1", kind: "SYNERGY", skills: ["orchestration"] }),
    );
    expect(registry.discoverBySkills(["nonexistent"])).toEqual([]);
  });

  it("discoverBySkills matchAll:true with empty skills array matches all cards", () => {
    registry.registerCapability(makeCard({ agentId: "e1", kind: "MCP", skills: ["mcp-tool"] }));
    // Every card trivially satisfies "every [] element" (vacuous truth)
    const found = registry.discoverBySkills([], { matchAll: true });
    expect(found).toHaveLength(1);
  });

  // ── Return-value immutability ────────────────────────────────────────────────

  it("mutating a returned card does not affect registry state", () => {
    const card = makeCard({ agentId: "f1", kind: "OODA", costTier: "low" });
    registry.registerCapability(card);

    const [returned] = registry.discoverByKind("OODA");
    // Casting to bypass readonly for mutation test
    (returned as { costTier: string }).costTier = "high";

    const [fresh] = registry.discoverByKind("OODA");
    expect(fresh?.costTier).toBe("low");
  });

  // ── Existing AgentRegistry API is untouched ───────────────────────────────────

  it("existing register/get/list/size/unregister API still works alongside capability API", () => {
    const desc = {
      id: "legacy-agent",
      version: "1.0.0",
      loop: "minimal" as const,
      budget_monthly_usd: 5,
      description: "legacy",
      handler: async () => ({
        output: "",
        stopReason: "complete" as const,
        inputTokens: 0,
        outputTokens: 0,
      }),
    };

    registry.register(desc);
    expect(registry.size).toBe(1);
    expect(registry.get("legacy-agent")?.id).toBe("legacy-agent");

    registry.registerCapability(makeCard({ agentId: "legacy-agent", kind: "BUILDER" }));
    expect(registry.discoverByKind("BUILDER")).toHaveLength(1);

    const removed = registry.unregister("legacy-agent");
    expect(removed).toBe(true);
    // Capability store is independent — should still exist
    expect(registry.discoverByKind("BUILDER")).toHaveLength(1);
  });
});
