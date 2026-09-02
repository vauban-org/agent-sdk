/**
 * Tests for packages/agent-sdk/src/hitl/approval-channel.ts — InMemoryApprovalStore
 *
 * Coverage:
 *   create — stores entry, throws on duplicate id
 *   get — returns copy, null for unknown id
 *   resolve — true on pending→resolved, false on already-resolved, false on missing
 *   cancel — true on pending→cancelled, false on non-pending
 *   expireOverdue — marks overdue pending as timedout, returns count, leaves future alone
 *   listAll — returns all entries as copies
 *
 * Ref: test coverage for agent-sdk/hitl/approval-channel.ts InMemoryApprovalStore (no prior tests)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryApprovalStore } from "../src/hitl/approval-channel.js";
import type { PendingApproval } from "../src/hitl/approval-channel.js";

function makeEntry(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id,
    req: {
      agentId: "forge",
      action: "deploy",
      context: "sprint-700",
      timeoutMs: 60_000,
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: "pending",
    ...overrides,
  };
}

const VERDICT = { approved: true, by: "founder", at: new Date().toISOString() };

describe("InMemoryApprovalStore", () => {
  let store: InMemoryApprovalStore;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("stores a new entry", async () => {
      await store.create(makeEntry("req-1"));
      const entry = await store.get("req-1");
      expect(entry?.id).toBe("req-1");
      expect(entry?.status).toBe("pending");
    });

    it("throws on duplicate id", async () => {
      await store.create(makeEntry("req-dup"));
      await expect(store.create(makeEntry("req-dup"))).rejects.toThrow("duplicate id");
    });

    it("stores a copy (caller mutation does not affect store)", async () => {
      const entry = makeEntry("req-copy");
      await store.create(entry);
      entry.status = "cancelled" as never;
      const stored = await store.get("req-copy");
      expect(stored?.status).toBe("pending");
    });
  });

  // ── get ────────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns null for unknown id", async () => {
      expect(await store.get("ghost")).toBeNull();
    });

    it("returns a copy (caller mutation does not affect store)", async () => {
      await store.create(makeEntry("req-1"));
      const e = await store.get("req-1");
      e!.status = "cancelled" as never;
      const again = await store.get("req-1");
      expect(again?.status).toBe("pending");
    });
  });

  // ── resolve ────────────────────────────────────────────────────────────────

  describe("resolve", () => {
    it("returns true and transitions to resolved", async () => {
      await store.create(makeEntry("req-1"));
      const ok = await store.resolve("req-1", VERDICT);
      expect(ok).toBe(true);
      const entry = await store.get("req-1");
      expect(entry?.status).toBe("resolved");
      expect(entry?.verdict?.by).toBe("founder");
    });

    it("returns false for unknown id", async () => {
      expect(await store.resolve("ghost", VERDICT)).toBe(false);
    });

    it("returns false when already resolved (first writer wins)", async () => {
      await store.create(makeEntry("req-1"));
      await store.resolve("req-1", VERDICT);
      const second = await store.resolve("req-1", { ...VERDICT, by: "other" });
      expect(second).toBe(false);
      const entry = await store.get("req-1");
      expect(entry?.verdict?.by).toBe("founder"); // first verdict preserved
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────────

  describe("cancel", () => {
    it("returns true and transitions to cancelled", async () => {
      await store.create(makeEntry("req-1"));
      expect(await store.cancel("req-1")).toBe(true);
      expect((await store.get("req-1"))?.status).toBe("cancelled");
    });

    it("returns false for unknown id", async () => {
      expect(await store.cancel("ghost")).toBe(false);
    });

    it("returns false when already cancelled", async () => {
      await store.create(makeEntry("req-1"));
      await store.cancel("req-1");
      expect(await store.cancel("req-1")).toBe(false);
    });
  });

  // ── expireOverdue ──────────────────────────────────────────────────────────

  describe("expireOverdue", () => {
    it("marks overdue pending entries as timedout, returns count", async () => {
      const past = Date.now() - 5_000;
      await store.create(makeEntry("req-past", { expiresAt: past }));
      await store.create(makeEntry("req-future"));
      const n = await store.expireOverdue(Date.now());
      expect(n).toBe(1);
      expect((await store.get("req-past"))?.status).toBe("timedout");
      expect((await store.get("req-future"))?.status).toBe("pending");
    });

    it("does not expire already-resolved entries", async () => {
      const past = Date.now() - 5_000;
      await store.create(makeEntry("req-res", { expiresAt: past }));
      await store.resolve("req-res", VERDICT);
      const n = await store.expireOverdue(Date.now());
      expect(n).toBe(0);
      expect((await store.get("req-res"))?.status).toBe("resolved");
    });

    it("returns 0 when no entries are overdue", async () => {
      await store.create(makeEntry("req-future"));
      expect(await store.expireOverdue(Date.now())).toBe(0);
    });
  });

  // ── listAll ────────────────────────────────────────────────────────────────

  describe("listAll", () => {
    it("returns all entries", async () => {
      await store.create(makeEntry("req-1"));
      await store.create(makeEntry("req-2"));
      const all = await store.listAll();
      expect(all.map((e) => e.id).sort()).toEqual(["req-1", "req-2"]);
    });

    it("returns copies (caller mutation does not affect store)", async () => {
      await store.create(makeEntry("req-1"));
      const list = await store.listAll();
      (list[0] as PendingApproval).status = "cancelled" as never;
      expect((await store.get("req-1"))?.status).toBe("pending");
    });

    it("returns empty array when store is empty", async () => {
      expect(await store.listAll()).toHaveLength(0);
    });
  });
});
