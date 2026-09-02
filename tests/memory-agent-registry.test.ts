/**
 * Tests for packages/agent-sdk/src/adapters/registry/memory.ts
 *
 * Coverage:
 *   register — upsert behavior
 *   list — no filter, id/product/trigger/tenantId filters
 *   resolve — capability match, tenant scoping (exact + global), no match
 *   unregister — removes by id, no-op for unknown
 *
 * Ref: test coverage for agent-sdk/adapters/registry/memory.ts (no prior tests)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAgentRegistry } from "../src/adapters/registry/memory.js";

const agent = (
  overrides: Partial<{
    id: string;
    product: string;
    trigger: string;
    tenantId?: string;
    capabilities: string[];
  }> = {},
) => ({
  id: "agent-1",
  product: "forge",
  trigger: "webhook",
  capabilities: ["brain.query"],
  ...overrides,
});

describe("MemoryAgentRegistry", () => {
  let registry: MemoryAgentRegistry;

  beforeEach(() => {
    registry = new MemoryAgentRegistry();
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe("register", () => {
    it("adds a new agent", async () => {
      await registry.register(agent());
      const list = await registry.list();
      expect(list).toHaveLength(1);
    });

    it("upserts an existing agent by id", async () => {
      await registry.register(agent({ product: "forge" }));
      await registry.register(agent({ product: "bastion" }));
      const list = await registry.list();
      expect(list).toHaveLength(1);
      expect(list[0].product).toBe("bastion");
    });

    it("stores a copy (immutable from caller side)", async () => {
      const desc = agent();
      await registry.register(desc);
      desc.product = "mutated";
      const [stored] = await registry.list();
      expect(stored.product).toBe("forge");
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    beforeEach(async () => {
      await registry.register(agent({ id: "a1", product: "forge", trigger: "webhook" }));
      await registry.register(
        agent({
          id: "a2",
          product: "bastion",
          trigger: "cron",
          tenantId: "tenant-1",
        }),
      );
      await registry.register(agent({ id: "a3", product: "forge", trigger: "cron" }));
    });

    it("returns all agents when no filter", async () => {
      expect(await registry.list()).toHaveLength(3);
    });

    it("filters by product", async () => {
      const results = await registry.list({ product: "forge" });
      expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["a1", "a3"]));
      expect(results).toHaveLength(2);
    });

    it("filters by id", async () => {
      const results = await registry.list({ id: "a2" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a2");
    });

    it("filters by trigger", async () => {
      const results = await registry.list({ trigger: "cron" });
      expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["a2", "a3"]));
    });

    it("filters by tenantId", async () => {
      const results = await registry.list({ tenantId: "tenant-1" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a2");
    });

    it("returns copies (immutable from caller side)", async () => {
      const [desc] = await registry.list();
      desc.product = "mutated";
      const [again] = await registry.list();
      expect(again.product).toBe("forge");
    });
  });

  // ── resolve ───────────────────────────────────────────────────────────────

  describe("resolve", () => {
    beforeEach(async () => {
      await registry.register(
        agent({
          id: "global-1",
          capabilities: ["brain.query"],
          tenantId: undefined,
        }),
      );
      await registry.register(
        agent({
          id: "tenant-1",
          capabilities: ["brain.query"],
          tenantId: "acme",
        }),
      );
      await registry.register(
        agent({
          id: "other-tenant",
          capabilities: ["brain.query"],
          tenantId: "other",
        }),
      );
      await registry.register(agent({ id: "no-cap", capabilities: ["hitl.approve"] }));
    });

    it("returns all agents with capability when no tenantId filter", async () => {
      const results = await registry.resolve("brain.query");
      const ids = results.map((r) => r.id);
      expect(ids).toContain("global-1");
      expect(ids).toContain("tenant-1");
      expect(ids).toContain("other-tenant");
      expect(ids).not.toContain("no-cap");
    });

    it("filters by tenantId — includes exact match + global agents", async () => {
      const results = await registry.resolve("brain.query", {
        tenantId: "acme",
      });
      const ids = results.map((r) => r.id);
      expect(ids).toContain("global-1");
      expect(ids).toContain("tenant-1");
      expect(ids).not.toContain("other-tenant");
    });

    it("returns empty array when capability not found", async () => {
      const results = await registry.resolve("nonexistent.cap");
      expect(results).toHaveLength(0);
    });
  });

  // ── unregister ────────────────────────────────────────────────────────────

  describe("unregister", () => {
    it("removes a registered agent", async () => {
      await registry.register(agent({ id: "del-me" }));
      await registry.unregister("del-me");
      expect(await registry.list()).toHaveLength(0);
    });

    it("is a no-op for an unknown id", async () => {
      await expect(registry.unregister("ghost")).resolves.toBeUndefined();
    });
  });
});
