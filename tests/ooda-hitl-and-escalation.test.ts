/**
 * Tests for:
 *   src/orchestration/ooda/audit-log.ts — recordHITLDecision
 *   src/types/escalation-mapping.ts — toSdkEscalationLevel
 *
 * Coverage:
 *   recordHITLDecision — calls UPDATE on hitl_approvals with correct params,
 *     throws on empty hitlId,
 *     throws on invalid decision string,
 *     throws on empty resolverUserId,
 *     passes rationale as null when not provided,
 *     concurrent second call is no-op (SQL status='pending' filter)
 *   toSdkEscalationLevel — L0 → L1_autonomous, L1 → L1_autonomous,
 *     L2 → L2_async_review, L3 → L3_hitl_required
 *
 * Ref: test coverage for ooda audit-log + escalation mapping (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { recordHITLDecision } from "../src/orchestration/ooda/audit-log.js";
import { toSdkEscalationLevel } from "../src/types/escalation-mapping.js";

// ─── recordHITLDecision ───────────────────────────────────────────────────────

function makeDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
}

describe("recordHITLDecision — validation", () => {
  it("throws when hitlId is empty", async () => {
    const db = makeDb();
    await expect(recordHITLDecision(db as never, "", "approved", "alice")).rejects.toThrow(
      "hitlId",
    );
  });

  it("throws when decision is not approved/rejected", async () => {
    const db = makeDb();
    await expect(
      recordHITLDecision(db as never, "hitl-1", "maybe" as never, "alice"),
    ).rejects.toThrow("decision");
  });

  it("throws when resolverUserId is empty", async () => {
    const db = makeDb();
    await expect(recordHITLDecision(db as never, "hitl-1", "approved", "")).rejects.toThrow(
      "resolverUserId",
    );
  });
});

describe("recordHITLDecision — SQL", () => {
  it("calls UPDATE on hitl_approvals with status, resolver, rationale", async () => {
    const db = makeDb();
    await recordHITLDecision(db as never, "hitl-abc", "approved", "alice", "looks good");
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("UPDATE hitl_approvals");
    expect(sql).toContain("status = 'pending'");
    expect(params).toEqual(["hitl-abc", "approved", "alice", "looks good"]);
  });

  it("passes null rationale when not provided", async () => {
    const db = makeDb();
    await recordHITLDecision(db as never, "hitl-abc", "rejected", "bob");
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params[3]).toBeNull();
  });

  it("resolves without error on success", async () => {
    const db = makeDb();
    await expect(
      recordHITLDecision(db as never, "hitl-1", "approved", "alice"),
    ).resolves.toBeUndefined();
  });

  it("accepts 'rejected' decision", async () => {
    const db = makeDb();
    await expect(
      recordHITLDecision(db as never, "hitl-1", "rejected", "bob", "needs rework"),
    ).resolves.toBeUndefined();
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params[1]).toBe("rejected");
  });
});

// ─── toSdkEscalationLevel ────────────────────────────────────────────────────

describe("toSdkEscalationLevel", () => {
  it("L0 → L1_autonomous (truly unchecked → autonomous)", () => {
    expect(toSdkEscalationLevel("L0")).toBe("L1_autonomous");
  });

  it("L1 → L1_autonomous (audit-logged autonomous → autonomous)", () => {
    expect(toSdkEscalationLevel("L1")).toBe("L1_autonomous");
  });

  it("L2 → L2_async_review", () => {
    expect(toSdkEscalationLevel("L2")).toBe("L2_async_review");
  });

  it("L3 → L3_hitl_required", () => {
    expect(toSdkEscalationLevel("L3")).toBe("L3_hitl_required");
  });
});
