/**
 * tests/skill-sign-off.test.ts
 *
 * Unit tests for skill-loop/sign-off.ts
 *
 * Coverage:
 *   - SignOffManager.requestSignOff: new request, idempotent return, expired re-creation
 *   - SignOffManager.recordDecision: approved, rejected, empty rationale guard
 *   - SignOffManager.escalateExpired: auto-rejection after 72h, no-op when not expired
 *   - SignOffManager.getApproval: found, not found, system escalation not counted
 *   - SignOffManager.getAuditTrail: full history accumulation
 *   - SignOffManager.hasPending: true/false/expired
 *   - SignOffManager.verifyRecord: hash integrity, tamper detection
 *   - ESCALATION_DEADLINE_MS constant
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SignOffManager } from "../src/skill-loop/sign-off.js";
import type { SignOffRecord } from "../src/skill-loop/sign-off.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-15T10:00:00.000Z");
const BEFORE_DEADLINE = new Date(NOW.getTime() + SignOffManager.ESCALATION_DEADLINE_MS - 1_000);
const AFTER_DEADLINE = new Date(NOW.getTime() + SignOffManager.ESCALATION_DEADLINE_MS + 1_000);

// ---------------------------------------------------------------------------
// requestSignOff
// ---------------------------------------------------------------------------

describe("SignOffManager.requestSignOff", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("creates a pending request with correct candidateId", () => {
    const req = mgr.requestSignOff("cand-001", null, NOW);
    expect(req.candidateId).toBe("cand-001");
  });

  it("deadlineAt is 72h after requestedAt", () => {
    const req = mgr.requestSignOff("cand-002", null, NOW);
    const delta = new Date(req.deadlineAt).getTime() - new Date(req.requestedAt).getTime();
    expect(delta).toBe(SignOffManager.ESCALATION_DEADLINE_MS);
  });

  it("stores the approverId when provided", () => {
    const req = mgr.requestSignOff("cand-003", "approver-alice", NOW);
    expect(req.approverId).toBe("approver-alice");
  });

  it("null approverId means any approver", () => {
    const req = mgr.requestSignOff("cand-004", null, NOW);
    expect(req.approverId).toBeNull();
  });

  it("returns the same request when called again before expiry", () => {
    const req1 = mgr.requestSignOff("cand-005", null, NOW);
    const req2 = mgr.requestSignOff("cand-005", null, BEFORE_DEADLINE);
    expect(req2.requestedAt).toBe(req1.requestedAt);
  });

  it("creates a fresh request when existing one has expired", () => {
    const req1 = mgr.requestSignOff("cand-006", null, NOW);
    const req2 = mgr.requestSignOff("cand-006", null, AFTER_DEADLINE);
    expect(req2.requestedAt).not.toBe(req1.requestedAt);
  });
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

describe("SignOffManager.recordDecision", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("records an approved decision correctly", () => {
    const rec = mgr.recordDecision(
      "cand-010",
      "approver-bob",
      "approved",
      "Looks good, clear improvement.",
      NOW,
    );
    expect(rec.decision).toBe("approved");
    expect(rec.approverId).toBe("approver-bob");
    expect(rec.candidateId).toBe("cand-010");
  });

  it("records a rejected decision correctly", () => {
    const rec = mgr.recordDecision(
      "cand-011",
      "approver-carol",
      "rejected",
      "Does not meet quality bar.",
      NOW,
    );
    expect(rec.decision).toBe("rejected");
  });

  it("throws when rationale is empty", () => {
    expect(() => mgr.recordDecision("cand-012", "approver-dave", "approved", "", NOW)).toThrow(
      /rationale is required/,
    );
  });

  it("throws when rationale is whitespace only", () => {
    expect(() => mgr.recordDecision("cand-013", "approver-eve", "rejected", "   ", NOW)).toThrow(
      /rationale is required/,
    );
  });

  it("signedHash is a 64-character hex string (SHA-256)", () => {
    const rec = mgr.recordDecision(
      "cand-014",
      "approver-frank",
      "approved",
      "Good candidate.",
      NOW,
    );
    expect(rec.signedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("removes the pending request after decision is recorded", () => {
    mgr.requestSignOff("cand-015", null, NOW);
    expect(mgr.hasPending("cand-015", NOW)).toBe(true);
    mgr.recordDecision("cand-015", "approver-grace", "approved", "Clear improvement.", NOW);
    expect(mgr.hasPending("cand-015", NOW)).toBe(false);
  });

  it("timestamp in record matches the provided nowDate", () => {
    const rec = mgr.recordDecision("cand-016", "approver-hank", "approved", "OK", NOW);
    expect(rec.timestamp).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// escalateExpired
// ---------------------------------------------------------------------------

describe("SignOffManager.escalateExpired", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("auto-rejects expired pending requests", () => {
    mgr.requestSignOff("cand-020", null, NOW);
    const rejections = mgr.escalateExpired(AFTER_DEADLINE);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].candidateId).toBe("cand-020");
    expect(rejections[0].decision).toBe("rejected");
  });

  it("auto-rejection approverId is 'system:escalation'", () => {
    mgr.requestSignOff("cand-021", null, NOW);
    const [rec] = mgr.escalateExpired(AFTER_DEADLINE);
    expect(rec.approverId).toBe("system:escalation");
  });

  it("returns empty array when no requests have expired", () => {
    mgr.requestSignOff("cand-022", null, NOW);
    const rejections = mgr.escalateExpired(BEFORE_DEADLINE);
    expect(rejections).toHaveLength(0);
  });

  it("removes pending request after escalation", () => {
    mgr.requestSignOff("cand-023", null, NOW);
    mgr.escalateExpired(AFTER_DEADLINE);
    expect(mgr.hasPending("cand-023", AFTER_DEADLINE)).toBe(false);
  });

  it("escalates multiple expired requests at once", () => {
    mgr.requestSignOff("cand-024a", null, NOW);
    mgr.requestSignOff("cand-024b", null, NOW);
    const rejections = mgr.escalateExpired(AFTER_DEADLINE);
    expect(rejections).toHaveLength(2);
  });

  it("never auto-approves — decision is always 'rejected'", () => {
    mgr.requestSignOff("cand-025", null, NOW);
    const [rec] = mgr.escalateExpired(AFTER_DEADLINE);
    expect(rec.decision).toBe("rejected");
    expect(rec.decision).not.toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// getApproval
// ---------------------------------------------------------------------------

describe("SignOffManager.getApproval", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("returns null when no decision has been recorded", () => {
    expect(mgr.getApproval("cand-030")).toBeNull();
  });

  it("returns the approved record when decision is 'approved'", () => {
    mgr.recordDecision("cand-031", "approver-ivan", "approved", "LGTM", NOW);
    const approval = mgr.getApproval("cand-031");
    expect(approval).not.toBeNull();
    expect(approval!.decision).toBe("approved");
  });

  it("returns null when decision is 'rejected' (no approval)", () => {
    mgr.recordDecision("cand-032", "approver-jane", "rejected", "Not good.", NOW);
    expect(mgr.getApproval("cand-032")).toBeNull();
  });

  it("does NOT count system:escalation auto-rejection as approval", () => {
    mgr.requestSignOff("cand-033", null, NOW);
    mgr.escalateExpired(AFTER_DEADLINE);
    expect(mgr.getApproval("cand-033")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAuditTrail
// ---------------------------------------------------------------------------

describe("SignOffManager.getAuditTrail", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("returns empty array for unknown candidateId", () => {
    expect(mgr.getAuditTrail("unknown-cand")).toEqual([]);
  });

  it("accumulates multiple decisions in order", () => {
    mgr.recordDecision("cand-040", "approver-k", "rejected", "First pass.", NOW);
    const later = new Date(NOW.getTime() + 3600_000);
    mgr.recordDecision("cand-040", "approver-l", "approved", "Second pass OK.", later);
    const trail = mgr.getAuditTrail("cand-040");
    expect(trail).toHaveLength(2);
    expect(trail[0].decision).toBe("rejected");
    expect(trail[1].decision).toBe("approved");
  });

  it("includes escalation record in audit trail", () => {
    mgr.requestSignOff("cand-041", null, NOW);
    mgr.escalateExpired(AFTER_DEADLINE);
    const trail = mgr.getAuditTrail("cand-041");
    expect(trail).toHaveLength(1);
    expect(trail[0].approverId).toBe("system:escalation");
  });
});

// ---------------------------------------------------------------------------
// hasPending
// ---------------------------------------------------------------------------

describe("SignOffManager.hasPending", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("returns false for candidateId with no request", () => {
    expect(mgr.hasPending("no-request", NOW)).toBe(false);
  });

  it("returns true when request exists and is not expired", () => {
    mgr.requestSignOff("cand-050", null, NOW);
    expect(mgr.hasPending("cand-050", BEFORE_DEADLINE)).toBe(true);
  });

  it("returns false when request has expired", () => {
    mgr.requestSignOff("cand-051", null, NOW);
    expect(mgr.hasPending("cand-051", AFTER_DEADLINE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyRecord — hash integrity
// ---------------------------------------------------------------------------

describe("SignOffManager.verifyRecord", () => {
  let mgr: SignOffManager;

  beforeEach(() => {
    mgr = new SignOffManager();
  });

  it("returns true for a freshly recorded decision", () => {
    const rec = mgr.recordDecision("cand-060", "approver-mike", "approved", "All good.", NOW);
    expect(mgr.verifyRecord(rec)).toBe(true);
  });

  it("returns false when candidateId is tampered", () => {
    const rec = mgr.recordDecision("cand-061", "approver-nina", "approved", "Correct.", NOW);
    const tampered: SignOffRecord = { ...rec, candidateId: "cand-TAMPERED" };
    expect(mgr.verifyRecord(tampered)).toBe(false);
  });

  it("returns false when decision is tampered", () => {
    const rec = mgr.recordDecision("cand-062", "approver-otto", "rejected", "Fail reason.", NOW);
    const tampered: SignOffRecord = { ...rec, decision: "approved" };
    expect(mgr.verifyRecord(tampered)).toBe(false);
  });

  it("returns false when rationale is tampered", () => {
    const rec = mgr.recordDecision(
      "cand-063",
      "approver-paul",
      "approved",
      "Original rationale.",
      NOW,
    );
    const tampered: SignOffRecord = {
      ...rec,
      rationale: "Tampered rationale!",
    };
    expect(mgr.verifyRecord(tampered)).toBe(false);
  });

  it("returns false when timestamp is tampered", () => {
    const rec = mgr.recordDecision("cand-064", "approver-quinn", "approved", "Valid.", NOW);
    const tampered: SignOffRecord = {
      ...rec,
      timestamp: "2099-01-01T00:00:00.000Z",
    };
    expect(mgr.verifyRecord(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ESCALATION_DEADLINE_MS constant
// ---------------------------------------------------------------------------

describe("SignOffManager.ESCALATION_DEADLINE_MS", () => {
  it("is exactly 72 hours in milliseconds", () => {
    expect(SignOffManager.ESCALATION_DEADLINE_MS).toBe(72 * 60 * 60 * 1_000);
  });
});
