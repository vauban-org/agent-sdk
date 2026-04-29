/**
 * Unit tests — Skill Ledger resolver (SDK v0.8.0 — sprint-530:quick-4)
 *
 * Tests cover:
 *   - LIFO ordering (most recent first)
 *   - agent_id exact match
 *   - '*' cross-agent wildcard inclusion
 *   - outcome_type filter
 *   - lifecycle_state filter (only 'active')
 *   - limit option
 *   - empty input → empty output
 *   - no mutation of input array
 */
import { describe, expect, it } from "vitest";
import {
  resolveSkillsForAgent,
  type SkillLedgerEntry,
} from "../src/skills/skill-ledger.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeSkill(
  overrides: Partial<SkillLedgerEntry> & { id: string },
): SkillLedgerEntry {
  return {
    skill_name: "test_skill",
    skill_sha256: "abc123",
    source_run_ids: [],
    agent_id: "forecaster",
    outcome_type: "trade_signal",
    brain_entry_id: "brain-entry-1",
    metrics: {},
    lifecycle_state: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const SKILL_A = makeSkill({
  id: "a",
  agent_id: "forecaster",
  outcome_type: "trade_signal",
  lifecycle_state: "active",
  created_at: "2026-01-01T00:00:00.000Z",
});

const SKILL_B = makeSkill({
  id: "b",
  agent_id: "forecaster",
  outcome_type: "trade_signal",
  lifecycle_state: "active",
  created_at: "2026-01-03T00:00:00.000Z", // newer
});

const SKILL_C = makeSkill({
  id: "c",
  agent_id: "*",
  outcome_type: "trade_signal",
  lifecycle_state: "active",
  created_at: "2026-01-02T00:00:00.000Z",
});

const SKILL_D = makeSkill({
  id: "d",
  agent_id: "forecaster",
  outcome_type: "risk_report", // different outcome
  lifecycle_state: "active",
  created_at: "2026-01-05T00:00:00.000Z",
});

const SKILL_E = makeSkill({
  id: "e",
  agent_id: "forecaster",
  outcome_type: "trade_signal",
  lifecycle_state: "archived", // not active
  created_at: "2026-01-10T00:00:00.000Z",
});

const SKILL_F = makeSkill({
  id: "f",
  agent_id: "narrator",
  outcome_type: "trade_signal",
  lifecycle_state: "active",
  created_at: "2026-01-04T00:00:00.000Z",
});

const ALL = [SKILL_A, SKILL_B, SKILL_C, SKILL_D, SKILL_E, SKILL_F];

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveSkillsForAgent", () => {
  describe("empty inputs", () => {
    it("returns empty array when skills is empty", () => {
      const result = resolveSkillsForAgent([], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      expect(result).toEqual([]);
    });

    it("returns empty array when no skills match filters", () => {
      const result = resolveSkillsForAgent(ALL, {
        agentId: "forecaster",
        outcomeType: "unknown_type",
      });
      expect(result).toEqual([]);
    });
  });

  describe("agent_id filter", () => {
    it("includes exact agent_id match", () => {
      const result = resolveSkillsForAgent([SKILL_A, SKILL_F], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      const ids = result.map((s) => s.id);
      expect(ids).toContain("a");
      expect(ids).not.toContain("f");
    });

    it("includes '*' cross-agent wildcard entries", () => {
      const result = resolveSkillsForAgent([SKILL_A, SKILL_C], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      const ids = result.map((s) => s.id);
      expect(ids).toContain("a");
      expect(ids).toContain("c");
    });

    it("excludes entries for a different agent", () => {
      const result = resolveSkillsForAgent(ALL, {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      const ids = result.map((s) => s.id);
      expect(ids).not.toContain("f"); // narrator
    });

    it("'*' agent resolves cross-agent skills for any agentId", () => {
      const result = resolveSkillsForAgent([SKILL_C], {
        agentId: "narrator",
        outcomeType: "trade_signal",
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("c");
    });
  });

  describe("outcome_type filter", () => {
    it("excludes skills with different outcome_type", () => {
      const result = resolveSkillsForAgent(ALL, {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      const ids = result.map((s) => s.id);
      expect(ids).not.toContain("d"); // risk_report
    });

    it("returns skills for risk_report when requested", () => {
      const result = resolveSkillsForAgent(ALL, {
        agentId: "forecaster",
        outcomeType: "risk_report",
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("d");
    });
  });

  describe("lifecycle_state filter", () => {
    it("excludes archived skills", () => {
      const result = resolveSkillsForAgent(ALL, {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      const ids = result.map((s) => s.id);
      expect(ids).not.toContain("e"); // archived
    });

    it("does not include deprecated skills", () => {
      const deprecated = makeSkill({
        id: "g",
        agent_id: "forecaster",
        outcome_type: "trade_signal",
        lifecycle_state: "deprecated",
        created_at: "2026-02-01T00:00:00.000Z",
      });
      const result = resolveSkillsForAgent([deprecated], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      expect(result).toHaveLength(0);
    });
  });

  describe("LIFO ordering", () => {
    it("returns most recently created skill first", () => {
      const result = resolveSkillsForAgent([SKILL_A, SKILL_B, SKILL_C], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      // B: 2026-01-03, C: 2026-01-02, A: 2026-01-01
      expect(result[0].id).toBe("b");
      expect(result[1].id).toBe("c");
      expect(result[2].id).toBe("a");
    });

    it("is stable when two skills have the same created_at", () => {
      const s1 = makeSkill({
        id: "x1",
        agent_id: "forecaster",
        outcome_type: "trade_signal",
        lifecycle_state: "active",
        created_at: "2026-01-05T00:00:00.000Z",
      });
      const s2 = makeSkill({
        id: "x2",
        agent_id: "forecaster",
        outcome_type: "trade_signal",
        lifecycle_state: "active",
        created_at: "2026-01-05T00:00:00.000Z",
      });
      const result = resolveSkillsForAgent([s1, s2], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      expect(result).toHaveLength(2);
      // Both present, order is deterministic (not tested — same timestamp)
    });
  });

  describe("limit option", () => {
    it("returns at most limit entries", () => {
      const result = resolveSkillsForAgent([SKILL_A, SKILL_B, SKILL_C], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
        limit: 2,
      });
      expect(result).toHaveLength(2);
    });

    it("returns all entries when limit > count", () => {
      const result = resolveSkillsForAgent([SKILL_A, SKILL_B], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
        limit: 100,
      });
      expect(result).toHaveLength(2);
    });

    it("limit=1 returns only the most recent skill", () => {
      const result = resolveSkillsForAgent([SKILL_A, SKILL_B, SKILL_C], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
        limit: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("b");
    });
  });

  describe("immutability", () => {
    it("does not mutate the input array", () => {
      const input = [SKILL_B, SKILL_A];
      const inputCopy = [...input];
      resolveSkillsForAgent(input, {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      expect(input).toEqual(inputCopy);
    });

    it("does not mutate input object references", () => {
      const skill = { ...SKILL_A };
      const origCreatedAt = skill.created_at;
      resolveSkillsForAgent([skill], {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      expect(skill.created_at).toBe(origCreatedAt);
    });
  });

  describe("full integration: mixed dataset", () => {
    it("returns only matching active skills in LIFO order", () => {
      const result = resolveSkillsForAgent(ALL, {
        agentId: "forecaster",
        outcomeType: "trade_signal",
      });
      // Expected: B (Jan 3), C (Jan 2, cross-agent), A (Jan 1)
      // Excluded: D (wrong outcome), E (archived), F (wrong agent)
      expect(result.map((s) => s.id)).toEqual(["b", "c", "a"]);
    });
  });
});
