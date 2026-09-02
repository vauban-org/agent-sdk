/**
 * Tests for:
 *   agent-sdk/src/registry/agent-ids.ts
 *   agent-sdk/src/orchestration/ooda/guards/always-on.ts
 *   agent-sdk/src/permissions/capability-gate.ts
 *
 * Coverage:
 *   getAgentId — returns UUID for each archetype, throws on unknown
 *   agentFromId — round-trip lookup, returns undefined for unknown UUID
 *   AGENT_IDS — all 5 archetypes present, stable UUIDs (v5 shape)
 *   alwaysOn — name is "always-on", isActive returns true for any date
 *   ALLOW_ALL_GATE — verify() always returns { allowed: true }
 *
 * Ref: test coverage for agent-ids / always-on / capability-gate (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { alwaysOn } from "../src/orchestration/ooda/guards/always-on.js";
import { ALLOW_ALL_GATE } from "../src/permissions/capability-gate.js";
import { AGENT_IDS, type AgentType, agentFromId, getAgentId } from "../src/registry/agent-ids.js";

// ─── AGENT_IDS + getAgentId ───────────────────────────────────────────────────

const ARCHETYPES: AgentType[] = ["ARCHITECT", "BUILDER", "TESTER", "SCRIBE", "SYNERGY"];

describe("AGENT_IDS", () => {
  it("has exactly the 5 core archetypes", () => {
    expect(Object.keys(AGENT_IDS)).toHaveLength(5);
    for (const a of ARCHETYPES) {
      expect(AGENT_IDS[a]).toBeDefined();
    }
  });

  it("UUIDs are all v4/v5 format (8-4-4-4-12)", () => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const id of Object.values(AGENT_IDS)) {
      expect(id).toMatch(uuidRe);
    }
  });

  it("UUIDs are all distinct", () => {
    const ids = Object.values(AGENT_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getAgentId", () => {
  it.each(ARCHETYPES)("returns stable UUID for %s", (archetype) => {
    const id = getAgentId(archetype);
    expect(id).toBe(AGENT_IDS[archetype]);
  });

  it("throws for unknown archetype", () => {
    expect(() => getAgentId("UNKNOWN" as AgentType)).toThrow("Unknown agent archetype");
  });
});

// ─── agentFromId ──────────────────────────────────────────────────────────────

describe("agentFromId", () => {
  it.each(ARCHETYPES)("round-trips for %s", (archetype) => {
    const id = AGENT_IDS[archetype];
    expect(agentFromId(id)).toBe(archetype);
  });

  it("returns undefined for unknown UUID", () => {
    expect(agentFromId("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });
});

// ─── alwaysOn ─────────────────────────────────────────────────────────────────

describe("alwaysOn", () => {
  it("name is 'always-on'", () => {
    expect(alwaysOn().name).toBe("always-on");
  });

  it("isActive returns true for any date", async () => {
    const guard = alwaysOn();
    expect(await guard.isActive(new Date())).toBe(true);
    expect(await guard.isActive(new Date(0))).toBe(true);
    expect(await guard.isActive(new Date("2099-12-31"))).toBe(true);
  });
});

// ─── ALLOW_ALL_GATE ───────────────────────────────────────────────────────────

describe("ALLOW_ALL_GATE", () => {
  it("verify returns allowed:true for any tool", () => {
    const result = ALLOW_ALL_GATE.verify({
      toolName: "delete_everything",
      budgetUsed: 999,
    });
    expect(result.allowed).toBe(true);
  });

  it("verify returns allowed:true with empty tool name", () => {
    const result = ALLOW_ALL_GATE.verify({ toolName: "", budgetUsed: 0 });
    expect(result.allowed).toBe(true);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(ALLOW_ALL_GATE)).toBe(true);
  });
});
