/**
 * tests/constitution-axioms.test.ts
 *
 * Unit tests for the 5 built-in axiom signal detectors.
 * Each axiom is tested in isolation: high-signal (positive) and low-signal
 * (negative / neutral) fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  ANTI_FRAGILE,
  INSTITUTIONNEL,
  PROFITABLE,
  ROBUSTE,
  SOTA,
} from "../src/constitution/axioms.js";
import type { CycleSnapshot } from "../src/constitution/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid cycle (all positive indicators). */
function goodCycle(overrides: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    runId: "run-001",
    steps: [
      {
        index: 0,
        phase: "decide",
        type: "llm_call",
        output: "The result is 42",
        model: { provider: "anthropic", name: "claude-3-5-sonnet-20241022", version: "latest" },
        costUsd: 0.002,
      },
    ],
    budgetUsdMax: 1.0,
    budgetUsdSpent: 0.002,
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
    ...overrides,
  };
}

/** Minimal cycle with all negative indicators. */
function badCycle(overrides: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    runId: "run-002",
    steps: [],
    budgetUsdMax: 0.5,
    budgetUsdSpent: 0.8, // overrun
    rootHash: "short", // too short
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// INSTITUTIONNEL
// ---------------------------------------------------------------------------

describe("INSTITUTIONNEL axiom", () => {
  it("returns positive weight when audit trail is complete", () => {
    const signals = INSTITUTIONNEL.detect(goodCycle());
    const rootHashSignal = signals.find((s) => s.label === "audit_trail_root_hash");
    expect(rootHashSignal).toBeDefined();
    expect(rootHashSignal!.weight).toBeGreaterThan(0);
  });

  it("returns negative weight when rootHash is short", () => {
    const signals = INSTITUTIONNEL.detect(badCycle());
    const rootHashSignal = signals.find((s) => s.label === "audit_trail_root_hash");
    expect(rootHashSignal).toBeDefined();
    expect(rootHashSignal!.weight).toBeLessThan(0);
  });

  it("returns strong negative weight when RSO veto is set", () => {
    const signals = INSTITUTIONNEL.detect(
      goodCycle({ metadata: { rso_veto: true, pii_redacted: true } }),
    );
    const vetoSignal = signals.find((s) => s.label === "rso_veto_flagged");
    expect(vetoSignal).toBeDefined();
    expect(vetoSignal!.weight).toBeLessThanOrEqual(-1.0);
  });

  it("flags unredacted PII (email pattern)", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "decide",
          type: "llm_call",
          output: "User email: victim@example.com",
        },
      ],
      metadata: { pii_redacted: false },
    });
    const signals = INSTITUTIONNEL.detect(cycle);
    const piiSignal = signals.find((s) => s.label === "pii_unredacted");
    expect(piiSignal).toBeDefined();
    expect(piiSignal!.weight).toBeLessThan(0);
  });

  it("accepts redacted PII (pii_redacted=true)", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "decide",
          type: "llm_call",
          output: "User email: victim@example.com",
        },
      ],
      metadata: { pii_redacted: true },
    });
    const signals = INSTITUTIONNEL.detect(cycle);
    const piiSignal = signals.find((s) => s.label === "pii_redacted");
    expect(piiSignal).toBeDefined();
    expect(piiSignal!.weight).toBeGreaterThan(0);
  });

  // v2 signals
  it("v2: detects French IBAN in step output as PII (unredacted)", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "execute",
          type: "tool_call",
          output: { iban: "FR7630006000011234567890189" },
        },
      ],
      metadata: { pii_redacted: false },
    });
    const signals = INSTITUTIONNEL.detect(cycle);
    const piiSignal = signals.find((s) => s.label === "pii_unredacted");
    expect(piiSignal).toBeDefined();
    expect(piiSignal!.weight).toBeLessThanOrEqual(-0.8);
  });

  it("v2: detects French NIR pattern in step output as PII (unredacted)", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "execute",
          type: "tool_call",
          output: { nir: "185127510811145" },
        },
      ],
      metadata: { pii_redacted: false },
    });
    const signals = INSTITUTIONNEL.detect(cycle);
    const piiSignal = signals.find((s) => s.label === "pii_unredacted");
    expect(piiSignal).toBeDefined();
    expect(piiSignal!.weight).toBeLessThan(0);
  });

  it("v2: detects French phone number in step output as PII (unredacted)", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "execute",
          type: "tool_call",
          output: { phone: "+33612345678" },
        },
      ],
      metadata: { pii_redacted: false },
    });
    const signals = INSTITUTIONNEL.detect(cycle);
    const piiSignal = signals.find((s) => s.label === "pii_unredacted");
    expect(piiSignal).toBeDefined();
    expect(piiSignal!.weight).toBeLessThan(0);
  });

  it("v2: audit_trail_complete=true adds strong positive signal", () => {
    const signals = INSTITUTIONNEL.detect(
      goodCycle({ metadata: { audit_trail_complete: true, pii_redacted: true } }),
    );
    const sig = signals.find((s) => s.label === "audit_trail_complete");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBeGreaterThanOrEqual(0.4);
  });

  it("v2: audit_trail_complete=false adds negative signal", () => {
    const signals = INSTITUTIONNEL.detect(
      goodCycle({ metadata: { audit_trail_complete: false, pii_redacted: true } }),
    );
    const sig = signals.find((s) => s.label === "audit_trail_incomplete");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBeLessThan(0);
  });

  it("v2: known regulatory_scope (eIDAS) adds positive signal with weight ≥ 0.3", () => {
    const signals = INSTITUTIONNEL.detect(
      goodCycle({ metadata: { regulatory_scope: "eIDAS", pii_redacted: true } }),
    );
    const sig = signals.find((s) => s.label === "regulatory_scope_known");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBeGreaterThanOrEqual(0.3);
  });

  it("v2: known regulatory_scope (gdpr) adds positive signal", () => {
    const signals = INSTITUTIONNEL.detect(
      goodCycle({ metadata: { regulatory_scope: "gdpr", pii_redacted: true } }),
    );
    const sig = signals.find((s) => s.label === "regulatory_scope_known");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBeGreaterThan(0);
  });

  it("v2: missing regulatory_scope adds small negative signal", () => {
    const signals = INSTITUTIONNEL.detect(
      goodCycle({ metadata: { pii_redacted: true, audit_trail_complete: true } }),
    );
    const sig = signals.find((s) => s.label === "regulatory_scope_missing");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBeLessThan(0);
  });

  it("v2: fully compliant cycle scores above 0.7", async () => {
    const { institutionnelScorer } = await import("../src/constitution/scorer.js");
    const cycle = goodCycle({
      metadata: {
        pii_redacted: true,
        audit_trail_complete: true,
        regulatory_scope: "eIDAS",
        rso_veto: false,
      },
    });
    const result = await institutionnelScorer(cycle);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it("v2: fully bad cycle (RSO veto + unredacted PII + no audit) scores below 0.3", async () => {
    const { institutionnelScorer } = await import("../src/constitution/scorer.js");
    const cycle = badCycle({
      steps: [
        {
          index: 0,
          phase: "execute",
          type: "tool_call",
          output: { email: "leak@example.com", iban: "FR7630006000011234567890189" },
        },
      ],
      metadata: {
        rso_veto: true,
        pii_redacted: false,
        audit_trail_complete: false,
      },
    });
    const result = await institutionnelScorer(cycle);
    expect(result.score).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// SOTA
// ---------------------------------------------------------------------------

describe("SOTA axiom", () => {
  it("returns positive signal for Poseidon hash primitive", () => {
    const signals = SOTA.detect(goodCycle({ metadata: { hash_primitive: "poseidon" } }));
    const primitiveSignal = signals.find((s) => s.label === "hash_primitive_sota");
    expect(primitiveSignal).toBeDefined();
    expect(primitiveSignal!.weight).toBeGreaterThan(0);
  });

  it("penalises keccak256 (ZK-unsafe)", () => {
    const signals = SOTA.detect(goodCycle({ metadata: { hash_primitive: "keccak256" } }));
    const primitiveSignal = signals.find((s) => s.label === "hash_primitive_zk_unsafe");
    expect(primitiveSignal).toBeDefined();
    expect(primitiveSignal!.weight).toBeLessThan(0);
  });

  it("strongly penalises MD5 (cryptographically weak)", () => {
    const signals = SOTA.detect(goodCycle({ metadata: { hash_primitive: "md5" } }));
    const primitiveSignal = signals.find((s) => s.label === "hash_primitive_weak");
    expect(primitiveSignal).toBeDefined();
    expect(primitiveSignal!.weight).toBeLessThanOrEqual(-0.8);
  });

  it("returns positive signal for SLSA >= 3", () => {
    const signals = SOTA.detect(goodCycle({ metadata: { slsa_level: 3 } }));
    const slsaSignal = signals.find((s) => s.label === "slsa_level_adequate");
    expect(slsaSignal).toBeDefined();
    expect(slsaSignal!.weight).toBeGreaterThan(0);
  });

  it("penalises SLSA < 3", () => {
    const signals = SOTA.detect(goodCycle({ metadata: { slsa_level: 1 } }));
    const slsaSignal = signals.find((s) => s.label === "slsa_level_low");
    expect(slsaSignal).toBeDefined();
    expect(slsaSignal!.weight).toBeLessThan(0);
  });

  it("penalises known-stale model names", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "decide",
          type: "llm_call",
          model: { provider: "openai", name: "gpt-3.5-turbo", version: "0301" },
        },
      ],
    });
    const signals = SOTA.detect(cycle);
    const staleSignal = signals.find((s) => s.label === "stale_model_version");
    expect(staleSignal).toBeDefined();
    expect(staleSignal!.weight).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// ROBUSTE
// ---------------------------------------------------------------------------

describe("ROBUSTE axiom", () => {
  it("returns positive signal when timeouts and error paths are configured", () => {
    const signals = ROBUSTE.detect(goodCycle());
    const timeoutSignal = signals.find((s) => s.label === "timeouts_configured");
    const errorSignal = signals.find((s) => s.label === "error_paths_explicit");
    expect(timeoutSignal?.weight).toBeGreaterThan(0);
    expect(errorSignal?.weight).toBeGreaterThan(0);
  });

  it("penalises missing timeouts", () => {
    const signals = ROBUSTE.detect(
      goodCycle({ metadata: { timeouts_configured: false, error_paths_explicit: true } }),
    );
    const timeoutSignal = signals.find((s) => s.label === "timeouts_missing");
    expect(timeoutSignal?.weight).toBeLessThan(0);
  });

  it("flags secret-like content in step output (api_key pattern)", () => {
    const cycle = goodCycle({
      steps: [
        {
          index: 0,
          phase: "act",
          type: "tool_call",
          output: "Config dump: api_key=sk-abc123secret",
        },
      ],
    });
    const signals = ROBUSTE.detect(cycle);
    const secretSignal = signals.find((s) => s.label === "secret_leaked_in_output");
    expect(secretSignal).toBeDefined();
    expect(secretSignal!.weight).toBeLessThanOrEqual(-1.0);
  });

  it("gives clean signal when no secret pattern present", () => {
    const signals = ROBUSTE.detect(goodCycle());
    const cleanSignal = signals.find((s) => s.label === "no_secret_leak");
    expect(cleanSignal).toBeDefined();
    expect(cleanSignal!.weight).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ANTI_FRAGILE
// ---------------------------------------------------------------------------

describe("ANTI_FRAGILE axiom", () => {
  it("returns positive signals for resilient cycle", () => {
    const signals = ANTI_FRAGILE.detect(goodCycle());
    const fallbackSignal = signals.find((s) => s.label === "fallback_exists");
    const multiSource = signals.find((s) => s.label === "multi_source");
    const idempotent = signals.find((s) => s.label === "idempotent");
    expect(fallbackSignal?.weight).toBeGreaterThan(0);
    expect(multiSource?.weight).toBeGreaterThan(0);
    expect(idempotent?.weight).toBeGreaterThan(0);
  });

  it("penalises single source of failure", () => {
    const signals = ANTI_FRAGILE.detect(
      goodCycle({
        metadata: {
          has_fallback: false,
          source_count: 1,
          is_idempotent: false,
        },
      }),
    );
    const noFallback = signals.find((s) => s.label === "no_fallback");
    const singleSource = signals.find((s) => s.label === "single_source");
    expect(noFallback?.weight).toBeLessThan(0);
    expect(singleSource?.weight).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// PROFITABLE
// ---------------------------------------------------------------------------

describe("PROFITABLE axiom", () => {
  it("returns positive signal when budget is respected", () => {
    const signals = PROFITABLE.detect(goodCycle());
    const budgetSignal = signals.find((s) => s.label === "budget_respected");
    expect(budgetSignal).toBeDefined();
    expect(budgetSignal!.weight).toBeGreaterThan(0);
  });

  it("penalises budget overrun", () => {
    const cycle = goodCycle({ budgetUsdMax: 0.5, budgetUsdSpent: 0.9 });
    const signals = PROFITABLE.detect(cycle);
    const overrunSignal = signals.find((s) => s.label === "budget_overrun");
    expect(overrunSignal).toBeDefined();
    expect(overrunSignal!.weight).toBeLessThan(0);
  });

  it("flags zero-cost cycle with steps (tracking likely missing)", () => {
    const cycle = goodCycle({
      steps: [{ index: 0, phase: "decide", type: "llm_call", output: "hello" }],
      // costUsd deliberately omitted
    });
    const signals = PROFITABLE.detect(cycle);
    const zeroCostSignal = signals.find((s) => s.label === "zero_cost_cycle");
    expect(zeroCostSignal).toBeDefined();
    expect(zeroCostSignal!.weight).toBeLessThan(0);
  });

  it("gives positive cost-tracking signal when costs are present", () => {
    const signals = PROFITABLE.detect(goodCycle());
    const costTrackedSignal = signals.find((s) => s.label === "cost_tracked");
    expect(costTrackedSignal).toBeDefined();
    expect(costTrackedSignal!.weight).toBeGreaterThan(0);
  });
});
