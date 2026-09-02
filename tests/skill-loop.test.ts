/**
 * Tests — skill-loop pipeline (sprint-583)
 *
 * Covers:
 *   - extractCandidate: deterministic (same args → same id)
 *   - evaluateCandidate: scores incumbent vs candidate, significance test
 *   - ABRunner: max 3 concurrent, 10% traffic cap, rollback on >5% degradation
 *   - SignOffManager: audit trail fields, 72h escalation auto-rejects
 *   - Adoption: promote requires sign-off, reject without sign-off throws
 *   - ValueMetric: skill_value = Σ(usage × delta), cumulative weekly
 *   - ReflexionStore: bit-identical replay test
 */

import { describe, expect, it } from "vitest";
import { ABRunner } from "../src/skill-loop/ab-runner.js";
import {
  PromotionWithoutSignOffError,
  deprecateUnderperformers,
  promoteCandidate,
  rejectCandidate,
} from "../src/skill-loop/adoption.js";
import { extractCandidate } from "../src/skill-loop/candidate.js";
import { evaluateCandidate } from "../src/skill-loop/evaluator.js";
import { ReflexionStore } from "../src/skill-loop/reflexion-replay.js";
import { SignOffManager } from "../src/skill-loop/sign-off.js";
import { computeSkillValue, rankSkillsByValue } from "../src/skill-loop/value-metric.js";
import { bumpVersion } from "../src/skill-loop/versioning.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CYCLE_ID = "cycle-abc123";
const DOMAIN = "vault_rebalance";
const INSTRUCTIONS = "Step 1: check threshold. Step 2: rebalance.";
const SCORES = { constitutional: 0.9, outcome: 0.85 };

// ─── extractCandidate ─────────────────────────────────────────────────────────

describe("extractCandidate", () => {
  it("is deterministic: same args → same id", async () => {
    const c1 = await extractCandidate(CYCLE_ID, INSTRUCTIONS, DOMAIN, SCORES);
    const c2 = await extractCandidate(CYCLE_ID, INSTRUCTIONS, DOMAIN, SCORES);
    expect(c1.id).toBe(c2.id);
  });

  it("produces different ids for different domains", async () => {
    const c1 = await extractCandidate(CYCLE_ID, INSTRUCTIONS, "domain_a", SCORES);
    const c2 = await extractCandidate(CYCLE_ID, INSTRUCTIONS, "domain_b", SCORES);
    expect(c1.id).not.toBe(c2.id);
  });

  it("populates all required fields", async () => {
    const c = await extractCandidate(CYCLE_ID, INSTRUCTIONS, DOMAIN, SCORES);
    expect(c.id).toHaveLength(64); // sha256 hex
    expect(c.extractedFrom).toBe(CYCLE_ID);
    expect(c.domain).toBe(DOMAIN);
    expect(c.instructions).toBe(INSTRUCTIONS);
    expect(c.constitutionalScore).toBe(SCORES.constitutional);
    expect(c.outcomeScore).toBe(SCORES.outcome);
    expect(c.version).toBe("1.0.0");
    expect(c.replayRoot).toHaveLength(64);
  });
});

// ─── evaluateCandidate ────────────────────────────────────────────────────────

describe("evaluateCandidate", () => {
  it("returns significant=false for empty verifier set", async () => {
    const candidate = await extractCandidate(CYCLE_ID, INSTRUCTIONS, DOMAIN, SCORES);
    const result = await evaluateCandidate(candidate, [], 0.5, async () => "output");
    expect(result.significant).toBe(false);
    expect(result.pValue).toBe(1.0);
  });

  it("scores candidate vs incumbent via Jaccard similarity", async () => {
    const candidate = await extractCandidate(CYCLE_ID, "the quick brown fox", DOMAIN, SCORES);
    const verifierSet = [
      { input: "q1", expectedOutput: "the quick brown fox", domain: DOMAIN },
      { input: "q2", expectedOutput: "the quick brown fox", domain: DOMAIN },
    ];
    // Executor returns perfect match
    const result = await evaluateCandidate(
      candidate,
      verifierSet,
      0.3,
      async (_skill, _input) => "the quick brown fox",
    );
    expect(result.meanScore).toBeCloseTo(1.0);
    expect(result.deltaVsIncumbent).toBeGreaterThan(0.1);
  });

  it("marks significant=true when p<0.05 and delta>=0.10", async () => {
    const candidate = await extractCandidate(CYCLE_ID, "abc def ghi", DOMAIN, SCORES);
    const verifierSet = Array.from({ length: 10 }, (_, i) => ({
      input: `q${i}`,
      expectedOutput: "abc def ghi",
      domain: DOMAIN,
    }));
    const result = await evaluateCandidate(
      candidate,
      verifierSet,
      0.1, // incumbentScore = 0.1, candidate will score ~1.0
      async () => "abc def ghi",
    );
    expect(result.significant).toBe(true);
    expect(result.deltaVsIncumbent).toBeGreaterThanOrEqual(0.1);
  });
});

