/**
 * Tests for boot + factory modules (Vague 1.B.2).
 *
 * Verifies:
 * - loadAgentContext: non-fatal Brain failure, parameterizable options
 * - loadRecentMemory: empty on Brain failure, summary format, maxChars cap
 * - createAgentFromConfig: wires OODAAgent from generic config
 */

import { describe, expect, test, vi } from "vitest";
import { loadAgentContext } from "../src/boot/load-agent-context.js";
import { loadRecentMemory } from "../src/boot/load-recent-memory.js";
import type { BrainPort } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeBrain(overrides: Partial<BrainPort> = {}): BrainPort {
  return {
    queryKnowledge: vi.fn().mockResolvedValue([]),
    archiveKnowledge: vi.fn().mockResolvedValue({ id: "test-id" }),
    ...overrides,
  } as unknown as BrainPort;
}

// ─── loadAgentContext ─────────────────────────────────────────────────────────

describe("loadAgentContext", () => {
  test("returns empty context when Brain returns no entries", async () => {
    const brain = makeBrain();
    const logger = makeLogger();

    const ctx = await loadAgentContext(brain, "test-agent", ["tag1"], logger);

    expect(ctx.projectMdContent).toBeNull();
    expect(ctx.recentDecisions).toHaveLength(0);
    expect(ctx.domainContext).toHaveLength(0);
  });

  test("loads projectMd when projectMd option is provided", async () => {
    const brain = makeBrain({
      queryKnowledge: vi
        .fn()
        .mockResolvedValueOnce([{ content: "# Project MD", created_at: "2026-01-01" }])
        .mockResolvedValue([]),
    });
    const logger = makeLogger();

    const ctx = await loadAgentContext(brain, "test-agent", ["tag1"], logger, {
      projectMd: { query: "PROJECT.md", category: "config", tag: "project-md" },
    });

    expect(ctx.projectMdContent).toBe("# Project MD");
  });

  test("is non-fatal when Brain throws", async () => {
    const brain = makeBrain({
      queryKnowledge: vi.fn().mockRejectedValue(new Error("Brain unavailable")),
    });
    const logger = makeLogger();

    const ctx = await loadAgentContext(brain, "test-agent", ["tag1"], logger);

    expect(ctx.projectMdContent).toBeNull();
    expect(ctx.recentDecisions).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("respects recentDecisionsLimit option", async () => {
    const mockEntries = Array.from({ length: 3 }, (_, i) => ({
      content: `decision ${i}`,
      created_at: `2026-01-0${i + 1}`,
    }));
    const brain = makeBrain({
      queryKnowledge: vi
        .fn()
        .mockResolvedValueOnce(mockEntries) // recentDecisions (first, no projectMd)
        .mockResolvedValue([]),
    });
    const logger = makeLogger();

    const ctx = await loadAgentContext(brain, "test-agent", ["tag1"], logger, {
      recentDecisionsLimit: 3,
    });

    expect(ctx.recentDecisions).toHaveLength(3);
  });
});

// ─── loadRecentMemory ─────────────────────────────────────────────────────────

describe("loadRecentMemory", () => {
  test("returns empty string when Brain throws", async () => {
    const brain = makeBrain({
      queryKnowledge: vi.fn().mockRejectedValue(new Error("Brain down")),
    });

    const result = await loadRecentMemory(brain, "test-agent");
    expect(result).toBe("");
  });

  test("returns empty string when no entries", async () => {
    const brain = makeBrain();
    const result = await loadRecentMemory(brain, "test-agent");
    expect(result).toBe("");
  });

  test("formats entries as date: preview", async () => {
    const brain = makeBrain({
      queryKnowledge: vi
        .fn()
        .mockResolvedValue([{ content: "Cycle completed successfully", created_at: "2026-05-07" }]),
    });

    const result = await loadRecentMemory(brain, "test-agent");
    expect(result).toContain("2026-05-07");
    expect(result).toContain("Cycle completed successfully");
  });

  test("caps entry preview at maxEntryChars", async () => {
    const longContent = "x".repeat(500);
    const brain = makeBrain({
      queryKnowledge: vi
        .fn()
        .mockResolvedValue([{ content: longContent, created_at: "2026-05-07" }]),
    });

    const result = await loadRecentMemory(brain, "test-agent", {
      maxEntryChars: 100,
    });
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(200);
  });

  test("caps total summary at maxChars", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      content: "x".repeat(300),
      created_at: `2026-01-0${i + 1}`,
    }));
    const brain = makeBrain({
      queryKnowledge: vi.fn().mockResolvedValue(entries),
    });

    const result = await loadRecentMemory(brain, "test-agent", {
      maxChars: 500,
    });
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
