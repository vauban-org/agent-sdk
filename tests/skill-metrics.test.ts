/**
 * tests/skill-metrics.test.ts
 *
 * The typed SkillMetrics extension (Wave 2). Confirms the typed fields + the
 * open index signature coexist (non-breaking), and that resolveSkillsForAgent
 * still works with typed-metrics entries.
 */

import { describe, expect, it } from "vitest";
import {
  type SkillLedgerEntry,
  type SkillMetrics,
  canAutoOverwrite,
  resolveSkillsForAgent,
} from "../src/skills/index.js";

describe("SkillMetrics typed extension (Wave 2)", () => {
  it("accepts typed fields + arbitrary keys (non-breaking open index)", () => {
    const metrics: SkillMetrics = {
      execution_count: 3,
      success_rate: 0.8,
      last_verified: "2026-06-01T00:00:00.000Z",
      consistency_score: 0.95,
      creator_model: "claude-sonnet-4-6",
      pinned: true,
      mutationSource: "manual",
      // a domain key still allowed (preserves the prior Record<string,unknown>)
      sharpe_ratio: 1.4,
    };
    expect(metrics.pinned).toBe(true);
    expect(metrics.mutationSource).toBe("manual");
    expect(metrics.sharpe_ratio).toBe(1.4);
  });

  it("resolveSkillsForAgent still resolves typed-metrics entries", () => {
    const entry: SkillLedgerEntry = {
      id: "1",
      skill_name: "s",
      skill_sha256: "h",
      source_run_ids: ["r"],
      agent_id: "a",
      outcome_type: "trade_signal",
      brain_entry_id: "b",
      metrics: { execution_count: 1, custom: "x" },
      lifecycle_state: "active",
      created_at: new Date().toISOString(),
    };
    const out = resolveSkillsForAgent([entry], {
      agentId: "a",
      outcomeType: "trade_signal",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.metrics.execution_count).toBe(1);
  });
});

describe("canAutoOverwrite (Beyond-Hermes W3-T1 pin/manual guard)", () => {
  it("allows overwrite of an unprotected auto-authored skill", () => {
    expect(canAutoOverwrite({ mutationSource: "auto" })).toBe(true);
  });

  it("treats a missing/empty metrics bag as overwritable", () => {
    expect(canAutoOverwrite(undefined)).toBe(true);
    expect(canAutoOverwrite(null)).toBe(true);
    expect(canAutoOverwrite({})).toBe(true);
  });

  it("protects a pinned skill (even if auto-authored)", () => {
    expect(canAutoOverwrite({ pinned: true })).toBe(false);
    expect(canAutoOverwrite({ pinned: true, mutationSource: "auto" })).toBe(false);
  });

  it("protects a manually-edited skill", () => {
    expect(canAutoOverwrite({ mutationSource: "manual" })).toBe(false);
  });

  it("pinned:false does not protect an auto skill", () => {
    expect(canAutoOverwrite({ pinned: false, mutationSource: "auto" })).toBe(true);
  });
});