// ─── ABRunner ─────────────────────────────────────────────────────────────────

describe("ABRunner", () => {
  it("rejects the 4th candidate when maxCandidates=3", async () => {
    const runner = new ABRunner({
      maxCandidates: 3,
      trafficPct: 0.1,
      rollbackThresholdPct: 0.05,
    });
    const c1 = await extractCandidate("c1", "i1", DOMAIN, SCORES);
    const c2 = await extractCandidate("c2", "i2", DOMAIN, SCORES);
    const c3 = await extractCandidate("c3", "i3", DOMAIN, SCORES);
    const c4 = await extractCandidate("c4", "i4", DOMAIN, SCORES);
    expect(runner.addCandidate(c1)).toBe(true);
    expect(runner.addCandidate(c2)).toBe(true);
    expect(runner.addCandidate(c3)).toBe(true);
    expect(runner.addCandidate(c4)).toBe(false); // 4th rejected
  });

  it("caps traffic at 10% regardless of config", async () => {
    const runner = new ABRunner({
      maxCandidates: 3,
      trafficPct: 0.5,
      rollbackThresholdPct: 0.05,
    });
    const c = await extractCandidate("c1", "i1", DOMAIN, SCORES);
    runner.addCandidate(c);
    // Access internal slot via getWinner (indirect) — we verify via shouldRollback behavior
    // trafficPct is capped at 0.10 — verify via config reflection:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((runner as unknown as Record<string, unknown>).config.trafficPct).toBe(0.1);
  });

  it("triggers rollback when candidate degrades >5% vs incumbent", async () => {
    const runner = new ABRunner({
      maxCandidates: 3,
      trafficPct: 0.1,
      rollbackThresholdPct: 0.05,
    });
    const c = await extractCandidate("cRollback", "i", DOMAIN, SCORES);
    runner.addCandidate(c);

    // Incumbent scores high
    for (let i = 0; i < 5; i++) runner.recordOutcome("incumbent", 0.9);
    // Candidate scores low (0.9 - 0.8 = 0.1 > 0.05 threshold)
    for (let i = 0; i < 5; i++) runner.recordOutcome(c.id, 0.8);

    expect(runner.shouldRollback(c.id)).toBe(true);
  });

  it("declares no winner when rollback is triggered", async () => {
    const runner = new ABRunner({
      maxCandidates: 3,
      trafficPct: 0.1,
      rollbackThresholdPct: 0.05,
    });
    const c = await extractCandidate("cNoWin", "i", DOMAIN, SCORES);
    runner.addCandidate(c);
    for (let i = 0; i < 5; i++) runner.recordOutcome("incumbent", 0.9);
    for (let i = 0; i < 5; i++) runner.recordOutcome(c.id, 0.8);
    expect(runner.getWinner()).toBeNull();
  });
});

// ─── SignOffManager ───────────────────────────────────────────────────────────

describe("SignOffManager", () => {
  it("audit trail contains all required fields", () => {
    const mgr = new SignOffManager();
    const record = mgr.recordDecision(
      "cand-001",
      "approver-alice",
      "approved",
      "Candidate shows strong improvement on verifier set.",
    );
    expect(record.candidateId).toBe("cand-001");
    expect(record.approverId).toBe("approver-alice");
    expect(record.decision).toBe("approved");
    expect(record.rationale).toBeTruthy();
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(record.signedHash).toHaveLength(64); // SHA-256 hex
  });

  it("verifyRecord returns true for untampered record", () => {
    const mgr = new SignOffManager();
    const record = mgr.recordDecision("c1", "alice", "approved", "Looks good.");
    expect(mgr.verifyRecord(record)).toBe(true);
  });

  it("verifyRecord returns false after tampering", () => {
    const mgr = new SignOffManager();
    const record = mgr.recordDecision("c1", "alice", "approved", "Looks good.");
    const tampered = { ...record, rationale: "tampered rationale" };
    expect(mgr.verifyRecord(tampered)).toBe(false);
  });

  it("auto-rejects after 72h escalation — never auto-approves", () => {
    const mgr = new SignOffManager();
    const now = new Date("2026-01-01T00:00:00.000Z");
    mgr.requestSignOff("cand-escalate", null, now);

    // Advance time by 73 hours
    const later = new Date(now.getTime() + 73 * 60 * 60 * 1_000);
    const rejections = mgr.escalateExpired(later);

    expect(rejections).toHaveLength(1);
    expect(rejections[0].decision).toBe("rejected");
    expect(rejections[0].approverId).toBe("system:escalation");
  });

  it("one sign-off is sufficient (multiple approvers ok)", () => {
    const mgr = new SignOffManager();
    mgr.recordDecision("c1", "alice", "approved", "Approved by Alice.");
    mgr.recordDecision("c1", "bob", "rejected", "Bob disagrees.");
    // getApproval returns the first approved
    const approval = mgr.getApproval("c1");
    expect(approval).not.toBeNull();
    expect(approval?.approverId).toBe("alice");
  });
});

