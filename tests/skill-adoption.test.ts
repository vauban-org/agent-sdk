/**
 * Tests for:
 *   agent-sdk/src/skill-loop/adoption.ts
 *
 * Coverage:
 *   promoteCandidate — promotion, insufficient_signal, sign-off gate
 *   rejectCandidate  — explicit rejection
 *   deprecateUnderperformers — batch auto-deprecation, thresholds
 *   PromotionWithoutSignOffError — error shape, instanceof, candidateId
 *
 * All tests are pure-function / deterministic (nowDate injected).
 */

import { describe, expect, it } from "vitest";
import {
  AdoptionRecord,
  AdoptionStatus,
  PromotionWithoutSignOffError,
  deprecateUnderperformers,
  promoteCandidate,
  rejectCandidate,
} from "../src/skill-loop/adoption.js";
import type { SkillCandidate } from "../src/skill-loop/candidate.js";
import type { EvalResult } from "../src/skill-loop/evaluator.js";
import type { SignOffRecord } from "../src/skill-loop/sign-off.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: "skill-v2",
    extractedFrom: "cycle-001",
    domain: "vault_rebalance",
    instructions: "Do X then Y",
    constitutionalScore: 0.9,
    outcomeScore: 0.85,
    version: "1.0.0",
    replayRoot: "deadbeef",
    ...overrides,
  };
}

function makeEval(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    candidateId: "skill-v2",
    verifierSetSize: 20,
    meanScore: 0.82,
    stddev: 0.05,
    passRate: 0.9,
    incumbentMeanScore: 0.67,
    deltaVsIncumbent: 0.15, // +15% — meets >=0.10 threshold
    pValue: 0.03, // meets < 0.05 threshold
    significant: true, // both gates passed
    ...overrides,
  };
}

function makeSignOff(overrides: Partial<SignOffRecord> = {}): SignOffRecord {
  return {
    candidateId: "skill-v2",
    approverId: "founder",
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    decision: "approved",
    rationale: "Delta is well above threshold; constitutional score excellent.",
    signedHash: "abc123",
    ...overrides,
  };
}

const NOW = new Date("2026-05-20T12:00:00Z");

// ---------------------------------------------------------------------------
// promoteCandidate — promotion path
// ---------------------------------------------------------------------------

describe("promoteCandidate — promotion path", () => {
  it("returns status=promoted when significant=true and sign-off is approved", () => {
    const record = promoteCandidate(makeCandidate(), makeEval(), makeSignOff(), NOW);
    expect(record.status).toBe("promoted");
  });

  it("sets promotedAt to the injected nowDate", () => {
    const record = promoteCandidate(makeCandidate(), makeEval(), makeSignOff(), NOW);
    expect(record.promotedAt).toEqual(NOW);
  });

  it("sets deprecatedAt to null on promotion", () => {
    const record = promoteCandidate(makeCandidate(), makeEval(), makeSignOff(), NOW);
    expect(record.deprecatedAt).toBeNull();
  });

  it("sets candidateId to candidate.id", () => {
    const candidate = makeCandidate({ id: "my-unique-skill" });
    const record = promoteCandidate(
      candidate,
      makeEval({ candidateId: "my-unique-skill" }),
      makeSignOff({ candidateId: "my-unique-skill" }),
      NOW,
    );
    expect(record.candidateId).toBe("my-unique-skill");
  });

  it("includes the sign-off record in the returned AdoptionRecord", () => {
    const signOff = makeSignOff();
    const record = promoteCandidate(makeCandidate(), makeEval(), signOff, NOW);
    expect(record.signOff).toBe(signOff);
  });

  it("includes the evalResult in the returned AdoptionRecord", () => {
    const evalResult = makeEval();
    const record = promoteCandidate(makeCandidate(), evalResult, makeSignOff(), NOW);
    expect(record.evalResult).toBe(evalResult);
  });

  it("reason string includes approverId", () => {
    const signOff = makeSignOff({ approverId: "alice" });
    const record = promoteCandidate(makeCandidate(), makeEval(), signOff, NOW);
    expect(record.reason).toContain("alice");
  });
});

// ---------------------------------------------------------------------------
// promoteCandidate — insufficient_signal path
// ---------------------------------------------------------------------------

