/**
 * buildT0MemoryBlock — T0 stable cacheable prefix block tests.
 *
 * ADR-ECO-065, sprint-805 Task 2.
 *
 * CACHE-SAFETY INVARIANT (Brain a8e8423a / arXiv:2601.06007):
 *   T0 block = stable, cacheable prefix (decisions, patterns — slow-changing).
 *   Per-query recall = dynamic orient zone only (renderMemoryContext).
 *   These MUST NOT be mixed.
 *
 * Coverage:
 *   1. Brain unavailable → empty block (entryCount=0, text="")
 *   2. Brain throws per category → skipped, others included
 *   3. Default categories = ["decision", "pattern"]
 *   4. Custom categories forwarded to queryKnowledge
 *   5. Entries formatted as "[category] date: preview"
 *   6. maxEntryChars truncation per entry
 *   7. maxChars budget respected for total text
 *   8. entryCount reflects included entries (not fetched)
 *   9. assembledAt is a valid ISO string
 *  10. text wrapped in <stable_memory> tags
 *  11. Default tags=[agentId] forwarded to queryKnowledge
 *  12. Custom tags override default
 *  13. limitPerCategory forwarded per category query
 *  14. Empty brain per all categories → empty block
 *  15. T0 text is NOT an empty string when entries exist (sanity)
 *  16. Multiple categories produce separate entries with category labels
 */

import { describe, expect, it, vi } from "vitest";
import { buildT0MemoryBlock } from "../src/boot/load-recent-memory.js";
import type { BrainEntry, BrainPort } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(content: string, created_at = "2026-05-01T00:00:00Z", id = "e0"): BrainEntry {
  return { id, content, created_at };
}

/**
 * Build a BrainPort mock where queryKnowledge returns entries based on the
 * `category` option. Per-category overrides supported via `byCategory`.
 */
