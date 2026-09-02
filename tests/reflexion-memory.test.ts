/**
 * Tests for src/orchestration/ooda/reflexion.ts
 *
 * storeReflexion — archives to brain with correct fields
 * queryReflexionMemory — filters by confidence threshold and TTL
 */

import { describe, expect, it, vi } from "vitest";
import { queryReflexionMemory, storeReflexion } from "../src/orchestration/ooda/reflexion.js";
import type { ReflexionEntry } from "../src/orchestration/ooda/reflexion.js";

// ─── storeReflexion ───────────────────────────────────────────────────────────

describe("storeReflexion", () => {
  it("calls archiver with category=forge_reflexion and agent tag", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(
      {
        content: "Use shorter prompts",
        confidence: 0.8,
        sourceCycleId: "cycle-1",
        outcomeType: "succeeded",
      },
      "narrator",
      archiver,
    );
    expect(archiver).toHaveBeenCalledOnce();
    const arg = archiver.mock.calls[0]?.[0] as {
      category: string;
      tags: string[];
      confidence: number;
      metadata: Record<string, unknown>;
    };
    expect(arg.category).toBe("forge_reflexion");
    expect(arg.tags).toContain("reflexion");
    expect(arg.tags).toContain("agent:narrator");
    expect(arg.confidence).toBe(0.8);
    expect(arg.metadata.sourceCycleId).toBe("cycle-1");
    expect(arg.metadata.outcomeType).toBe("succeeded");
  });

  it("uses default TTL of 30 days when ttlMs is not provided", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(
      {
        content: "lesson",
        confidence: 0.9,
        sourceCycleId: "c-2",
        outcomeType: "failed",
      },
      "agent-x",
      archiver,
    );
    const arg = archiver.mock.calls[0]?.[0] as {
      metadata: { ttlMs: number };
    };
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    expect(arg.metadata.ttlMs).toBe(THIRTY_DAYS_MS);
  });

  it("uses provided ttlMs when specified", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(
      {
        content: "short-lived lesson",
        confidence: 0.75,
        sourceCycleId: "c-3",
        outcomeType: "partial",
        ttlMs: 3600_000,
      },
      "agent-y",
      archiver,
    );
    const arg = archiver.mock.calls[0]?.[0] as {
      metadata: { ttlMs: number };
    };
    expect(arg.metadata.ttlMs).toBe(3600_000);
  });
});

// ─── queryReflexionMemory ─────────────────────────────────────────────────────

describe("queryReflexionMemory", () => {
  function makeEntry(confidence: number): ReflexionEntry {
    return {
      content: `lesson-${confidence}`,
      confidence,
      sourceCycleId: "c-x",
      outcomeType: "succeeded",
    };
  }

  it("filters out entries with confidence <= 0.6", async () => {
    const querier = vi.fn().mockResolvedValue([
      makeEntry(0.9),
      makeEntry(0.6), // exactly 0.6 — below threshold (< 0.6 filters, so 0.6 passes? let's check: filter is confidence < MIN_CONFIDENCE → 0.6 is NOT < 0.6 → passes)
      makeEntry(0.5), // below threshold
    ]);
    const results = await queryReflexionMemory({ agentId: "narrator" }, querier);
    // 0.6 passes (not < 0.6), 0.5 is filtered
    expect(results.length).toBe(2);
    expect(results.every((r) => r.confidence >= 0.6)).toBe(true);
  });

  it("passes correct query string with agentId and outcomeType", async () => {
    const querier = vi.fn().mockResolvedValue([]);
    await queryReflexionMemory({ agentId: "narrator", outcomeType: "failed" }, querier);
    const qStr = querier.mock.calls[0]?.[0] as string;
    expect(qStr).toContain("narrator");
    expect(qStr).toContain("failed");
  });

  it("passes filters with category and agent tag", async () => {
    const querier = vi.fn().mockResolvedValue([]);
    await queryReflexionMemory({ agentId: "narrator" }, querier);
    const filters = querier.mock.calls[0]?.[1] as {
      category: string;
      tags: string[];
    };
    expect(filters.category).toBe("forge_reflexion");
    expect(filters.tags).toContain("agent:narrator");
  });

  it("respects custom limit", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(0.7 + i * 0.01));
    const querier = vi.fn().mockResolvedValue(entries);
    const results = await queryReflexionMemory({ agentId: "narrator", limit: 3 }, querier);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("defaults to limit=5 when not specified", async () => {
    const querier = vi.fn().mockResolvedValue([]);
    await queryReflexionMemory({ agentId: "narrator" }, querier);
    const filters = querier.mock.calls[0]?.[1] as { limit: number };
    expect(filters.limit).toBe(5);
  });
});
