/**
 * Tests for packages/agent-sdk/src/adapters/hitl/memory-state-store.ts
 *
 * Coverage:
 *   request — stores pending entry, returns id
 *   getState — HITLNotFoundError for unknown, returns pending
 *   resolve — approved/rejected transitions, HITLNotFoundError
 *   expire — transitions pending→expired, HITLNotFoundError
 *   await — returns immediately when already resolved, returns pending on timeout
 *   _expireOverdue — expires overdue pending requests
 *
 * Ref: test coverage for agent-sdk/adapters/hitl/memory-state-store.ts (no prior tests)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MemoryHITLStateStore } from "../src/adapters/hitl/memory-state-store.js";

const req = (overrides = {}) => ({
  id: "hitl-001",
  agentId: "forge",
  action: "deploy",
  context: "sprint-700",
  deadline: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

describe("MemoryHITLStateStore", () => {
  let store: MemoryHITLStateStore;

  beforeEach(() => {
    store = new MemoryHITLStateStore();
  });

  // ── request ────────────────────────────────────────────────────────────────

  describe("request", () => {
    it("returns the request id", async () => {
      const id = await store.request(req());
      expect(id).toBe("hitl-001");
    });

    it("stores the request as pending", async () => {
      await store.request(req());
      expect(await store.getState("hitl-001")).toBe("pending");
    });
  });

  // ── getState ───────────────────────────────────────────────────────────────

  describe("getState", () => {
    it("throws HITLNotFoundError for unknown id", async () => {
      await expect(store.getState("ghost")).rejects.toMatchObject({
        name: "HITLNotFoundError",
      });
    });
  });

  // ── resolve ────────────────────────────────────────────────────────────────

  describe("resolve", () => {
    it("transitions pending→approved", async () => {
      await store.request(req());
      await store.resolve("hitl-001", "approved", "founder");
      expect(await store.getState("hitl-001")).toBe("approved");
    });

    it("transitions pending→rejected", async () => {
      await store.request(req());
      await store.resolve("hitl-001", "rejected", "founder");
      expect(await store.getState("hitl-001")).toBe("rejected");
    });

    it("throws HITLNotFoundError for unknown id", async () => {
      await expect(store.resolve("ghost", "approved", "founder")).rejects.toMatchObject({
        name: "HITLNotFoundError",
      });
    });

    it("throws when transitioning from approved (invalid transition)", async () => {
      await store.request(req());
      await store.resolve("hitl-001", "approved", "founder");
      await expect(store.resolve("hitl-001", "rejected", "founder")).rejects.toThrow();
    });
  });

  // ── expire ─────────────────────────────────────────────────────────────────

  describe("expire", () => {
    it("transitions pending→expired", async () => {
      await store.request(req());
      await store.expire("hitl-001");
      expect(await store.getState("hitl-001")).toBe("expired");
    });

    it("throws HITLNotFoundError for unknown id", async () => {
      await expect(store.expire("ghost")).rejects.toMatchObject({
        name: "HITLNotFoundError",
      });
    });
  });

  // ── await ──────────────────────────────────────────────────────────────────

  describe("await", () => {
    it("returns immediately when already approved", async () => {
      await store.request(req());
      await store.resolve("hitl-001", "approved", "f");
      const state = await store.await("hitl-001", 5000);
      expect(state).toBe("approved");
    });

    it("returns pending when timeout expires before resolution", async () => {
      await store.request(req());
      const state = await store.await("hitl-001", 50);
      expect(state).toBe("pending");
    });

    it("resolves as soon as state changes (concurrent resolve)", async () => {
      await store.request(req());
      setTimeout(() => store.resolve("hitl-001", "approved", "f"), 60);
      const state = await store.await("hitl-001", 500);
      expect(state).toBe("approved");
    });
  });

  // ── _expireOverdue ─────────────────────────────────────────────────────────

  describe("_expireOverdue", () => {
    it("expires requests whose deadline has passed", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      await store.request(req({ id: "overdue", deadline: past }));
      await store._expireOverdue();
      expect(await store.getState("overdue")).toBe("expired");
    });

    it("leaves future-deadline requests as pending", async () => {
      await store.request(req({ id: "future" }));
      await store._expireOverdue();
      expect(await store.getState("future")).toBe("pending");
    });

    it("does not re-expire already-resolved requests", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      await store.request(req({ id: "resolved", deadline: past }));
      await store.resolve("resolved", "approved", "f");
      await store._expireOverdue();
      expect(await store.getState("resolved")).toBe("approved");
    });
  });
});