function makeBrain(opts: {
  byCategory?: Record<string, BrainEntry[]>;
  defaultEntries?: BrainEntry[];
  throws?: Record<string, unknown>;
}): BrainPort {
  const { byCategory = {}, defaultEntries = [], throws = {} } = opts;
  const queryKnowledge = vi.fn(async (_query: string, params?: Record<string, unknown>) => {
    const cat = (params as { category?: string })?.category ?? "__default__";
    if (throws[cat]) throw throws[cat];
    return byCategory[cat] ?? defaultEntries;
  });
  return { queryKnowledge } as unknown as BrainPort;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildT0MemoryBlock (ADR-ECO-065, sprint-805 Task 2)", () => {
  // 1. Brain unavailable (all queries throw) → empty block
  it("returns empty block when Brain throws on all categories", async () => {
    const brain = makeBrain({
      throws: {
        decision: new Error("brain down"),
        pattern: new Error("brain down"),
      },
    });
    const block = await buildT0MemoryBlock(brain, "agent-x");
    expect(block.text).toBe("");
    expect(block.entryCount).toBe(0);
  });

  // 2. Brain throws on one category, returns on another → others included
  it("skips failing category and includes entries from succeeding categories", async () => {
    const brain = makeBrain({
      byCategory: {
        decision: [makeEntry("important decision", "2026-05-01", "d0")],
      },
      throws: { pattern: new Error("pattern category down") },
    });
    const block = await buildT0MemoryBlock(brain, "agent-x", {
      categories: ["decision", "pattern"],
    });
    expect(block.entryCount).toBeGreaterThan(0);
    expect(block.text).toContain("important decision");
    expect(block.text).not.toContain("pattern category down");
  });

  // 3. Default categories include "decision" and "pattern"
  it("queries 'decision' and 'pattern' categories by default", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    await buildT0MemoryBlock(brain, "agent-y");
    const calls = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls;
    const queriedCategories = calls.map((c: unknown[]) => (c[1] as { category: string })?.category);
    expect(queriedCategories).toContain("decision");
    expect(queriedCategories).toContain("pattern");
  });

  // 4. Custom categories forwarded to queryKnowledge
  it("queries only specified custom categories", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    await buildT0MemoryBlock(brain, "agent-y", {
      categories: ["architecture", "config"],
    });
    const calls = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls;
    const queriedCategories = calls.map((c: unknown[]) => (c[1] as { category: string })?.category);
    expect(queriedCategories).toContain("architecture");
    expect(queriedCategories).toContain("config");
    expect(queriedCategories).not.toContain("decision");
    expect(queriedCategories).not.toContain("pattern");
  });

  // 5. Entries formatted as "[category] date: preview"
  it("formats entries as '[category] date: content'", async () => {
    const brain = makeBrain({
      byCategory: {
        decision: [makeEntry("use Redis for caching", "2026-05-10", "d1")],
        pattern: [],
      },
    });
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
    });
    expect(block.text).toContain("[decision]");
    expect(block.text).toContain("2026-05-10");
    expect(block.text).toContain("use Redis for caching");
  });

  // 6. maxEntryChars truncation per entry
  it("truncates entry content to maxEntryChars and appends '...'", async () => {
    const brain = makeBrain({
      byCategory: {
        decision: [makeEntry("x".repeat(200), "2026-05-01", "d0")],
        pattern: [],
      },
    });
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
      maxEntryChars: 30,
    });
    // The entry preview should be at most 30 chars + "..."
    expect(block.text).toContain(`${"x".repeat(30)}...`);
    expect(block.text).not.toContain("x".repeat(31));
  });

  // 7. maxChars budget respected for total text
  it("stops adding entries once maxChars budget is exhausted", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry("a".repeat(100), "2026-05-01", `e${i}`),
    );
    const brain = makeBrain({
      byCategory: { decision: entries, pattern: [] },
    });
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
      maxChars: 200,
    });
    expect(block.text.length).toBeLessThanOrEqual(200);
  });

  // 8. entryCount reflects how many entries were actually included
  it("entryCount reflects included entries, not fetched entries", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry("a".repeat(50), "2026-05-01", `e${i}`),
    );
    const brain = makeBrain({
      byCategory: { decision: entries, pattern: entries },
    });
    // With a large budget, all 10 should be included
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
      maxChars: 10_000,
    });
    expect(block.entryCount).toBe(10);
  });

  // 9. assembledAt is a valid ISO string
  it("assembledAt is a valid ISO date string", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    const block = await buildT0MemoryBlock(brain, "agent-z");
    expect(() => new Date(block.assembledAt)).not.toThrow();
    expect(new Date(block.assembledAt).toISOString()).toBe(block.assembledAt);
  });

  // 10. text wrapped in <stable_memory> tags when non-empty
  it("wraps content in <stable_memory> tags when entries exist", async () => {
    const brain = makeBrain({
      byCategory: {
        decision: [makeEntry("some decision", "2026-05-01", "d0")],
        pattern: [],
      },
    });
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
    });
    expect(block.text).toMatch(/^<stable_memory>/);
    expect(block.text).toMatch(/<\/stable_memory>$/);
  });

  // 11. Default tags=[agentId] forwarded to queryKnowledge
  it("uses [agentId] as default tags in queries", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    await buildT0MemoryBlock(brain, "my-agent");
    const calls = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      expect((call[1] as { tags: string[] })?.tags).toContain("my-agent");
    }
  });

  // 12. Custom tags override default agentId tags
  it("uses custom tags when provided, not agentId", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    await buildT0MemoryBlock(brain, "my-agent", {
      tags: ["trading", "nq"],
    });
    const calls = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      const tags = (call[1] as { tags: string[] })?.tags;
      expect(tags).toContain("trading");
      expect(tags).toContain("nq");
      expect(tags).not.toContain("my-agent");
    }
  });

  // 13. limitPerCategory forwarded per category query
  it("passes limitPerCategory to each category query", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision"],
      limitPerCategory: 7,
    });
    const calls = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ limit: 7 });
  });

  // 14. All categories return empty → empty block
  it("returns empty block when all categories return empty entries", async () => {
    const brain = makeBrain({ defaultEntries: [] });
    const block = await buildT0MemoryBlock(brain, "agent-z");
    expect(block.text).toBe("");
    expect(block.entryCount).toBe(0);
  });

  // 15. Non-empty text when entries exist
  it("returns non-empty text when at least one entry exists", async () => {
    const brain = makeBrain({
      byCategory: {
        decision: [makeEntry("critical decision", "2026-05-01", "d0")],
        pattern: [],
      },
    });
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
    });
    expect(block.text.length).toBeGreaterThan(0);
    expect(block.entryCount).toBeGreaterThan(0);
  });

  // 16. Multiple categories produce entries with their respective labels
  it("labels entries with their source category", async () => {
    const brain = makeBrain({
      byCategory: {
        decision: [makeEntry("decision entry", "2026-05-01", "d0")],
        pattern: [makeEntry("pattern entry", "2026-05-02", "p0")],
      },
    });
    const block = await buildT0MemoryBlock(brain, "agent-z", {
      categories: ["decision", "pattern"],
    });
    expect(block.text).toContain("[decision]");
    expect(block.text).toContain("[pattern]");
    expect(block.text).toContain("decision entry");
    expect(block.text).toContain("pattern entry");
  });
});