// ─── Adoption ─────────────────────────────────────────────────────────────────

describe("Adoption", () => {
  it("promotes candidate when sign-off present and eval significant", async () => {
    const candidate = await extractCandidate("c-promote", INSTRUCTIONS, DOMAIN, SCORES);
    const mgr = new SignOffManager();
    const signOff = mgr.recordDecision(candidate.id, "alice", "approved", "LGTM.");

    const evalResult = {
      candidateId: candidate.id,
      verifierSetSize: 10,
      meanScore: 0.85,
      stddev: 0.05,
      passRate: 0.9,
      incumbentMeanScore: 0.6,
      deltaVsIncumbent: 0.25,
      pValue: 0.01,
      significant: true,
    };

    const record = promoteCandidate(candidate, evalResult, signOff);
    expect(record.status).toBe("promoted");
    expect(record.promotedAt).toBeInstanceOf(Date);
  });

  it("throws PromotionWithoutSignOffError when sign-off is null", async () => {
    const candidate = await extractCandidate("c-noso", INSTRUCTIONS, DOMAIN, SCORES);
    const evalResult = {
      candidateId: candidate.id,
      verifierSetSize: 10,
      meanScore: 0.85,
      stddev: 0.05,
      passRate: 0.9,
      incumbentMeanScore: 0.6,
      deltaVsIncumbent: 0.25,
      pValue: 0.01,
      significant: true,
    };
    expect(() => promoteCandidate(candidate, evalResult, null)).toThrow(
      PromotionWithoutSignOffError,
    );
  });

  it("returns insufficient_signal when eval not significant", async () => {
    const candidate = await extractCandidate("c-insig", INSTRUCTIONS, DOMAIN, SCORES);
    const mgr = new SignOffManager();
    const signOff = mgr.recordDecision(candidate.id, "alice", "approved", "Approved.");

    const evalResult = {
      candidateId: candidate.id,
      verifierSetSize: 3,
      meanScore: 0.62,
      stddev: 0.1,
      passRate: 0.5,
      incumbentMeanScore: 0.6,
      deltaVsIncumbent: 0.02, // <10%
      pValue: 0.3,
      significant: false,
    };
    const record = promoteCandidate(candidate, evalResult, signOff);
    expect(record.status).toBe("insufficient_signal");
  });

  it("rejectCandidate returns rejected status", async () => {
    const candidate = await extractCandidate("c-rej", INSTRUCTIONS, DOMAIN, SCORES);
    const evalResult = {
      candidateId: candidate.id,
      verifierSetSize: 5,
      meanScore: 0.4,
      stddev: 0.1,
      passRate: 0.2,
      incumbentMeanScore: 0.6,
      deltaVsIncumbent: -0.2,
      pValue: 0.9,
      significant: false,
    };
    const record = rejectCandidate(candidate, evalResult, null, "Manual rejection.");
    expect(record.status).toBe("rejected");
    expect(record.deprecatedAt).toBeNull();
  });

  it("deprecateUnderperformers auto-deprecates negative delta candidates", async () => {
    const c1 = await extractCandidate("d1", "i1", DOMAIN, SCORES);
    const c2 = await extractCandidate("d2", "i2", DOMAIN, SCORES);
    const pool = [
      {
        candidate: c1,
        evalResult: {
          candidateId: c1.id,
          verifierSetSize: 5,
          meanScore: 0.4,
          stddev: 0.05,
          passRate: 0.2,
          incumbentMeanScore: 0.6,
          deltaVsIncumbent: -0.2, // underperformer
          pValue: 0.8,
          significant: false,
        },
      },
      {
        candidate: c2,
        evalResult: {
          candidateId: c2.id,
          verifierSetSize: 5,
          meanScore: 0.7,
          stddev: 0.05,
          passRate: 0.8,
          incumbentMeanScore: 0.6,
          deltaVsIncumbent: 0.1, // not an underperformer
          pValue: 0.04,
          significant: true,
        },
      },
    ];
    const deprecated = deprecateUnderperformers(pool);
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0].candidateId).toBe(c1.id);
    expect(deprecated[0].status).toBe("deprecated");
  });
});

// ─── ValueMetric ──────────────────────────────────────────────────────────────

