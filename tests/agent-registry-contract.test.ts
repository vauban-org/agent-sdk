/**
 * AgentRegistryPort contract tests.
 *
 * The `agentRegistryContract` function is a shared test suite that any
 * AgentRegistryPort implementation can be verified against.
 *
 * Applied here to:
 *   - MemoryAgentRegistry (full suite, no DB required)
 *   - PostgresAgentRegistry (mocked DbPort — verifies query logic compiles
 *     and wires correctly; SQL correctness is covered by integration tests)
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryAgentRegistry } from "../src/adapters/registry/memory.js";
import { PostgresAgentRegistry } from "../src/adapters/registry/postgres.js";
import type { AgentDescriptor, AgentRegistryPort } from "../src/ports/agent-registry.js";
import type { DbPort } from "../src/ports/db.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE: AgentDescriptor = {
  id: "forge:01-revenue",
  product: "forge",
  capabilities: ["content-generation", "market-analysis"],
  inputSchema: { type: "object", properties: { topic: { type: "string" } } },
  trigger: "event",
};

const TENANT_AGENT: AgentDescriptor = {
  id: "cc:tenant-scoped",
  product: "cc",
  capabilities: ["content-generation"],
  inputSchema: { type: "object" },
  trigger: "webhook",
  tenantId: "11111111-1111-1111-1111-111111111111",
};

const OTHER_TENANT_AGENT: AgentDescriptor = {
  id: "cc:other-tenant",
  product: "cc",
  capabilities: ["content-generation"],
  inputSchema: { type: "object" },
  trigger: "webhook",
  tenantId: "22222222-2222-2222-2222-222222222222",
};

// ─── Contract suite ───────────────────────────────────────────────────────────

/**
 * Shared contract. Pass a factory that returns a fresh registry instance.
 * Each test gets a clean registry via `beforeEach`.
 */
export const agentRegistryContract = (factory: () => AgentRegistryPort) => {
  let registry: AgentRegistryPort;

  beforeEach(() => {
    registry = factory();
  });

  describe("AgentRegistryPort contract", () => {
    test("register + list returns the registered agent", async () => {
      await registry.register(BASE);
      const all = await registry.list();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: BASE.id, product: BASE.product });
    });

    test("register is idempotent on same id (upsert)", async () => {
      await registry.register(BASE);
      const updated: AgentDescriptor = { ...BASE, product: "vauban" };
      await registry.register(updated);
      const all = await registry.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.product).toBe("vauban");
    });

    test("list with filter narrows results", async () => {
      await registry.register(BASE);
      await registry.register({
        ...BASE,
        id: "vauban:builder",
        product: "vauban",
      });

      const forgeOnly = await registry.list({ product: "forge" });
      expect(forgeOnly).toHaveLength(1);
      expect(forgeOnly[0]?.id).toBe("forge:01-revenue");
    });

    test("resolve('content-generation') returns matching agents", async () => {
      await registry.register(BASE);
      await registry.register({
        ...BASE,
        id: "vauban:no-cap",
        capabilities: ["other-cap"],
      });

      const matches = await registry.resolve("content-generation");
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.every((d) => d.capabilities.includes("content-generation"))).toBe(true);
    });

    test("resolve with tenantId scopes to that tenant only", async () => {
      // Global agent (no tenantId) + tenant agent + other-tenant agent
      await registry.register(BASE); // global
      await registry.register(TENANT_AGENT);
      await registry.register(OTHER_TENANT_AGENT);

      const results = await registry.resolve("content-generation", {
        tenantId: "11111111-1111-1111-1111-111111111111",
      });

      const ids = results.map((d) => d.id);
      expect(ids).toContain("forge:01-revenue"); // global included
      expect(ids).toContain("cc:tenant-scoped"); // exact tenant
      expect(ids).not.toContain("cc:other-tenant"); // other tenant excluded
    });

    test("unregister removes the agent", async () => {
      await registry.register(BASE);
      await registry.unregister(BASE.id);
      const all = await registry.list();
      expect(all.find((d) => d.id === BASE.id)).toBeUndefined();
    });

    test("unregister is a no-op for unknown id (does not throw)", async () => {
      await expect(registry.unregister("nonexistent:agent")).resolves.toBeUndefined();
    });
  });
};

// ─── Apply contract to MemoryAgentRegistry ───────────────────────────────────

describe("MemoryAgentRegistry", () => {
  agentRegistryContract(() => new MemoryAgentRegistry());
});

// ─── PostgresAgentRegistry — mocked DbPort unit tests ────────────────────────

describe("PostgresAgentRegistry (mocked db)", () => {
  function makeMockDb(): DbPort {
    return {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
  }

  test("register calls INSERT ... ON CONFLICT with correct params", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.register(BASE);

    expect(db.query).toHaveBeenCalledOnce();
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain("ON CONFLICT");
    expect(params[0]).toBe(BASE.id);
    expect(params[1]).toBe(BASE.product);
  });

  test("list without filter issues SELECT without WHERE", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.list();

    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sql).not.toContain("WHERE");
  });

  test("list with product filter adds WHERE product = $1", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.list({ product: "forge" });

    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain("product =");
    expect(params).toContain("forge");
  });

  test("resolve uses @> array containment operator", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.resolve("content-generation");

    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sql).toContain("@>");
    expect(sql).toContain("ARRAY[");
  });

  test("resolve with tenantId calls set_config first", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.resolve("content-generation", {
      tenantId: "11111111-1111-1111-1111-111111111111",
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    const firstCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(firstCall[0]).toContain("set_config");
  });

  test("unregister calls DELETE WHERE id = $1", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.unregister("forge:01-revenue");

    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain("DELETE FROM agent_registry");
    expect(params[0]).toBe("forge:01-revenue");
  });

  test("register SQL includes last_seen = NOW() in INSERT and ON CONFLICT", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.register(BASE);

    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sql).toContain("last_seen");
    expect(sql).toContain("NOW()");
    expect(sql).toContain("ON CONFLICT");
  });

  test("list SELECT includes last_seen column", async () => {
    const db = makeMockDb();
    const registry = new PostgresAgentRegistry(db);
    await registry.list();

    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sql).toContain("last_seen");
  });
});
