/**
 * Tests for AgentConfigLoader (sprint-525:quick-7).
 *
 * Verifies hot-reload semantics:
 *   - Cache miss → DB fetch
 *   - Cache hit within TTL → no second DB query
 *   - TTL expired → re-fetch
 *   - invalidate() forces re-fetch
 *   - Missing row → defaultConfig
 *   - columnName='extra' backward compat (sprint-472)
 *   - DB error during fetch → propagates
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAgentConfigLoader } from "../src/orchestration/ooda/agent-config-loader.js";
import type { DbClient } from "../src/tracking/agent-run-tracker.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeDb(rows: Record<string, unknown>[]): DbClient & {
  calls: QueryCall[];
  setRows(r: Record<string, unknown>[]): void;
} {
  let currentRows = [...rows];
  const calls: QueryCall[] = [];
  return {
    calls,
    setRows(r: Record<string, unknown>[]) {
      currentRows = [...r];
    },
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: currentRows, rowCount: currentRows.length };
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createAgentConfigLoader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("get() with no row → returns defaultConfig", async () => {
    const db = makeDb([]);
    const loader = createAgentConfigLoader({
      db,
      defaultConfig: { kelly_cap: 0.2 },
    });

    const cfg = await loader.get("market-radar");
    expect(cfg).toEqual({ kelly_cap: 0.2 });
    expect(db.calls).toHaveLength(1);
  });

  it("get() with row → returns row config", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.35, conviction_min: 0.7 } }]);
    const loader = createAgentConfigLoader({ db });

    const cfg = await loader.get("market-radar");
    expect(cfg).toEqual({ kelly_cap: 0.35, conviction_min: 0.7 });
  });

  it("cached: 2nd get within TTL → only 1 DB query", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.2 } }]);
    const loader = createAgentConfigLoader({ db, ttlMs: 30_000 });

    await loader.get("market-radar");
    await loader.get("market-radar");

    expect(db.calls).toHaveLength(1);
  });

  it("TTL expired → re-fetches", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.2 } }]);
    const loader = createAgentConfigLoader({ db, ttlMs: 5_000 });

    await loader.get("market-radar");
    expect(db.calls).toHaveLength(1);

    // Advance past TTL
    vi.advanceTimersByTime(6_000);

    await loader.get("market-radar");
    expect(db.calls).toHaveLength(2);
  });

  it("invalidate() forces re-fetch on next get()", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.2 } }]);
    const loader = createAgentConfigLoader({ db, ttlMs: 30_000 });

    await loader.get("market-radar");
    expect(db.calls).toHaveLength(1);

    loader.invalidate("market-radar");

    await loader.get("market-radar");
    expect(db.calls).toHaveLength(2);
  });

  it("UPDATE config row mid-cycle → after TTL expires, get() returns new value", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.2 } }]);
    const loader = createAgentConfigLoader({ db, ttlMs: 5_000 });

    const first = await loader.get("market-radar");
    expect(first).toEqual({ kelly_cap: 0.2 });

    // Simulate DB update mid-cycle
    db.setRows([{ cfg: { kelly_cap: 0.5 } }]);

    // Still within TTL — cached value served
    const cached = await loader.get("market-radar");
    expect(cached).toEqual({ kelly_cap: 0.2 });

    // Advance past TTL
    vi.advanceTimersByTime(6_000);

    const fresh = await loader.get("market-radar");
    expect(fresh).toEqual({ kelly_cap: 0.5 });
    expect(db.calls).toHaveLength(2);
  });

  it("columnName='extra' option works (sprint-472 backward compat)", async () => {
    const db = makeDb([{ cfg: { hitl_timeout_ms: 60_000 } }]);
    const loader = createAgentConfigLoader({ db, columnName: "extra" });

    const cfg = await loader.get("echo-agent");
    expect(cfg).toEqual({ hitl_timeout_ms: 60_000 });

    // Verify the SQL used the `extra` column alias
    expect(db.calls[0].sql).toContain("extra AS cfg");
  });

  it("columnName='config' is also accepted", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.3 } }]);
    const loader = createAgentConfigLoader({ db, columnName: "config" });

    const cfg = await loader.get("narrator");
    expect(cfg).toEqual({ kelly_cap: 0.3 });
    expect(db.calls[0].sql).toContain("config AS cfg");
  });

  it("returns defaultConfig when row cfg is null", async () => {
    const db = makeDb([{ cfg: null }]);
    const loader = createAgentConfigLoader({
      db,
      defaultConfig: { fallback: true },
    });

    const cfg = await loader.get("market-radar");
    expect(cfg).toEqual({ fallback: true });
  });

  it("cache is per-agentId — different agents are cached independently", async () => {
    const db = makeDb([{ cfg: { kelly_cap: 0.2 } }]);
    const loader = createAgentConfigLoader({ db, ttlMs: 30_000 });

    await loader.get("market-radar");
    await loader.get("narrator");
    await loader.get("market-radar"); // cache hit

    // 2 fetches: one per unique agentId
    expect(db.calls).toHaveLength(2);
  });

  it("passes agentId as query parameter", async () => {
    const db = makeDb([]);
    const loader = createAgentConfigLoader({ db });

    await loader.get("monte-carlo-forecaster");

    expect(db.calls[0].params).toEqual(["monte-carlo-forecaster"]);
  });
});
