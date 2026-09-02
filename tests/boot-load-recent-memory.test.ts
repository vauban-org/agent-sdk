/**
 * Dedicated unit tests for:
 *   agent-sdk/src/boot/load-recent-memory.ts
 *
 * Coverage:
 *  1. Empty brain → returns ''
 *  2. Brain throws → returns '' (never propagates)
 *  3. Single entry → returns content
 *  4. Multiple entries → all content present
 *  5. maxChars truncation
 *  6. maxEntryChars truncation per entry
 *  7. limit param forwarded to brain.queryKnowledge
 *  8. Default limit = 5
 *  9. category param forwarded
 * 10. Default category = 'outcome'
 * 11. tags param forwarded
 * 12. Default tags = [agentId]
 * 13. Return type is string
 * 14. Non-empty string for 1 entry
 * 15. brain.queryKnowledge called exactly once
 * 16. agentId in default tags
 * 17. Multiple entries produce multiline string
 * 18. First entry appears first in result
 * 19. Truncated entries end with '...'
 * 20. Brain returning null/undefined entries → returns ''
 * 21. Entry with created_at undefined → 'unknown' date
 * 22. Entry with empty content → formats correctly
 * 23. maxChars=0 → returns ''
 * 24. BrainRateLimitError thrown → returns '' (non-fatal)
 * 25. Custom tags override default agentId tag
 */

import { describe, expect, it, vi } from "vitest";
import { loadRecentMemory } from "../src/boot/load-recent-memory.js";
import type { BrainEntry, BrainPort } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(content: string, created_at?: string, id = "entry-0"): BrainEntry {
  return {
    id,
    content,
    created_at,
  };
}

