/**
 * Tests for packages/agent-sdk/src/adapters/hitl/memory-state-store.ts
 *
 * Coverage:
 *   request      — stores entry, returns id
 *   getState     — returns 'pending' after request; throws HITLNotFoundError for unknown id
 *   resolve      — pending → approved | rejected; throws on illegal transitions
 *   expire       — pending → expired; throws on illegal transitions
 *   await        — polls until state leaves 'pending'; returns immediately if already resolved
 *   _expireOverdue — expires all overdue pending entries
 *   HITLNotFoundError / InvalidStateTransitionError — error shape
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryHITLStateStore } from "../src/adapters/hitl/memory-state-store.js";
import { HITLNotFoundError, InvalidStateTransitionError } from "../src/ports/hitl.js";
import type { HITLRequest } from "../src/ports/hitl.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeRequest(id = "req-1", deadlineOffsetMs = 60_000): HITLRequest {
  return {
    id,
    agentSource: "agent-1",
    question: "Approve the transaction?",
    context: { amount: 100 },
    options: ["approve", "reject"],
    deadline: new Date(Date.now() + deadlineOffsetMs).toISOString(),
    channel: "slack",
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("MemoryHITLStateStore", () => {
  let store: MemoryHITLStateStore;

  beforeEach(() => {
    store = new MemoryHITLStateStore();
  });

  // ── request ───────────────────────────────────────────────────────────────

  describe("request", () => {
    it("stores the request and returns its id", async () => {
      const id = await store.request(makeRequest("req-1"));
      expect(id).toBe("req-1");
    });

    it("state is 'pending' immediately after request", async () => {
      await store.request(makeRequest("req-1"));
      expect(await store.getState("req-1")).toBe("pending");
    });

    it("allows multiple independent requests with different ids", async () => {
      await store.request(makeRequest("req-a"));
      await store.request(makeRequest("req-b"));
      expect(await store.getState("req-a")).toBe("pending");
      expect(await store.getState("req-b")).toBe("pending");
    });
  });

  // ── getState ──────────────────────────────────────────────────────────────

  describe("getState", () => {
    it("throws HITLNotFoundError for unknown id", async () => {
      await expect(store.getState("ghost")).rejects.toBeInstanceOf(HITLNotFoundError);
    });

    it("HITLNotFoundError contains the missing id in its message", async () => {
      const err = await store.getState("missing-42").catch((e) => e);
      expect(err).toBeInstanceOf(HITLNotFoundError);
      expect(err.message).toContain("missing-42");
    });

    it("HITLNotFoundError is an instance of Error", async () => {
      const err = await store.getState("not-here").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
    });

    it("HITLNotFoundError exposes the id field", async () => {
      const err = await store.getState("bad-id").catch((e) => e);
      expect((err as HITLNotFoundError).id).toBe("bad-id");
    });
  });

  // ── resolve ───────────────────────────────────────────────────────────────

  describe("resolve", () => {
    it("transitions pending → approved", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "approved", "founder");
      expect(await store.getState("req-1")).toBe("approved");
    });

    it("transitions pending → rejected", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "rejected", "founder");
      expect(await store.getState("req-1")).toBe("rejected");
    });

    it("throws HITLNotFoundError for unknown id", async () => {
      await expect(store.resolve("ghost", "approved", "founder")).rejects.toBeInstanceOf(
        HITLNotFoundError,
      );
    });

    it("throws InvalidStateTransitionError when resolving an already-approved request", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "approved", "founder");
      await expect(store.resolve("req-1", "rejected", "founder")).rejects.toBeInstanceOf(
        InvalidStateTransitionError,
      );
    });

    it("throws InvalidStateTransitionError when resolving an already-rejected request", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "rejected", "founder");
      await expect(store.resolve("req-1", "approved", "founder")).rejects.toBeInstanceOf(
        InvalidStateTransitionError,
      );
    });

    it("throws InvalidStateTransitionError when resolving an expired request", async () => {
      await store.request(makeRequest("req-1"));
      await store.expire("req-1");
      await expect(store.resolve("req-1", "approved", "founder")).rejects.toBeInstanceOf(
        InvalidStateTransitionError,
      );
    });

    it("multiple independent requests are resolved independently", async () => {
      await store.request(makeRequest("req-a"));
      await store.request(makeRequest("req-b"));
      await store.resolve("req-a", "approved", "founder");
      expect(await store.getState("req-a")).toBe("approved");
      expect(await store.getState("req-b")).toBe("pending");
    });
  });

  // ── expire ────────────────────────────────────────────────────────────────

  describe("expire", () => {
    it("transitions pending → expired", async () => {
      await store.request(makeRequest("req-1"));
      await store.expire("req-1");
      expect(await store.getState("req-1")).toBe("expired");
    });

    it("throws HITLNotFoundError for unknown id", async () => {
      await expect(store.expire("ghost")).rejects.toBeInstanceOf(HITLNotFoundError);
    });

    it("throws InvalidStateTransitionError when expiring an already-expired request", async () => {
      await store.request(makeRequest("req-1"));
      await store.expire("req-1");
      await expect(store.expire("req-1")).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });

    it("throws InvalidStateTransitionError when expiring an approved request", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "approved", "founder");
      await expect(store.expire("req-1")).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });
  });

  // ── await ─────────────────────────────────────────────────────────────────

  describe("await", () => {
    it("returns 'approved' after resolve is called concurrently", async () => {
      await store.request(makeRequest("req-1"));
      // Resolve after a short delay in the background
      const resolveAfterDelay = async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        await store.resolve("req-1", "approved", "founder");
      };
      const [state] = await Promise.all([store.await("req-1", 2_000), resolveAfterDelay()]);
      expect(state).toBe("approved");
    });

    it("returns 'rejected' after reject is called concurrently", async () => {
      await store.request(makeRequest("req-1"));
      const rejectAfterDelay = async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        await store.resolve("req-1", "rejected", "founder");
      };
      const [state] = await Promise.all([store.await("req-1", 2_000), rejectAfterDelay()]);
      expect(state).toBe("rejected");
    });

    it("returns the state immediately if already resolved before await is called", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "approved", "founder");
      const state = await store.await("req-1", 1_000);
      expect(state).toBe("approved");
    });

    it("returns 'pending' after timeout if request was never resolved", async () => {
      await store.request(makeRequest("req-1"));
      const state = await store.await("req-1", 150);
      expect(state).toBe("pending");
    });

    it("throws HITLNotFoundError if id does not exist", async () => {
      await expect(store.await("ghost", 100)).rejects.toBeInstanceOf(HITLNotFoundError);
    });
  });

  // ── _expireOverdue ────────────────────────────────────────────────────────

  describe("_expireOverdue", () => {
    it("expires all pending entries whose deadline has passed", async () => {
      // deadline in the past
      await store.request(makeRequest("req-past", -1_000));
      await store._expireOverdue();
      expect(await store.getState("req-past")).toBe("expired");
    });

    it("leaves pending entries with a future deadline untouched", async () => {
      await store.request(makeRequest("req-future", 60_000));
      await store._expireOverdue();
      expect(await store.getState("req-future")).toBe("pending");
    });

    it("does not affect already-resolved entries", async () => {
      await store.request(makeRequest("req-past", -1_000));
      await store.resolve("req-past", "approved", "founder");
      await store._expireOverdue();
      // Should remain approved, not become expired
      expect(await store.getState("req-past")).toBe("approved");
    });

    it("handles an empty store without throwing", async () => {
      await expect(store._expireOverdue()).resolves.toBeUndefined();
    });
  });

  // ── Full lifecycle ────────────────────────────────────────────────────────

  describe("full lifecycle", () => {
    it("request → resolve(approved) → expire throws (approved is terminal for expire)", async () => {
      await store.request(makeRequest("req-1"));
      await store.resolve("req-1", "approved", "founder");
      await expect(store.expire("req-1")).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });

    it("request → expire → resolve throws (expired is terminal)", async () => {
      await store.request(makeRequest("req-1"));
      await store.expire("req-1");
      await expect(store.resolve("req-1", "approved", "founder")).rejects.toBeInstanceOf(
        InvalidStateTransitionError,
      );
    });

    it("two requests with same id overwrite each other (last write wins)", async () => {
      // The store uses Map.set which replaces on duplicate key
      await store.request(makeRequest("req-x"));
      await store.resolve("req-x", "approved", "founder");
      // Re-request with the same id resets state to pending
      await store.request(makeRequest("req-x"));
      expect(await store.getState("req-x")).toBe("pending");
    });
  });
});
