/**
 * tests/constitution-scorer.test.ts
 *
 * Unit tests for the constitutional scorer module.
 * Each built-in scorer is tested with a high-score fixture and a low-score fixture.
 * ScorerRegistry custom registration is also covered.
 */

import { describe, expect, it } from "vitest";
import {
  ScorerRegistry,
  antiFragileScorer,
  defaultScorerRegistry,
  institutionnelScorer,
  profitableScorer,
  robusteScorer,
  sotaScorer,
} from "../src/constitution/scorer.js";
import type { CycleSnapshot } from "../src/constitution/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function highScoreCycle(): CycleSnapshot {
  return {
    runId: "run-high",
    steps: [
      {
        index: 0,
        phase: "decide",
        type: "llm_call",
        output: "clean output",
        model: { provider: "anthropic", name: "claude-3-5-sonnet-20241022", version: "latest" },
        costUsd: 0.003,
      },
    ],
    budgetUsdMax: 1.0,
    budgetUsdSpent: 0.003,
    scope_id: "scope-alpha",
    rootHash: "a".repeat(64),
    metadata: {
      rso_veto: false,
      pii_redacted: true,
      timeouts_configured: true,
      error_paths_explicit: true,
      has_fallback: true,
      is_idempotent: true,
      source_count: 3,
      slsa_level: 3,
      hash_primitive: "poseidon",
    },
  };
}

function lowScoreCycle(): CycleSnapshot {
  return {
    runId: "run-low",
    steps: [
      {
        index: 0,
        phase: "act",
        type: "tool_call",
        output: "api_key=sk-leaked123 password=hunter2",
        model: { provider: "openai", name: "gpt-3.5-turbo", version: "0301" },
        costUsd: 0,
      },
    ],
    budgetUsdMax: 0.5,
    budgetUsdSpent: 0.9, // overrun
    rootHash: "short",
    metadata: {
      rso_veto: true,
      pii_redacted: false,
      timeouts_configured: false,
      error_paths_explicit: false,
      has_fallback: false,
      is_idempotent: false,
      source_count: 1,
      slsa_level: 1,
      hash_primitive: "md5",
    },
  };
}

// ---------------------------------------------------------------------------
// institutionnelScorer
// ---------------------------------------------------------------------------

describe("institutionnelScorer", () => {
  it("returns score >= 0.6 for compliant cycle", async () => {
    const { score } = await institutionnelScorer(highScoreCycle());
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("returns score <= 0.4 for non-compliant cycle", async () => {
    const { score } = await institutionnelScorer(lowScoreCycle());
    expect(score).toBeLessThanOrEqual(0.4);
  });

  it("returns rationale string containing axiom id", async () => {
    const { rationale } = await institutionnelScorer(highScoreCycle());
    expect(rationale).toContain("Institutionnel");
  });
});

// ---------------------------------------------------------------------------
// sotaScorer
// ---------------------------------------------------------------------------

describe("sotaScorer", () => {
  it("returns score >= 0.6 for SOTA-compliant cycle", async () => {
    const { score } = await sotaScorer(highScoreCycle());
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("returns score <= 0.4 for outdated-tech cycle", async () => {
    const { score } = await sotaScorer(lowScoreCycle());
    expect(score).toBeLessThanOrEqual(0.4);
  });
});

// ---------------------------------------------------------------------------
// robusteScorer
// ---------------------------------------------------------------------------

describe("robusteScorer", () => {
  it("returns score >= 0.6 for robust cycle", async () => {
    const { score } = await robusteScorer(highScoreCycle());
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("returns score <= 0.4 for fragile cycle", async () => {
    const { score } = await robusteScorer(lowScoreCycle());
    expect(score).toBeLessThanOrEqual(0.4);
  });
});

// ---------------------------------------------------------------------------
// antiFragileScorer
// ---------------------------------------------------------------------------

describe("antiFragileScorer", () => {
  it("returns score >= 0.6 for resilient cycle", async () => {
    const { score } = await antiFragileScorer(highScoreCycle());
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("returns score <= 0.4 for fragile cycle", async () => {
    const { score } = await antiFragileScorer(lowScoreCycle());
    expect(score).toBeLessThanOrEqual(0.4);
  });
});

// ---------------------------------------------------------------------------
// profitableScorer
// ---------------------------------------------------------------------------

describe("profitableScorer", () => {
  it("returns score >= 0.6 for on-budget cycle", async () => {
    const { score } = await profitableScorer(highScoreCycle());
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("returns score <= 0.4 for overbudget cycle", async () => {
    const { score } = await profitableScorer(lowScoreCycle());
    expect(score).toBeLessThanOrEqual(0.4);
  });
});

// ---------------------------------------------------------------------------
// ScorerRegistry
// ---------------------------------------------------------------------------

describe("ScorerRegistry", () => {
  it("has all 5 built-in scorers pre-registered", () => {
    const registry = new ScorerRegistry();
    expect(registry.list()).toContain("Institutionnel");
    expect(registry.list()).toContain("SOTA");
    expect(registry.list()).toContain("Robuste");
    expect(registry.list()).toContain("AntiFragile");
    expect(registry.list()).toContain("Profitable");
  });

  it("allows custom scorer registration", async () => {
    const registry = new ScorerRegistry();
    registry.register("Custom", async (_cycle) => ({
      score: 0.99,
      rationale: "custom scorer always passes",
      signals: [],
    }));
    const customScorer = registry.get("Custom");
    expect(customScorer).toBeDefined();
    const result = await customScorer!(highScoreCycle());
    expect(result.score).toBe(0.99);
  });

  it("scoreAll returns results for all axioms", async () => {
    const results = await defaultScorerRegistry.scoreAll(highScoreCycle());
    expect(results.size).toBe(5);
    for (const [, result] of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("allows overriding a built-in scorer", async () => {
    const registry = new ScorerRegistry();
    registry.register("SOTA", async (_cycle) => ({
      score: 0.42,
      rationale: "override",
      signals: [],
    }));
    const scorer = registry.get("SOTA")!;
    const { score } = await scorer(highScoreCycle());
    expect(score).toBe(0.42);
  });
});
