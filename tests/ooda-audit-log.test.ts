/**
 * Tests for packages/agent-sdk/src/orchestration/ooda/audit-log.ts
 *
 * Coverage:
 *   recordHITLDecision — validation: empty hitlId, invalid decision, empty resolverUserId,
 *                         calls db.query with correct params on approved,
 *                         passes null when rationale is absent
 *
 * Ref: test coverage for agent-sdk/orchestration/ooda/audit-log.ts (no prior tests)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordHITLDecision } from "../src/orchestration/ooda/audit-log.js";

describe("recordHITLDecision", () => {
  const mockQuery = vi.fn();
  const db = { query: mockQuery } as never;

  beforeEach(() => vi.clearAllMocks());

  it("throws when hitlId is empty", async () => {
    await expect(recordHITLDecision(db, "", "approved", "founder")).rejects.toThrow("hitlId");
  });

  it("throws when decision is not approved/rejected", async () => {
    await expect(recordHITLDecision(db, "req-1", "skip" as never, "founder")).rejects.toThrow(
      "decision must be",
    );
  });

  it("throws when resolverUserId is empty", async () => {
    await expect(recordHITLDecision(db, "req-1", "approved", "")).rejects.toThrow("resolverUserId");
  });

  it("calls db.query with correct params for approved + rationale", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await recordHITLDecision(db, "req-abc", "approved", "founder-42", "looks good");
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE hitl_approvals");
    expect(params[0]).toBe("req-abc");
    expect(params[1]).toBe("approved");
    expect(params[2]).toBe("founder-42");
    expect(params[3]).toBe("looks good");
  });

  it("passes null for rationale when not provided", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await recordHITLDecision(db, "req-abc", "rejected", "founder-42");
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBeNull();
  });

  it("works for rejected decision", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    await expect(
      recordHITLDecision(db, "req-xyz", "rejected", "ops-user"),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});
