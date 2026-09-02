/**
 * tests/brain-claims.test.ts
 *
 * Sprint-895 — Claims plane (ClaimPort), ADR-ECO-114.
 * Mirrors claim_assert / claim_query
 * (brain-protocol/docs/memory-contract-v12.md §1.4, §5).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryClaimPort, MemoryValidationError } from "../src/ports/brain.js";

describe("InMemoryClaimPort", () => {
  let claims: InMemoryClaimPort;

  beforeEach(() => {
    claims = new InMemoryClaimPort();
  });

  describe("assert()", () => {
    it("nominal: asserts a claim and returns its id", async () => {
      const id = await claims.assert("vauban-server", "is-a", "single-node k3s cluster", {
        confidence: 0.95,
      });
      expect(typeof id).toBe("string");

      const results = await claims.query({ subject: "vauban-server" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id,
        subject: "vauban-server",
        predicate: "is-a",
        object: "single-node k3s cluster",
        confidence: 0.95,
        claimSource: "agent_inference",
        claimStatus: "active",
        scope: "private",
      });
    });

    it("edge: defaults confidence to 0.8, claimSource to agent_inference, scope to private", async () => {
      await claims.assert("subject-x", "predicate-y");
      const [claim] = await claims.query({ subject: "subject-x" });
      expect(claim.confidence).toBe(0.8);
      expect(claim.claimSource).toBe("agent_inference");
      expect(claim.scope).toBe("private");
      expect(claim.object).toBeUndefined();
    });

    it("edge: honors explicit claimSource, validFrom/validUntil, entryId, agentId, scope", async () => {
      await claims.assert("subject-full", "predicate-full", "object-full", {
        claimSource: "human_input",
        validFrom: "2026-07-06T00:00:00Z",
        validUntil: "2026-12-31T00:00:00Z",
        entryId: "11111111-1111-1111-1111-111111111111",
        agentId: "agent-42",
        scope: "shared",
      });
      const [claim] = await claims.query({ subject: "subject-full" });
      expect(claim).toMatchObject({
        claimSource: "human_input",
        validFrom: "2026-07-06T00:00:00Z",
        validUntil: "2026-12-31T00:00:00Z",
        entryId: "11111111-1111-1111-1111-111111111111",
        agentId: "agent-42",
        scope: "shared",
      });
    });

    it("error: rejects an empty subject", async () => {
      await expect(claims.assert("", "predicate")).rejects.toThrow(MemoryValidationError);
    });

    it("error: rejects an empty predicate", async () => {
      await expect(claims.assert("subject", "  ")).rejects.toThrow(MemoryValidationError);
    });
  });

  describe("query()", () => {
    beforeEach(async () => {
      await claims.assert("alice", "knows", "bob", { confidence: 0.9, agentId: "agent-1" });
      await claims.assert("alice", "knows", "carol", { confidence: 0.5, agentId: "agent-2" });
      await claims.assert("dave", "knows", "alice", { confidence: 0.7, agentId: "agent-1" });
    });

    it("nominal: filters by subject", async () => {
      const results = await claims.query({ subject: "alice" });
      expect(results).toHaveLength(2);
      expect(results.every((c) => c.subject === "alice")).toBe(true);
    });

    it("nominal: orders by confidence DESC", async () => {
      const results = await claims.query({ subject: "alice" });
      expect(results[0].object).toBe("bob"); // confidence 0.9
      expect(results[1].object).toBe("carol"); // confidence 0.5
    });

    it("edge: filters by predicate and object combined", async () => {
      const results = await claims.query({ predicate: "knows", object: "alice" });
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("dave");
    });

    it("edge: filters by agentId", async () => {
      const results = await claims.query({ predicate: "knows", agentId: "agent-2" });
      expect(results).toHaveLength(1);
      expect(results[0].object).toBe("carol");
    });

    it("edge: respects limit", async () => {
      const results = await claims.query({ predicate: "knows", limit: 1 });
      expect(results).toHaveLength(1);
    });

    it("edge: claimStatus defaults to active and finds nothing for a disputed-only store", async () => {
      const results = await claims.query({ subject: "alice", claimStatus: "disputed" });
      expect(results).toEqual([]);
    });

    it("edge: returns [] for a subject with no claims", async () => {
      expect(await claims.query({ subject: "unknown-subject" })).toEqual([]);
    });

    it("edge: sort tie-breaks by createdAt DESC when confidence is equal", async () => {
      const tieClaims = new InMemoryClaimPort();
      await tieClaims.assert("tie-subject", "predicate", "older", { confidence: 0.7 });
      await new Promise((r) => setTimeout(r, 5));
      await tieClaims.assert("tie-subject", "predicate", "newer", { confidence: 0.7 });

      const results = await tieClaims.query({ subject: "tie-subject" });
      expect(results.map((c) => c.object)).toEqual(["newer", "older"]);
    });

    it("error: rejects a filter with none of subject/predicate/object/agentId", async () => {
      await expect(claims.query({})).rejects.toThrow(MemoryValidationError);
      await expect(claims.query({ limit: 5, claimStatus: "active" })).rejects.toThrow(
        MemoryValidationError,
      );
    });

    it("agentId-only query returns that agent's claims (sprint-936 claims-filter-relax)", async () => {
      // Seeded above: agent-1 asserted 2 of the 3 claims.
      const results = await claims.query({ agentId: "agent-1", limit: 5 });
      expect(results).toHaveLength(2);
      expect(results.every((c) => c.agentId === "agent-1")).toBe(true);
    });
  });
});