describe("ValueMetric", () => {
  it("skill_value = Σ(usage × outcome_delta)", () => {
    const now = new Date("2026-01-08T00:00:00.000Z");
    const events = [
      {
        skillId: "s1",
        timestamp: "2026-01-07T12:00:00.000Z",
        context: { delta: 0.2 },
      },
      {
        skillId: "s1",
        timestamp: "2026-01-06T12:00:00.000Z",
        context: { delta: 0.3 },
      },
      {
        skillId: "s1",
        timestamp: "2026-01-05T12:00:00.000Z",
        context: { delta: 0.1 },
      },
    ];
    const result = computeSkillValue("s1", events, (e) => e.context.delta as number, now);
    expect(result.usageCount).toBe(3);
    expect(result.skillValue).toBeCloseTo(0.6); // 0.2 + 0.3 + 0.1
    expect(result.totalOutcomeDelta).toBeCloseTo(0.6);
  });

  it("excludes events outside the 7-day window", () => {
    const now = new Date("2026-01-08T00:00:00.000Z");
    const events = [
      {
        skillId: "s1",
        timestamp: "2025-12-25T00:00:00.000Z",
        context: { delta: 0.9 },
      }, // >7 days ago
      {
        skillId: "s1",
        timestamp: "2026-01-07T23:00:00.000Z",
        context: { delta: 0.5 },
      }, // within window
    ];
    const result = computeSkillValue("s1", events, (e) => e.context.delta as number, now);
    expect(result.usageCount).toBe(1);
    expect(result.skillValue).toBeCloseTo(0.5);
  });

  it("rankSkillsByValue orders skills descending by skill_value", () => {
    const now = new Date("2026-01-08T00:00:00.000Z");
    const ranked = rankSkillsByValue(
      [
        {
          skillId: "s-low",
          usageEvents: [
            {
              skillId: "s-low",
              timestamp: "2026-01-07T00:00:00.000Z",
              context: { d: 0.1 },
            },
          ],
          outcomeDeltaCalculator: (e) => e.context.d as number,
        },
        {
          skillId: "s-high",
          usageEvents: [
            {
              skillId: "s-high",
              timestamp: "2026-01-07T00:00:00.000Z",
              context: { d: 0.8 },
            },
          ],
          outcomeDeltaCalculator: (e) => e.context.d as number,
        },
      ],
      now,
    );
    expect(ranked[0].skillId).toBe("s-high");
    expect(ranked[1].skillId).toBe("s-low");
  });
});

// ─── ReflexionStore ───────────────────────────────────────────────────────────

describe("ReflexionStore", () => {
  it("replay with same args produces bit-identical replayHash", () => {
    const store = new ReflexionStore();
    const entry = store.store("s1", DOMAIN, INSTRUCTIONS, "lesson text", {
      constitutional: 0.9,
      outcome: 0.85,
    });
    const result = store.replay("s1", DOMAIN, INSTRUCTIONS);
    expect(result).not.toBeNull();
    expect(result!.replayHash).toBe(entry.replayHash);
    expect(result!.identical).toBe(true);
  });

  it("replay returns null for unknown skill/domain/instructions", () => {
    const store = new ReflexionStore();
    store.store("s1", DOMAIN, INSTRUCTIONS, "lesson", {
      constitutional: 0.9,
      outcome: 0.8,
    });
    const result = store.replay("s1", DOMAIN, "different instructions");
    expect(result).toBeNull();
  });

  it("different instructions produce different replayHash (no collision)", () => {
    const store = new ReflexionStore();
    const e1 = store.store("s1", DOMAIN, "instructions A", "lesson A", {
      constitutional: 0.8,
      outcome: 0.7,
    });
    const e2 = store.store("s1", DOMAIN, "instructions B", "lesson B", {
      constitutional: 0.9,
      outcome: 0.8,
    });
    expect(e1.replayHash).not.toBe(e2.replayHash);
  });

  it("stores lesson as-is (no LLM paraphrase — deterministic)", () => {
    const store = new ReflexionStore();
    const lesson = "deterministic lesson: check threshold before rebalance.";
    store.store("s1", DOMAIN, INSTRUCTIONS, lesson, {
      constitutional: 0.9,
      outcome: 0.85,
    });
    const result = store.replay("s1", DOMAIN, INSTRUCTIONS);
    expect(result!.lesson).toBe(lesson);
  });
});

// ─── Versioning ───────────────────────────────────────────────────────────────

describe("bumpVersion", () => {
  it("initial → 1.0.0", () => expect(bumpVersion("1.0.0", "initial")).toBe("1.0.0"));
  it("reflexion → minor bump", () => expect(bumpVersion("1.0.0", "reflexion")).toBe("1.1.0"));
  it("ab_winner → minor bump", () => expect(bumpVersion("1.2.0", "ab_winner")).toBe("1.3.0"));
  it("manual → major bump", () => expect(bumpVersion("1.3.0", "manual")).toBe("2.0.0"));
});
