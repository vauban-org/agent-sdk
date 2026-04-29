/**
 * OODA run_step persistence — unit tests.
 *
 * Sprint: command-center:sprint-525:quick-2
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeRunStep,
  errorRunStep,
  insertRunStep,
} from "../src/orchestration/ooda/run-step-persistence.js";
import { computeLeafHash } from "../src/proof/poseidon.js";
import type { DbClient } from "../src/tracking/agent-run-tracker.js";

// ─── Mock DbClient helper ─────────────────────────────────────────────────────

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeMockDb(responses: Array<{ rows: object[]; rowCount?: number }>): {
  db: DbClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let i = 0;
  const db: DbClient = {
    async query<T extends object>(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      const next = responses[i] ?? ({ rows: [] as object[], rowCount: 0 } as const);
      i += 1;
      return {
        rows: next.rows as T[],
        rowCount: next.rowCount ?? next.rows.length,
      };
    },
  };
  return { db, calls };
}

// ─── insertRunStep ────────────────────────────────────────────────────────────

describe("insertRunStep", () => {
  it("INSERTs a pending row and returns the generated stepId", async () => {
    const { db, calls } = makeMockDb([{ rows: [{ id: "step-uuid-1" }] }]);

    const out = await insertRunStep(db, "run-uuid-1", {
      type: "decision",
      phase: "decide",
      stepIndex: 3,
      payload: { foo: "bar" },
    });

    expect(out).toEqual({ stepId: "step-uuid-1" });
    expect(calls).toHaveLength(1);
    const c0 = calls[0];
    if (!c0) throw new Error("expected call 0");
    expect(c0.sql).toContain("INSERT INTO run_step");
    expect(c0.sql).toContain("'pending'");
    expect(c0.params[0]).toBe("run-uuid-1");
    expect(c0.params[1]).toBe(3);
    expect(c0.params[2]).toBeNull(); // parent_step_id default
    expect(c0.params[3]).toBe("decision");
    expect(c0.params[4]).toBe("decide");
    expect(c0.params[5]).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("forwards parentStepId when provided", async () => {
    const { db, calls } = makeMockDb([{ rows: [{ id: "step-uuid-2" }] }]);

    await insertRunStep(db, "run-uuid-1", {
      type: "execution",
      phase: "act",
      stepIndex: 7,
      parentStepId: "parent-uuid",
    });

    const c0 = calls[0];
    if (!c0) throw new Error("expected call 0");
    expect(c0.params[2]).toBe("parent-uuid");
    // Default empty payload when omitted.
    expect(c0.params[5]).toBe(JSON.stringify({}));
  });

  it("rejects empty runId", async () => {
    const { db } = makeMockDb([]);
    await expect(
      insertRunStep(db, "", {
        type: "decision",
        phase: "decide",
        stepIndex: 0,
      }),
    ).rejects.toThrow(/runId/);
  });

  it("rejects negative stepIndex", async () => {
    const { db } = makeMockDb([]);
    await expect(
      insertRunStep(db, "run-1", {
        type: "decision",
        phase: "decide",
        stepIndex: -1,
      }),
    ).rejects.toThrow(/stepIndex/);
  });

  it("throws when DB returns no row", async () => {
    const { db } = makeMockDb([{ rows: [] }]);
    await expect(
      insertRunStep(db, "run-1", {
        type: "decision",
        phase: "decide",
        stepIndex: 0,
      }),
    ).rejects.toThrow(/no row/);
  });
});

// ─── completeRunStep ──────────────────────────────────────────────────────────

describe("completeRunStep", () => {
  it("UPDATEs status='done' and stores the Poseidon leaf hash", async () => {
    const { db, calls } = makeMockDb([{ rows: [], rowCount: 1 }]);

    const payload = { result: "ok", duration_ms: 42 };
    const expectedLeaf = computeLeafHash(payload);

    const out = await completeRunStep(db, "step-uuid-1", payload);

    expect(out.leafHash).toBe(expectedLeaf);
    expect(calls).toHaveLength(1);
    const c0 = calls[0];
    if (!c0) throw new Error("expected call 0");
    expect(c0.sql).toContain("UPDATE run_step");
    expect(c0.sql).toContain("status = 'done'");
    expect(c0.sql).toContain("leaf_hash_poseidon = $3");
    expect(c0.params[0]).toBe("step-uuid-1");
    expect(c0.params[1]).toBe(JSON.stringify(payload));
    expect(c0.params[2]).toBe(expectedLeaf);
  });

  it("rejects empty stepId", async () => {
    const { db } = makeMockDb([]);
    await expect(completeRunStep(db, "", { foo: 1 })).rejects.toThrow(/stepId/);
  });

  it("rejects array payload", async () => {
    const { db } = makeMockDb([]);
    await expect(
      completeRunStep(db, "step-uuid-1", [] as unknown as Record<string, unknown>),
    ).rejects.toThrow(/payload/);
  });

  it("produces a stable leaf hash for the same payload", async () => {
    const { db: db1 } = makeMockDb([{ rows: [], rowCount: 1 }]);
    const { db: db2 } = makeMockDb([{ rows: [], rowCount: 1 }]);
    const payload = { a: 1, b: "two" };
    const r1 = await completeRunStep(db1, "step-1", payload);
    const r2 = await completeRunStep(db2, "step-2", payload);
    expect(r1.leafHash).toBe(r2.leafHash);
  });
});

// ─── errorRunStep ─────────────────────────────────────────────────────────────

describe("errorRunStep", () => {
  it("UPDATEs status='error' and writes the error message", async () => {
    const { db, calls } = makeMockDb([{ rows: [], rowCount: 1 }]);

    await errorRunStep(db, "step-uuid-1", new Error("boom"));

    expect(calls).toHaveLength(1);
    const c0 = calls[0];
    if (!c0) throw new Error("expected call 0");
    expect(c0.sql).toContain("UPDATE run_step");
    expect(c0.sql).toContain("status = 'error'");
    expect(c0.params[0]).toBe("step-uuid-1");
    expect(c0.params[1]).toBe("boom");
  });

  it("coerces non-Error throwables to a string message", async () => {
    const { db, calls } = makeMockDb([{ rows: [], rowCount: 1 }]);
    await errorRunStep(db, "step-uuid-1", "raw-string" as unknown as Error);
    const c0 = calls[0];
    if (!c0) throw new Error("expected call 0");
    expect(c0.params[1]).toBe("raw-string");
  });

  it("rejects empty stepId", async () => {
    const { db } = makeMockDb([]);
    await expect(errorRunStep(db, "", new Error("x"))).rejects.toThrow(/stepId/);
  });
});

// ─── Re-instantiation guard (no shared mutable state) ────────────────────────

describe("module hygiene", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not memoise db across calls", async () => {
    const { db: dbA, calls: callsA } = makeMockDb([{ rows: [{ id: "a" }] }]);
    const { db: dbB, calls: callsB } = makeMockDb([{ rows: [{ id: "b" }] }]);

    await insertRunStep(dbA, "run-A", {
      type: "decision",
      phase: "decide",
      stepIndex: 0,
    });
    await insertRunStep(dbB, "run-B", {
      type: "decision",
      phase: "decide",
      stepIndex: 0,
    });

    expect(callsA[0]?.params[0]).toBe("run-A");
    expect(callsB[0]?.params[0]).toBe("run-B");
  });
});