function makeBrain(entries: BrainEntry[] = [], opts: { throws?: unknown } = {}): BrainPort {
  const queryKnowledge = opts.throws
    ? vi.fn().mockRejectedValue(opts.throws)
    : vi.fn().mockResolvedValue(entries);

  return {
    queryKnowledge,
    archiveKnowledge: vi.fn().mockResolvedValue({ id: "arch-0", content: "" }),
  } as unknown as BrainPort;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("loadRecentMemory", () => {
  // 1. Empty brain → returns ''
  it("returns empty string when Brain returns no entries", async () => {
    const brain = makeBrain([]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result).toBe("");
  });

  // 2. Brain throws → returns '' (never propagates)
  it("returns empty string and does not throw when Brain rejects", async () => {
    const brain = makeBrain([], { throws: new Error("network error") });
    await expect(loadRecentMemory(brain, "agent-1")).resolves.toBe("");
  });

  // 3. Single entry → returns a string containing the entry content
  it("returns a string containing the entry content for a single entry", async () => {
    const brain = makeBrain([makeEntry("cycle completed", "2026-05-01")]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result).toContain("cycle completed");
  });

  // 4. Multiple entries → all content present
  it("includes content from all entries when multiple entries returned", async () => {
    const brain = makeBrain([
      makeEntry("entry A", "2026-05-01", "e0"),
      makeEntry("entry B", "2026-05-02", "e1"),
      makeEntry("entry C", "2026-05-03", "e2"),
    ]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result).toContain("entry A");
    expect(result).toContain("entry B");
    expect(result).toContain("entry C");
  });

  // 5. maxChars truncation
  it("truncates total result to maxChars", async () => {
    const brain = makeBrain([
      makeEntry("a".repeat(100), "d1", "e0"),
      makeEntry("b".repeat(100), "d2", "e1"),
    ]);
    const result = await loadRecentMemory(brain, "agent-1", { maxChars: 30 });
    expect(result.length).toBe(30);
  });

  // 6. maxEntryChars truncation per entry
  it("truncates each entry content to maxEntryChars", async () => {
    const brain = makeBrain([makeEntry("x".repeat(100), "d1")]);
    const result = await loadRecentMemory(brain, "agent-1", {
      maxEntryChars: 20,
    });
    // "d1: " + 20 x's + "..."
    expect(result).toBe(`d1: ${"x".repeat(20)}...`);
  });

  // 7. limit=2 with 5 entries → only 2 requested from brain
  it("passes limit to brain.queryKnowledge", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "agent-1", { limit: 2 });
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].limit).toBe(2);
  });

  // 8. Default limit=5 passed to brain.query
  it("uses default limit of 5 when not specified", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "agent-1");
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].limit).toBe(5);
  });

  // 9. category param passed to brain.query
  it("forwards custom category to brain.queryKnowledge", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "agent-1", { category: "forge_outcome" });
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].category).toBe("forge_outcome");
  });

  // 10. Default category='outcome'
  it("uses 'outcome' as default category", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "agent-1");
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].category).toBe("outcome");
  });

  // 11. tags param passed to brain.query
  it("forwards custom tags to brain.queryKnowledge", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "agent-1", {
      tags: ["forge", "agent:forge-revenue"],
    });
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].tags).toEqual(["forge", "agent:forge-revenue"]);
  });

  // 12. Default tags includes agentId
  it("uses [agentId] as default tags when not specified", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "my-agent");
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].tags).toEqual(["my-agent"]);
  });

  // 13. Return type is string
  it("always returns a string", async () => {
    const brain = makeBrain([]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(typeof result).toBe("string");
  });

  // 14. Non-empty string for 1 entry
  it("returns a non-empty string for one entry", async () => {
    const brain = makeBrain([makeEntry("something happened", "2026-05-10")]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result.length).toBeGreaterThan(0);
  });

  // 15. brain.queryKnowledge called exactly once
  it("calls brain.queryKnowledge exactly once", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "agent-1");
    expect((brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  // 16. agentId is included in query tags
  it("includes agentId in query tags when no custom tags given", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "forge-revenue");
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].tags).toContain("forge-revenue");
  });

  // 17. Multiple entries produce multiline string
  it("produces a multiline string for multiple entries", async () => {
    const brain = makeBrain([
      makeEntry("line one", "2026-05-01", "e0"),
      makeEntry("line two", "2026-05-02", "e1"),
    ]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result.split("\n").length).toBeGreaterThan(1);
  });

  // 18. Entries are ordered (first entry appears first in summary)
  it("preserves entry order so the first entry appears first in output", async () => {
    const brain = makeBrain([
      makeEntry("FIRST entry", "2026-05-01", "e0"),
      makeEntry("SECOND entry", "2026-05-02", "e1"),
    ]);
    const result = await loadRecentMemory(brain, "agent-1");
    const indexFirst = result.indexOf("FIRST entry");
    const indexSecond = result.indexOf("SECOND entry");
    expect(indexFirst).toBeGreaterThanOrEqual(0);
    expect(indexSecond).toBeGreaterThan(indexFirst);
  });

  // 19. Content is truncated with '...' when too long (maxEntryChars)
  it("appends '...' when entry content exceeds maxEntryChars", async () => {
    const brain = makeBrain([makeEntry("z".repeat(200), "d1")]);
    const result = await loadRecentMemory(brain, "agent-1", {
      maxEntryChars: 50,
    });
    expect(result).toMatch(/\.\.\.$/);
  });

  // 20. Empty entries array from brain → returns ''
  it("returns empty string for an explicitly empty entries array", async () => {
    const brain = makeBrain([]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result).toBe("");
  });

  // 21. Entry with created_at undefined → 'unknown' date
  it("uses 'unknown' as date label when created_at is absent", async () => {
    const brain = makeBrain([{ id: "e0", content: "something happened" }]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result).toMatch(/^unknown:/);
  });

  // 22. Entry with empty content → formats correctly
  it("formats an entry with empty content without error", async () => {
    const brain = makeBrain([makeEntry("", "2026-05-01")]);
    const result = await loadRecentMemory(brain, "agent-1");
    expect(result).toBe("2026-05-01: ");
  });

  // 23. maxChars=0 → returns ''
  it("returns empty string when maxChars is 0", async () => {
    const brain = makeBrain([makeEntry("content", "2026-05-01")]);
    const result = await loadRecentMemory(brain, "agent-1", { maxChars: 0 });
    expect(result).toBe("");
  });

  // 24. BrainRateLimitError thrown → returns '' (non-fatal)
  it("returns empty string when brain.queryKnowledge throws a rate-limit error", async () => {
    const err = Object.assign(new Error("rate limited"), {
      name: "BrainRateLimitError",
      retryAfterMs: 60_000,
    });
    const brain = makeBrain([], { throws: err });
    await expect(loadRecentMemory(brain, "agent-1")).resolves.toBe("");
  });

  // 25. Custom tags override default agentId tag
  it("does not include agentId in tags when custom tags are explicitly provided", async () => {
    const brain = makeBrain([]);
    await loadRecentMemory(brain, "my-agent", { tags: ["custom-tag"] });
    const call = (brain.queryKnowledge as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].tags).toEqual(["custom-tag"]);
    expect(call[1].tags).not.toContain("my-agent");
  });
});
