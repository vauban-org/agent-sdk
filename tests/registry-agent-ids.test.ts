/**
 * Tests for:
 *   agent-sdk/src/registry/agent-ids.ts
 *   agent-sdk/src/registry/agent-capability.ts
 *
 * Coverage:
 *   AGENT_IDS — all 5 archetypes, UUID v5 format, uniqueness, immutability
 *   AGENT_ID_NAMESPACE — valid UUID format
 *   getAgentId — returns correct UUID per archetype, throws on unknown
 *   agentFromId — reverse lookup, round-trips, unknown input
 *   AGENT_KINDS — all expected kinds, readonly tuple
 *   AgentCapabilityCard — structural shape of the interface
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_KINDS,
  type AgentCapabilityCard,
  type AgentKind,
} from "../src/registry/agent-capability.js";
import {
  AGENT_IDS,
  AGENT_ID_NAMESPACE,
  type AgentType,
  agentFromId,
  getAgentId,
} from "../src/registry/agent-ids.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ARCHETYPES: AgentType[] = ["ARCHITECT", "BUILDER", "TESTER", "SCRIBE", "SYNERGY"];

// ─── AGENT_ID_NAMESPACE ───────────────────────────────────────────────────────

describe("AGENT_ID_NAMESPACE", () => {
  it("is a valid UUID format", () => {
    expect(AGENT_ID_NAMESPACE).toMatch(UUID_RE);
  });

  it("is 36 characters long", () => {
    expect(AGENT_ID_NAMESPACE).toHaveLength(36);
  });
});

// ─── AGENT_IDS ────────────────────────────────────────────────────────────────

describe("AGENT_IDS", () => {
  it("has all 5 archetypes: ARCHITECT, BUILDER, TESTER, SCRIBE, SYNERGY", () => {
    expect(Object.keys(AGENT_IDS)).toHaveLength(5);
    for (const a of ARCHETYPES) {
      expect(AGENT_IDS).toHaveProperty(a);
    }
  });

  it("all UUIDs are valid UUID format (8-4-4-4-12 hex)", () => {
    for (const id of Object.values(AGENT_IDS)) {
      expect(id).toMatch(UUID_RE);
    }
  });

  it("all UUIDs are exactly 36 characters", () => {
    for (const id of Object.values(AGENT_IDS)) {
      expect(id).toHaveLength(36);
    }
  });

  it("all UUIDs are unique (no duplicates)", () => {
    const ids = Object.values(AGENT_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is frozen (immutable — Object.isFrozen)", () => {
    expect(Object.isFrozen(AGENT_IDS)).toBe(true);
  });

  it("ARCHITECT UUID is stable", () => {
    expect(AGENT_IDS.ARCHITECT).toBe("449287f0-db80-5f95-baf7-31a7e52adac6");
  });

  it("BUILDER UUID is stable", () => {
    expect(AGENT_IDS.BUILDER).toBe("4c85dcf3-a4a9-5f8d-9b6d-b1275b799656");
  });

  it("TESTER UUID is stable", () => {
    expect(AGENT_IDS.TESTER).toBe("bae97868-daa2-56f7-9a64-23791f62110d");
  });

  it("SCRIBE UUID is stable", () => {
    expect(AGENT_IDS.SCRIBE).toBe("c371feea-bf3c-506d-92ef-f4cbf4d652f9");
  });

  it("SYNERGY UUID is stable", () => {
    expect(AGENT_IDS.SYNERGY).toBe("3362a6cf-b69a-5c52-ba44-3561a4b4563c");
  });
});

// ─── getAgentId ───────────────────────────────────────────────────────────────

describe("getAgentId", () => {
  it("ARCHITECT returns AGENT_IDS.ARCHITECT", () => {
    expect(getAgentId("ARCHITECT")).toBe(AGENT_IDS.ARCHITECT);
  });

  it("BUILDER returns AGENT_IDS.BUILDER", () => {
    expect(getAgentId("BUILDER")).toBe(AGENT_IDS.BUILDER);
  });

  it("TESTER returns AGENT_IDS.TESTER", () => {
    expect(getAgentId("TESTER")).toBe(AGENT_IDS.TESTER);
  });

  it("SCRIBE returns AGENT_IDS.SCRIBE", () => {
    expect(getAgentId("SCRIBE")).toBe(AGENT_IDS.SCRIBE);
  });

  it("SYNERGY returns AGENT_IDS.SYNERGY", () => {
    expect(getAgentId("SYNERGY")).toBe(AGENT_IDS.SYNERGY);
  });

  it("throws on unknown archetype string", () => {
    expect(() => getAgentId("UNKNOWN" as AgentType)).toThrow("Unknown agent archetype");
  });

  it("throws on empty string", () => {
    expect(() => getAgentId("" as AgentType)).toThrow();
  });
});

// ─── agentFromId ──────────────────────────────────────────────────────────────

describe("agentFromId", () => {
  it("round-trips ARCHITECT", () => {
    expect(agentFromId(AGENT_IDS.ARCHITECT)).toBe("ARCHITECT");
  });

  it("round-trips BUILDER", () => {
    expect(agentFromId(AGENT_IDS.BUILDER)).toBe("BUILDER");
  });

  it("round-trips TESTER", () => {
    expect(agentFromId(AGENT_IDS.TESTER)).toBe("TESTER");
  });

  it("round-trips SCRIBE", () => {
    expect(agentFromId(AGENT_IDS.SCRIBE)).toBe("SCRIBE");
  });

  it("round-trips SYNERGY", () => {
    expect(agentFromId(AGENT_IDS.SYNERGY)).toBe("SYNERGY");
  });

  it("returns undefined for unknown UUID", () => {
    expect(agentFromId("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(agentFromId("")).toBeUndefined();
  });

  it("returns undefined for a well-formed but non-registered UUID", () => {
    expect(agentFromId("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeUndefined();
  });

  it("all archetypes round-trip via getAgentId then agentFromId", () => {
    for (const a of ARCHETYPES) {
      expect(agentFromId(getAgentId(a))).toBe(a);
    }
  });
});

// ─── AGENT_KINDS ──────────────────────────────────────────────────────────────

describe("AGENT_KINDS", () => {
  it("has at least 5 entries", () => {
    expect(AGENT_KINDS.length).toBeGreaterThanOrEqual(5);
  });

  it("includes ARCHITECT", () => {
    expect(AGENT_KINDS).toContain("ARCHITECT");
  });

  it("includes BUILDER", () => {
    expect(AGENT_KINDS).toContain("BUILDER");
  });

  it("includes TESTER", () => {
    expect(AGENT_KINDS).toContain("TESTER");
  });

  it("includes SCRIBE", () => {
    expect(AGENT_KINDS).toContain("SCRIBE");
  });

  it("includes SYNERGY", () => {
    expect(AGENT_KINDS).toContain("SYNERGY");
  });

  it("includes OODA", () => {
    expect(AGENT_KINDS).toContain("OODA");
  });

  it("includes LLM_ROUTER", () => {
    expect(AGENT_KINDS).toContain("LLM_ROUTER");
  });

  it("includes PLUGIN", () => {
    expect(AGENT_KINDS).toContain("PLUGIN");
  });

  it("includes MCP", () => {
    expect(AGENT_KINDS).toContain("MCP");
  });

  it("all entries are non-empty strings", () => {
    for (const kind of AGENT_KINDS) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
    }
  });

  it("all entries are uppercase strings (convention)", () => {
    for (const kind of AGENT_KINDS) {
      expect(kind).toBe(kind.toUpperCase());
    }
  });
});

// ─── AgentCapabilityCard structural shape ─────────────────────────────────────

describe("AgentCapabilityCard", () => {
  it("can construct a minimal valid card (structural type check)", () => {
    const card: AgentCapabilityCard = {
      agentId: AGENT_IDS.ARCHITECT,
      kind: "ARCHITECT",
      skills: ["cairo", "architecture"],
      costTier: "high",
      latencyTier: "high",
      createdAt: Date.now(),
    };
    expect(card.agentId).toBe(AGENT_IDS.ARCHITECT);
    expect(card.kind).toBe("ARCHITECT");
  });

  it("agentId field accepts a UUID string", () => {
    const card: AgentCapabilityCard = {
      agentId: AGENT_IDS.BUILDER,
      kind: "BUILDER",
      skills: [],
      costTier: "low",
      latencyTier: "low",
      createdAt: 0,
    };
    expect(typeof card.agentId).toBe("string");
  });

  it("kind must be one of AGENT_KINDS values", () => {
    const card: AgentCapabilityCard = {
      agentId: "test-id",
      kind: "OODA",
      skills: [],
      costTier: "medium",
      latencyTier: "medium",
      createdAt: 1000,
    };
    const kindIsValid: boolean = (AGENT_KINDS as readonly string[]).includes(card.kind);
    expect(kindIsValid).toBe(true);
  });

  it("skills is a readonly array of strings", () => {
    const card: AgentCapabilityCard = {
      agentId: "x",
      kind: "LLM_ROUTER",
      skills: ["routing", "llm"],
      costTier: "low",
      latencyTier: "low",
      createdAt: 0,
    };
    expect(Array.isArray(card.skills)).toBe(true);
    for (const s of card.skills) {
      expect(typeof s).toBe("string");
    }
  });

  it("costTier accepts 'low' | 'medium' | 'high'", () => {
    const tiers = ["low", "medium", "high"] as const;
    for (const tier of tiers) {
      const card: AgentCapabilityCard = {
        agentId: "x",
        kind: "PLUGIN",
        skills: [],
        costTier: tier,
        latencyTier: "low",
        createdAt: 0,
      };
      expect(card.costTier).toBe(tier);
    }
  });

  it("latencyTier accepts 'low' | 'medium' | 'high'", () => {
    const tiers = ["low", "medium", "high"] as const;
    for (const tier of tiers) {
      const card: AgentCapabilityCard = {
        agentId: "x",
        kind: "MCP",
        skills: [],
        costTier: "low",
        latencyTier: tier,
        createdAt: 0,
      };
      expect(card.latencyTier).toBe(tier);
    }
  });

  it("embeddingVector is optional", () => {
    const cardWithoutEmbed: AgentCapabilityCard = {
      agentId: "x",
      kind: "SYNERGY",
      skills: [],
      costTier: "medium",
      latencyTier: "medium",
      createdAt: 0,
    };
    expect(cardWithoutEmbed.embeddingVector).toBeUndefined();

    const cardWithEmbed: AgentCapabilityCard = {
      agentId: "x",
      kind: "SYNERGY",
      skills: [],
      costTier: "medium",
      latencyTier: "medium",
      createdAt: 0,
      embeddingVector: [0.1, 0.2, 0.3],
    };
    expect(cardWithEmbed.embeddingVector).toHaveLength(3);
  });

  it("createdAt is a number (Unix epoch ms)", () => {
    const now = Date.now();
    const card: AgentCapabilityCard = {
      agentId: "x",
      kind: "TESTER",
      skills: [],
      costTier: "low",
      latencyTier: "low",
      createdAt: now,
    };
    expect(typeof card.createdAt).toBe("number");
    expect(card.createdAt).toBe(now);
  });

  it("AgentKind type is constrained to AGENT_KINDS entries", () => {
    const validKind: AgentKind = "ARCHITECT";
    expect((AGENT_KINDS as readonly string[]).includes(validKind)).toBe(true);
  });
});
