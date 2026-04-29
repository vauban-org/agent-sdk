/**
 * OODA HITL gate — unit tests.
 *
 * Sprint: command-center:sprint-525:quick-2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForHITLApproval } from "../src/orchestration/ooda/hitl-gate.js";
import type { DbClient } from "../src/tracking/agent-run-tracker.js";

// ─── Mock DbClient ─────────────────────────────────────────────────────────────

interface QueryCall {
  sql: string;
  params: unknown[];
}

type QueryHandler = (
  sql: string,
  params: unknown[],
) => {
  rows: object[];
  rowCount?: number;
};

function makeMockDb(handler: QueryHandler): {
  db: DbClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const db: DbClient = {
    async query<T extends object>(sql: string, params?: unknown[]) {
      const p = params ?? [];
      calls.push({ sql, params: p });
      const out = handler(sql, p);
      return {
        rows: out.rows as T[],
        rowCount: out.rowCount ?? out.rows.length,
      };
    },
  };
  return { db, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("waitForHITLApproval — dry-run", () => {
  it("auto-approves without touching the DB", async () => {
    const { db, calls } = makeMockDb(() => {
      throw new Error("DB should not be queried in dry-run");
    });

    const verdict = await waitForHITLApproval(db, {
      runId: "run-1",
      agentId: "agent-1",
      decisionPayload: { x: 1 },
      executionMode: "dry-run",
    });

    expect(verdict.approved).toBe(true);
    expect(verdict.timedOut).toBe(false);
    expect(verdict.resolvedBy).toBe("dry-run-auto");
    expect(calls).toHaveLength(0);
  });
});

describe("waitForHITLApproval — live mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("INSERTs a pending row and resolves on approval", async () => {
    let pollCount = 0;
    const { db, calls } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        return { rows: [{ id: "hitl-uuid-1" }] };
      }
      pollCount += 1;
      // First two polls return pending, third returns approved.
      if (pollCount < 3) {
        return {
          rows: [
            {
              id: "hitl-uuid-1",
              status: "pending",
              rationale: null,
              resolved_by: null,
            },
          ],
        };
      }
      return {
        rows: [
          {
            id: "hitl-uuid-1",
            status: "approved",
            rationale: "looks good",
            resolved_by: "user-42",
          },
        ],
      };
    });

    const promise = waitForHITLApproval(
      db,
      {
        runId: "run-1",
        agentId: "agent-1",
        decisionPayload: { intent: "trade" },
        executionMode: "live",
      },
      { timeoutMs: 60_000, pollIntervalMs: 100 },
    );

    // Drive the polling clock forward.
    await vi.advanceTimersByTimeAsync(350);
    const verdict = await promise;

    expect(verdict.approved).toBe(true);
    expect(verdict.timedOut).toBe(false);
    expect(verdict.rationale).toBe("looks good");
    expect(verdict.resolvedBy).toBe("user-42");

    const insertCall = calls[0];
    if (!insertCall) throw new Error("expected insert call");
    expect(insertCall.sql).toContain("INSERT INTO hitl_approvals");
    expect(insertCall.params[0]).toBe("run-1");
    expect(insertCall.params[1]).toBe("agent-1");
    expect(insertCall.params[2]).toBe(JSON.stringify({ intent: "trade" }));
  });

  it("returns approved=false on rejection", async () => {
    const { db } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        return { rows: [{ id: "hitl-uuid-2" }] };
      }
      return {
        rows: [
          {
            id: "hitl-uuid-2",
            status: "rejected",
            rationale: "too risky",
            resolved_by: "user-9",
          },
        ],
      };
    });

    const promise = waitForHITLApproval(
      db,
      {
        runId: "run-2",
        agentId: "agent-2",
        decisionPayload: {},
        executionMode: "live",
      },
      { timeoutMs: 10_000, pollIntervalMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(60);
    const verdict = await promise;

    expect(verdict.approved).toBe(false);
    expect(verdict.timedOut).toBe(false);
    expect(verdict.rationale).toBe("too risky");
    expect(verdict.resolvedBy).toBe("user-9");
  });

  it("times out → reject (default)", async () => {
    const { db } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        return { rows: [{ id: "hitl-uuid-3" }] };
      }
      return {
        rows: [
          {
            id: "hitl-uuid-3",
            status: "pending",
            rationale: null,
            resolved_by: null,
          },
        ],
      };
    });

    const promise = waitForHITLApproval(
      db,
      {
        runId: "run-3",
        agentId: "agent-3",
        decisionPayload: {},
        executionMode: "live",
      },
      { timeoutMs: 200, pollIntervalMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(500);
    const verdict = await promise;

    expect(verdict.timedOut).toBe(true);
    expect(verdict.approved).toBe(false);
    expect(verdict.rationale).toBe("timeout:reject");
  });

  it("times out → approve when onTimeout='approve'", async () => {
    const { db } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        return { rows: [{ id: "hitl-uuid-4" }] };
      }
      return {
        rows: [
          {
            id: "hitl-uuid-4",
            status: "pending",
            rationale: null,
            resolved_by: null,
          },
        ],
      };
    });

    const promise = waitForHITLApproval(
      db,
      {
        runId: "run-4",
        agentId: "agent-4",
        decisionPayload: {},
        executionMode: "live",
      },
      { timeoutMs: 200, pollIntervalMs: 50, onTimeout: "approve" },
    );

    await vi.advanceTimersByTimeAsync(500);
    const verdict = await promise;

    expect(verdict.timedOut).toBe(true);
    expect(verdict.approved).toBe(true);
    expect(verdict.rationale).toBe("timeout:approve");
  });

  it("times out → approve when onTimeout='continue-skip'", async () => {
    const { db } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        return { rows: [{ id: "hitl-uuid-5" }] };
      }
      return {
        rows: [
          {
            id: "hitl-uuid-5",
            status: "pending",
            rationale: null,
            resolved_by: null,
          },
        ],
      };
    });

    const promise = waitForHITLApproval(
      db,
      {
        runId: "run-5",
        agentId: "agent-5",
        decisionPayload: {},
        executionMode: "live",
      },
      { timeoutMs: 200, pollIntervalMs: 50, onTimeout: "continue-skip" },
    );

    await vi.advanceTimersByTimeAsync(500);
    const verdict = await promise;

    expect(verdict.timedOut).toBe(true);
    expect(verdict.approved).toBe(true);
    expect(verdict.rationale).toBe("timeout:continue-skip");
  });

  it("treats vanished row as rejection (no infinite loop)", async () => {
    const { db } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        return { rows: [{ id: "hitl-uuid-6" }] };
      }
      // Row deleted between INSERT and first SELECT.
      return { rows: [] };
    });

    const promise = waitForHITLApproval(
      db,
      {
        runId: "run-6",
        agentId: "agent-6",
        decisionPayload: {},
        executionMode: "live",
      },
      { timeoutMs: 10_000, pollIntervalMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(60);
    const verdict = await promise;

    expect(verdict.approved).toBe(false);
    expect(verdict.timedOut).toBe(false);
    expect(verdict.rationale).toBe("row-missing");
  });

  it("rejects an invalid executionMode literal", async () => {
    const { db } = makeMockDb(() => ({ rows: [] }));
    await expect(
      waitForHITLApproval(db, {
        runId: "run-7",
        agentId: "agent-7",
        decisionPayload: {},
        executionMode: "shadow" as unknown as "live",
      }),
    ).rejects.toThrow(/executionMode/);
  });
});

describe("waitForHITLApproval — concurrent semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("two concurrent waits on the same hitl id observe the same verdict", async () => {
    // Single shared store keyed by hitl_id; status flips after a few polls.
    let pollCount = 0;
    const { db } = makeMockDb((sql) => {
      if (sql.includes("INSERT INTO hitl_approvals")) {
        // INSERT used by both promises returns its own id.
        return { rows: [{ id: `hitl-c-${pollCount}` }] };
      }
      pollCount += 1;
      if (pollCount < 4) {
        return {
          rows: [
            {
              id: "shared",
              status: "pending",
              rationale: null,
              resolved_by: null,
            },
          ],
        };
      }
      return {
        rows: [
          {
            id: "shared",
            status: "approved",
            rationale: "ok",
            resolved_by: "ops",
          },
        ],
      };
    });

    const args = {
      runId: "run-c",
      agentId: "agent-c",
      decisionPayload: {},
      executionMode: "live" as const,
    };
    const opts = { timeoutMs: 5_000, pollIntervalMs: 50 };

    const p1 = waitForHITLApproval(db, args, opts);
    const p2 = waitForHITLApproval(db, args, opts);

    await vi.advanceTimersByTimeAsync(400);
    const [v1, v2] = await Promise.all([p1, p2]);

    // Both observed the same final state; no double-resolve corruption.
    expect(v1.approved).toBe(true);
    expect(v2.approved).toBe(true);
    expect(v1.timedOut).toBe(false);
    expect(v2.timedOut).toBe(false);
  });
});