describe("promoteCandidate — insufficient_signal path", () => {
  it("returns status=insufficient_signal when significant=false (pValue >= 0.05)", () => {
    const eval_ = makeEval({ pValue: 0.06, significant: false });
    const record = promoteCandidate(makeCandidate(), eval_, makeSignOff(), NOW);
    expect(record.status).toBe("insufficient_signal");
  });

  it("returns status=insufficient_signal when significant=false (delta < 0.10)", () => {
    const eval_ = makeEval({ deltaVsIncumbent: 0.08, significant: false });
    const record = promoteCandidate(makeCandidate(), eval_, makeSignOff(), NOW);
    expect(record.status).toBe("insufficient_signal");
  });

  it("sets promotedAt to null when signal is insufficient", () => {
    const record = promoteCandidate(
      makeCandidate(),
      makeEval({ significant: false }),
      makeSignOff(),
      NOW,
    );
    expect(record.promotedAt).toBeNull();
  });

  it("reason mentions pValue and delta when insufficient", () => {
    const eval_ = makeEval({
      pValue: 0.08,
      deltaVsIncumbent: 0.05,
      significant: false,
    });
    const record = promoteCandidate(makeCandidate(), eval_, makeSignOff(), NOW);
    expect(record.reason).toMatch(/p=|delta=/i);
  });
});

// ---------------------------------------------------------------------------
// promoteCandidate — sign-off gate (PromotionWithoutSignOffError)
// ---------------------------------------------------------------------------

