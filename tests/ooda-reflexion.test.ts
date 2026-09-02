/**
 * tests/ooda-reflexion.test.ts
 *
 * Unit tests for OODA reflexion memory pure functions.
 *
 * Covers:
 *   - storeReflexion() — correct archiver call shape
 *   - queryReflexionMemory() — confidence filtering + limit slicing
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ReflexionEntry,
  type ReflexionQuery,
  queryReflexionMemory,
  storeReflexion,
} from "../src/orchestration/ooda/reflexion.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function entry(overrides: Partial<ReflexionEntry> = {}): ReflexionEntry {
  return {
    content: "Always validate inputs before acting",
    confidence: 0.8,
    sourceCycleId: "cycle-001",
    outcomeType: "succeeded",
    ...overrides,
  };
}

// ─── storeReflexion ───────────────────────────────────────────────────────────

describe("storeReflexion", () => {
  it("calls archiver with correct category and tags", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(entry(), "agent-42", archiver);
    expect(archiver).toHaveBeenCalledOnce();
    const call = archiver.mock.calls[0]![0];
    expect(call.category).toBe("forge_reflexion");
    expect(call.tags).toContain("reflexion");
    expect(call.tags).toContain("agent:agent-42");
  });

  it("forwards entry content verbatim to archiver", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    const e = entry({ content: "unique lesson text" });
    await storeReflexion(e, "agent-1", archiver);
    expect(archiver.mock.calls[0]![0].content).toBe("unique lesson text");
  });

  it("forwards confidence to archiver", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(entry({ confidence: 0.95 }), "agent-1", archiver);
    expect(archiver.mock.calls[0]![0].confidence).toBe(0.95);
  });

  it("stores sourceCycleId in metadata", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(entry({ sourceCycleId: "cycle-xyz" }), "agent-1", archiver);
    expect(archiver.mock.calls[0]![0].metadata?.sourceCycleId).toBe("cycle-xyz");
  });

  it("stores outcomeType in metadata", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(entry({ outcomeType: "failed" }), "agent-1", archiver);
    expect(archiver.mock.calls[0]![0].metadata?.outcomeType).toBe("failed");
  });

  it("uses default ttlMs (30 days) when not provided", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(entry(), "agent-1", archiver);
    const ttl = archiver.mock.calls[0]![0].metadata?.ttlMs as number;
    expect(ttl).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("uses explicit ttlMs when provided", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    const customTtl = 7 * 24 * 60 * 60 * 1000; // 7 days
    await storeReflexion(entry({ ttlMs: customTtl }), "agent-1", archiver);
    expect(archiver.mock.calls[0]![0].metadata?.ttlMs).toBe(customTtl);
  });

  it("embeds agentId in tags (different agents get different tags)", async () => {
    const archiver = vi.fn().mockResolvedValue(undefined);
    await storeReflexion(entry(), "agent-A", archiver);
    await storeReflexion(entry(), "agent-B", archiver);
    expect(archiver.mock.calls[0]![0].tags).toContain("agent:agent-A");
    expect(archiver.mock.calls[1]![0].tags).toContain("agent:agent-B");
  });
});

// ─── queryReflexionMemory ─────────────────────────────────────────────────────

describe("queryReflexionMemory", () => {
  it("filters out entries with confidence < 0.6", async () => {
    const low: ReflexionEntry = entry({ confidence: 0.59 });
    const high: ReflexionEntry = entry({ confidence: 0.7 });
    const querier = vi.fn().mockResolvedValue([low, high]);
    const results = await queryReflexionMemory({ agentId: "agent-1" }, querier);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe(0.7);
  });

  it("keeps entries with confidence === 0.6 (boundary — strict < 0.6 filter)", async () => {
    const borderline: ReflexionEntry = entry({ confidence: 0.6 });
    const querier = vi.fn().mockResolvedValue([borderline]);
    const results = await queryReflexionMemory({ agentId: "agent-1" }, querier);
    expect(results).toHaveLength(1);
  });

  it("filters out entries with confidence exactly at boundary (0.6 passes, 0.59 rejected)", async () => {
    const rejected: ReflexionEntry = entry({ confidence: 0.59 });
    const querier = vi.fn().mockResolvedValue([rejected]);
    const results = await queryReflexionMemory({ agentId: "agent-1" }, querier);
    expect(results).toHaveLength(0);
  });

  it("respects explicit limit in query", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ content: `lesson ${i}`, confidence: 0.8 }),
    );
    const querier = vi.fn().mockResolvedValue(entries);
    const results = await queryReflexionMemory({ agentId: "agent-1", limit: 3 }, querier);
    expect(results).toHaveLength(3);
  });

  it("defaults limit to 5 when not provided", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ content: `lesson ${i}`, confidence: 0.8 }),
    );
    const querier = vi.fn().mockResolvedValue(entries);
    const results = await queryReflexionMemory({ agentId: "agent-1" }, querier);
    expect(results).toHaveLength(5);
  });

  it("passes correct filters to querier including agentId tag", async () => {
    const querier = vi.fn().mockResolvedValue([]);
    await queryReflexionMemory({ agentId: "agent-X" }, querier);
    const filters = querier.mock.calls[0]![1];
    expect(filters?.tags).toContain("reflexion");
    expect(filters?.tags).toContain("agent:agent-X");
  });

  it("passes category forge_reflexion to querier", async () => {
    const querier = vi.fn().mockResolvedValue([]);
    await queryReflexionMemory({ agentId: "agent-1" }, querier);
    const filters = querier.mock.calls[0]![1];
    expect(filters?.category).toBe("forge_reflexion");
  });

  it("returns empty array when all querier results are below confidence threshold", async () => {
    const entries = [entry({ confidence: 0.1 }), entry({ confidence: 0.4 })];
    const querier = vi.fn().mockResolvedValue(entries);
    const results = await queryReflexionMemory({ agentId: "agent-1" }, querier);
    expect(results).toHaveLength(0);
  });
});
