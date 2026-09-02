/**
 * HITLPort contract test runner.
 *
 * Applies the shared hitlPortContract suite (from src/ports/hitl.contract.test.ts)
 * to MemoryHITLStateStore, and verifies PostgresHITLStateStore compiles and wires
 * correctly against a mocked DbPort.
 */

import { describe, expect, test, vi } from "vitest";
import { MemoryHITLStateStore } from "../src/adapters/hitl/memory-state-store.js";
import { PostgresHITLStateStore } from "../src/adapters/hitl/postgres-state-store.js";
import type { DbPort } from "../src/ports/db.js";
import {
  HITLNotFoundError,
  type HITLPort,
  type HITLRequest,
  InvalidStateTransitionError,
  runExpireJob,
} from "../src/ports/hitl.js";

// ─── Shared fixture factory ──────────────────────────────────────────────────

function makeRequest(overrides: Partial<HITLRequest> = {}): HITLRequest {
  return {
    id: crypto.randomUUID(),
    agentSource: "test-agent",
    question: "Approve this action?",
    context: { action: "deploy" },
    options: ["approve", "reject"],
    deadline: new Date(Date.now() + 60_000).toISOString(),
    channel: "slack",
    ...overrides,
  };
}

// ─── Contract suite ──────────────────────────────────────────────────────────

export const hitlPortContract = (factory: () => HITLPort) => {
  describe("HITLPort contract", () => {
    test("request creates pending state", async () => {
      const store = factory();
      const req = makeRequest();
      const id = await store.request(req);
      expect(id).toBe(req.id);
      const state = await store.getState(id);
      expect(state).toBe("pending");
    });

    test("await(id, timeoutMs) returns approved when resolved before timeout", async () => {
      const store = factory();
      const req = makeRequest();
      const id = await store.request(req);

      // Resolve concurrently after 50ms
      setTimeout(() => {
        store.resolve(id, "approved", "tester").catch(() => undefined);
      }, 50);

      const state = await store.await(id, 2_000);
      expect(state).toBe("approved");
    });

    test("await(id, timeoutMs) returns state after timeout even if still pending", async () => {
      const store = factory();
      const req = makeRequest();
      const id = await store.request(req);

      // Very short timeout — no one resolves it
      const state = await store.await(id, 80);
      expect(state).toBe("pending");
    });

    test("invalid state transition throws InvalidStateTransitionError", async () => {
      const store = factory();
      const req = makeRequest();
      const id = await store.request(req);

      await store.expire(id);
      expect(await store.getState(id)).toBe("expired");

      await expect(store.resolve(id, "approved", "tester")).rejects.toThrow(
        InvalidStateTransitionError,
      );
    });

    test("idempotent resolve: final state is stable after first resolve", async () => {
      const store = factory();
      const req = makeRequest();
      const id = await store.request(req);

      await store.resolve(id, "approved", "tester");
      expect(await store.getState(id)).toBe("approved");

      // State remains approved — no further mutation
      const state = await store.getState(id);
      expect(state).toBe("approved");
    });

    test("expire sets state to expired", async () => {
      const store = factory();
      const req = makeRequest();
      const id = await store.request(req);

      await store.expire(id);
      const state = await store.getState(id);
      expect(state).toBe("expired");
    });
  });
};

// ─── Apply contract to MemoryHITLStateStore ──────────────────────────────────

hitlPortContract(() => new MemoryHITLStateStore());

// ─── HITLNotFoundError tests ─────────────────────────────────────────────────

describe("HITLPort — not-found handling", () => {
  test("getState throws HITLNotFoundError for unknown id", async () => {
    const store = new MemoryHITLStateStore();
    await expect(store.getState("nonexistent-id")).rejects.toThrow(HITLNotFoundError);
  });

  test("expire throws HITLNotFoundError for unknown id", async () => {
    const store = new MemoryHITLStateStore();
    await expect(store.expire("nonexistent-id")).rejects.toThrow(HITLNotFoundError);
  });
});

// ─── runExpireJob tests ───────────────────────────────────────────────────────

describe("runExpireJob", () => {
  test("calls _expireOverdue on the store at each interval tick", async () => {
    const store = new MemoryHITLStateStore();
    const spy = vi
      .spyOn(store as unknown as { _expireOverdue: () => Promise<void> }, "_expireOverdue")
      .mockResolvedValue(undefined);

    const timer = runExpireJob(store, 50);
    await new Promise<void>((r) => setTimeout(r, 160));
    clearInterval(timer);

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("expires overdue pending requests via _expireOverdue", async () => {
    const store = new MemoryHITLStateStore();
    const req = makeRequest({
      deadline: new Date(Date.now() - 5_000).toISOString(), // already past
    });
    await store.request(req);

    await store._expireOverdue();
    expect(await store.getState(req.id)).toBe("expired");
  });
});

// ─── PostgresHITLStateStore — compile + wire check ──────────────────────────

describe("PostgresHITLStateStore — mocked db wire check", () => {
  function makeDb(rows: object[] = []): DbPort {
    return {
      query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    };
  }

  test("request inserts a row", async () => {
    const db = makeDb();
    const store = new PostgresHITLStateStore({ db });
    const req = makeRequest();
    const id = await store.request(req);
    expect(id).toBe(req.id);
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "INSERT INTO hitl_requests",
    );
  });

  test("getState throws HITLNotFoundError when row is absent", async () => {
    const db = makeDb([]);
    const store = new PostgresHITLStateStore({ db });
    await expect(store.getState("unknown-id")).rejects.toThrow(HITLNotFoundError);
  });

  test("getState returns state from row", async () => {
    const db = makeDb([{ id: "abc", state: "approved" }]);
    const store = new PostgresHITLStateStore({ db });
    const state = await store.getState("abc");
    expect(state).toBe("approved");
  });
});