describe("promoteCandidate — sign-off gate", () => {
  it("throws PromotionWithoutSignOffError when signOff is null", () => {
    expect(() => promoteCandidate(makeCandidate(), makeEval(), null, NOW)).toThrow(
      PromotionWithoutSignOffError,
    );
  });

  it("throws PromotionWithoutSignOffError when decision is rejected", () => {
    const rejected = makeSignOff({ decision: "rejected" });
    expect(() => promoteCandidate(makeCandidate(), makeEval(), rejected, NOW)).toThrow(
      PromotionWithoutSignOffError,
    );
  });

  it("PromotionWithoutSignOffError.candidateId matches candidate.id", () => {
    const candidate = makeCandidate({ id: "my-skill" });
    try {
      promoteCandidate(candidate, makeEval(), null, NOW);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionWithoutSignOffError);
      expect((err as PromotionWithoutSignOffError).candidateId).toBe("my-skill");
    }
  });

  it("PromotionWithoutSignOffError.name is 'PromotionWithoutSignOffError'", () => {
    try {
      promoteCandidate(makeCandidate(), makeEval(), null, NOW);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as PromotionWithoutSignOffError).name).toBe("PromotionWithoutSignOffError");
    }
  });

  it("PromotionWithoutSignOffError is instanceof Error", () => {
    try {
      promoteCandidate(makeCandidate(), makeEval(), null, NOW);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("PromotionWithoutSignOffError message mentions the candidateId", () => {
    const candidate = makeCandidate({ id: "vault-skill-99" });
    try {
      promoteCandidate(candidate, makeEval(), null, NOW);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("vault-skill-99");
    }
  });
});

// ---------------------------------------------------------------------------
// rejectCandidate
// ---------------------------------------------------------------------------

describe("rejectCandidate", () => {
  it("returns status=rejected", () => {
    const record = rejectCandidate(makeCandidate(), makeEval(), makeSignOff(), "manual rejection");
    expect(record.status).toBe("rejected");
  });

  it("sets promotedAt to null", () => {
    const record = rejectCandidate(makeCandidate(), makeEval(), null, "no sign-off");
    expect(record.promotedAt).toBeNull();
  });

  it("sets deprecatedAt to null", () => {
    const record = rejectCandidate(makeCandidate(), makeEval(), null, "bad delta");
    expect(record.deprecatedAt).toBeNull();
  });

  it("includes the provided reason verbatim", () => {
    const record = rejectCandidate(makeCandidate(), makeEval(), null, "delta too low");
    expect(record.reason).toBe("delta too low");
  });

  it("sets signOff to null when none provided", () => {
    const record = rejectCandidate(makeCandidate(), makeEval(), null, "no sign-off");
    expect(record.signOff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deprecateUnderperformers — individual thresholds
// ---------------------------------------------------------------------------

describe("deprecateUnderperformers — thresholds", () => {
  function makeItem(delta: number, pValue: number, id = "cand-1") {
    return {
      candidate: makeCandidate({ id }),
      evalResult: makeEval({
        deltaVsIncumbent: delta,
        pValue,
        significant: false,
      }),
    };
  }

  it("deprecates when deltaVsIncumbent < -0.05", () => {
    const results = deprecateUnderperformers([makeItem(-0.06, 0.1)], NOW);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("deprecated");
  });

  it("does NOT deprecate when deltaVsIncumbent === -0.05 (strict less-than)", () => {
    const results = deprecateUnderperformers([makeItem(-0.05, 0.1)], NOW);
    expect(results).toHaveLength(0);
  });

  it("does NOT deprecate when deltaVsIncumbent is positive", () => {
    const results = deprecateUnderperformers([makeItem(0.05, 0.1)], NOW);
    expect(results).toHaveLength(0);
  });

  it("deprecates when pValue > 0.5 AND delta is negative", () => {
    const results = deprecateUnderperformers([makeItem(-0.01, 0.6)], NOW);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("deprecated");
  });

  it("does NOT deprecate when pValue > 0.5 but delta is non-negative", () => {
    const results = deprecateUnderperformers([makeItem(0.0, 0.6)], NOW);
    expect(results).toHaveLength(0);
  });

  it("does NOT deprecate when pValue === 0.5 and delta is slightly negative (boundary)", () => {
    // pValue must be strictly > 0.5 for that condition branch to trigger
    const results = deprecateUnderperformers([makeItem(-0.01, 0.5)], NOW);
    expect(results).toHaveLength(0);
  });

  it("deprecates when delta < -0.05 regardless of pValue", () => {
    // Even with pValue = 0.01, delta threshold alone triggers deprecation
    const results = deprecateUnderperformers([makeItem(-0.1, 0.01)], NOW);
    expect(results).toHaveLength(1);
  });

  it("sets deprecatedAt to the injected nowDate", () => {
    const results = deprecateUnderperformers([makeItem(-0.1, 0.1)], NOW);
    expect(results[0].deprecatedAt).toEqual(NOW);
  });

  it("sets promotedAt to null on deprecated records", () => {
    const results = deprecateUnderperformers([makeItem(-0.1, 0.1)], NOW);
    expect(results[0].promotedAt).toBeNull();
  });

  it("sets signOff to null on deprecated records (no sign-off required)", () => {
    const results = deprecateUnderperformers([makeItem(-0.1, 0.1)], NOW);
    expect(results[0].signOff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deprecateUnderperformers — batch behaviour
// ---------------------------------------------------------------------------

describe("deprecateUnderperformers — batch", () => {
  it("returns empty array for empty input", () => {
    const results = deprecateUnderperformers([], NOW);
    expect(results).toEqual([]);
  });

  it("only returns records for underperforming candidates", () => {
    const items = [
      {
        candidate: makeCandidate({ id: "bad" }),
        evalResult: makeEval({
          deltaVsIncumbent: -0.1,
          pValue: 0.1,
          significant: false,
        }),
      },
      {
        candidate: makeCandidate({ id: "good" }),
        evalResult: makeEval({
          deltaVsIncumbent: 0.15,
          pValue: 0.03,
          significant: true,
        }),
      },
    ];
    const results = deprecateUnderperformers(items, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].candidateId).toBe("bad");
  });

  it("returns all records when all candidates underperform", () => {
    const items = [
      {
        candidate: makeCandidate({ id: "c1" }),
        evalResult: makeEval({
          deltaVsIncumbent: -0.2,
          pValue: 0.1,
          significant: false,
        }),
      },
      {
        candidate: makeCandidate({ id: "c2" }),
        evalResult: makeEval({
          deltaVsIncumbent: -0.15,
          pValue: 0.1,
          significant: false,
        }),
      },
      {
        candidate: makeCandidate({ id: "c3" }),
        evalResult: makeEval({
          deltaVsIncumbent: -0.1,
          pValue: 0.1,
          significant: false,
        }),
      },
    ];
    const results = deprecateUnderperformers(items, NOW);
    expect(results).toHaveLength(3);
  });

  it("reason string contains delta and pValue for deprecated candidates", () => {
    const items = [
      {
        candidate: makeCandidate({ id: "c1" }),
        evalResult: makeEval({
          deltaVsIncumbent: -0.12,
          pValue: 0.08,
          significant: false,
        }),
      },
    ];
    const results = deprecateUnderperformers(items, NOW);
    expect(results[0].reason).toMatch(/delta=|p=/i);
  });
});
