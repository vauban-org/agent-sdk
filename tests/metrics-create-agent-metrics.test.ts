/**
 * Tests for createAgentMetrics (Vague 1.B.4).
 *
 * Covers:
 * - No-op fallback when prom-client is absent (mock module removal)
 * - Metric registration with default prefix "agent_"
 * - Metric registration with custom prefix (e.g. "forge_")
 * - Snapshot of metric names/labels (Grafana dashboard regression guard)
 * - Registry isolation (two calls with distinct registries do not collide)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reset the module-level _prom cache in create-agent-metrics so each test
 * starts fresh. We do this by re-importing the module via vi.resetModules().
 */
async function importFactory() {
  const mod = await import(`../src/metrics/create-agent-metrics.js?v=${Math.random()}`);
  return mod as typeof import("../src/metrics/create-agent-metrics.js");
}

// ─── Suite: no-op fallback (prom-client absent) ───────────────────────────────

describe("createAgentMetrics — no-op fallback", () => {
  it("returns an object with all 8 metric keys when prom-client is absent", async () => {
    // Simulate prom-client missing by mocking the module loader.
    // We monkey-patch the _prom cache directly via module internals.
    // Because the loader uses createRequire lazily, we can intercept by
    // providing a module that throws on require("prom-client").
    vi.mock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "prom-client") throw new Error("MODULE_NOT_FOUND");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(id);
      },
    }));

    vi.resetModules();
    const { createAgentMetrics } = await import("../src/metrics/create-agent-metrics.js");

    const m = createAgentMetrics();

    const keys: (keyof typeof m)[] = [
      "cycleStarted",
      "cycleCompleted",
      "cycleDuration",
      "hitlRequested",
      "hitlResolved",
      "llmCallCount",
      "llmTokensUsed",
      "llmCostUsd",
    ];
    for (const key of keys) {
      expect(m[key], `${key} should be defined`).toBeDefined();
    }

    vi.unmock("node:module");
    vi.resetModules();
  });

  it("no-op counter.inc() does not throw", async () => {
    vi.mock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "prom-client") throw new Error("MODULE_NOT_FOUND");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(id);
      },
    }));
    vi.resetModules();

    const { createAgentMetrics } = await import("../src/metrics/create-agent-metrics.js");
    const m = createAgentMetrics();

    expect(() => m.cycleStarted.inc({ agent_id: "test" })).not.toThrow();
    expect(() => m.cycleCompleted.inc({ agent_id: "test", outcome: "success" })).not.toThrow();
    expect(() => m.cycleDuration.observe({ agent_id: "test", phase: "total" }, 42)).not.toThrow();

    vi.unmock("node:module");
    vi.resetModules();
  });
});

// ─── Suite: with prom-client ──────────────────────────────────────────────────

describe("createAgentMetrics — with prom-client", () => {
  let Registry: typeof import("prom-client")["Registry"];

  beforeEach(async () => {
    // Check if prom-client is available in the test environment
    try {
      const pc = await import("prom-client");
      Registry = pc.Registry;
    } catch {
      // prom-client not available — skip real metric tests
    }
  });

  it("registers metrics under default prefix agent_", async () => {
    let pc: typeof import("prom-client");
    try {
      pc = await import("prom-client");
    } catch {
      // prom-client absent — skip
      return;
    }

    const { createAgentMetrics } = await import("../src/metrics/create-agent-metrics.js");
    const registry = new pc.Registry();
    const _m = createAgentMetrics({ registry });

    const metrics = await registry.getMetricsAsJSON();
    const names = metrics.map((m: { name: string }) => m.name);

    expect(names).toContain("agent_cycle_started_total");
    expect(names).toContain("agent_cycle_completed_total");
    expect(names).toContain("agent_cycle_duration_ms");
    expect(names).toContain("agent_hitl_requested_total");
    expect(names).toContain("agent_hitl_resolved_total");
    expect(names).toContain("agent_llm_calls_total");
    expect(names).toContain("agent_llm_tokens_total");
    expect(names).toContain("agent_llm_cost_usd_total");
  });

  it("registers metrics under custom prefix forge_", async () => {
    let pc: typeof import("prom-client");
    try {
      pc = await import("prom-client");
    } catch {
      return;
    }

    const { createAgentMetrics } = await import("../src/metrics/create-agent-metrics.js");
    const registry = new pc.Registry();
    const _m = createAgentMetrics({ registry, prefix: "forge_" });

    const metrics = await registry.getMetricsAsJSON();
    const names = metrics.map((m: { name: string }) => m.name);

    // Snapshot: Grafana dashboard uses these exact names
    expect(names).toContain("forge_cycle_started_total");
    expect(names).toContain("forge_cycle_completed_total");
    expect(names).toContain("forge_cycle_duration_ms");
    expect(names).toContain("forge_hitl_requested_total");
    expect(names).toContain("forge_hitl_resolved_total");
    expect(names).toContain("forge_llm_calls_total");
    expect(names).toContain("forge_llm_tokens_total");
    expect(names).toContain("forge_llm_cost_usd_total");
  });

  it("labels snapshot — cycle_completed has agent_id and outcome", async () => {
    let pc: typeof import("prom-client");
    try {
      pc = await import("prom-client");
    } catch {
      return;
    }

    const { createAgentMetrics } = await import("../src/metrics/create-agent-metrics.js");
    const registry = new pc.Registry();
    const m = createAgentMetrics({ registry });

    m.cycleCompleted.inc({ agent_id: "a1", outcome: "success" });
    m.cycleCompleted.inc({ agent_id: "a1", outcome: "error" });

    const metrics = await registry.getMetricsAsJSON();
    const completed = metrics.find(
      (x: { name: string }) => x.name === "agent_cycle_completed_total",
    );
    expect(completed).toBeDefined();

    // Each value carries both labels
    const values: Array<{ labels: Record<string, string>; value: number }> = completed.values;
    const successRow = values.find((v) => v.labels.outcome === "success");
    expect(successRow).toBeDefined();
    expect(successRow?.labels.agent_id).toBe("a1");
    expect(successRow?.value).toBe(1);

    const errorRow = values.find((v) => v.labels.outcome === "error");
    expect(errorRow?.value).toBe(1);
  });

  it("registry isolation — two calls do not cross-contaminate", async () => {
    let pc: typeof import("prom-client");
    try {
      pc = await import("prom-client");
    } catch {
      return;
    }

    const { createAgentMetrics } = await import("../src/metrics/create-agent-metrics.js");
    const r1 = new pc.Registry();
    const r2 = new pc.Registry();

    createAgentMetrics({ registry: r1, prefix: "svc1_" });
    createAgentMetrics({ registry: r2, prefix: "svc2_" });

    const names1 = (await r1.getMetricsAsJSON()).map((m: { name: string }) => m.name);
    const names2 = (await r2.getMetricsAsJSON()).map((m: { name: string }) => m.name);

    expect(names1.every((n: string) => n.startsWith("svc1_"))).toBe(true);
    expect(names2.every((n: string) => n.startsWith("svc2_"))).toBe(true);
    expect(names1.some((n: string) => n.startsWith("svc2_"))).toBe(false);
  });
});
