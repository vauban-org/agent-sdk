/**
 * Tests for BrainConversationConnector (BRAIN-01).
 *
 * Coverage:
 *   - createBrainCompactionLlmFn: calls localLlmFn, archives, returns summary
 *   - createBrainCompactionLlmFn: fail-soft when archive() throws
 *   - createBrainCompactionLlmFn: archived entry has correct category + sessionTag
 *   - restoreSessionContext: null when no entries (recall path)
 *   - restoreSessionContext: formatted string with header (recall path)
 *   - restoreSessionContext: joins multiple entries with separator (recall path)
 *   - restoreSessionContext: null if recall throws (fail-soft)
 *   - restoreSessionContext: respects topK/limit parameter (recall path)
 *   - restoreSessionContext: uses tier:'fast' (not agentic) for session-restore
 *   - restoreSessionContext: fallback to query() when recall() is absent
 *   - restoreSessionContext: null if query throws in fallback (fail-soft)
 *
 * @see ../src/conversation/brain-connector.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  createBrainCompactionLlmFn,
  restoreSessionContext,
} from "../src/conversation/brain-connector.js";
import type { RecallOptions, RecallResult, SemanticMemoryPort } from "../src/ports/brain.js";
import { InMemorySemanticMemory } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal RecallResult with the given content strings as chunks. */
function makeRecallResult(contents: string[]): RecallResult {
  return {
    chunks: contents.map((content, i) => ({
      id: `chunk-${i}`,
      content,
      hybrid_score: null,
      cross_encoder_score: null,
      similarity: 0.9,
      category: "session-compaction",
      tags: ["session-compaction"],
      created_at: new Date().toISOString(),
      brain_id: null,
      brain_slug: null,
    })),
    answer: null,
    strategy_used: "single-shot",
    hops_used: 1,
    refs: contents.map((_, i) => `chunk-${i}`),
    freshness: [],
  };
}

const EMPTY_RECALL_RESULT: RecallResult = {
  chunks: [],
  answer: null,
  strategy_used: "degraded",
  hops_used: 0,
  refs: [],
  freshness: [],
};

describe("createBrainCompactionLlmFn", () => {
  it("calls localLlmFn with the prompt and returns its result", async () => {
    const memory = new InMemorySemanticMemory();
    const localLlmFn = vi.fn().mockResolvedValue("summary text");
    const fn = createBrainCompactionLlmFn(memory, localLlmFn, "session-abc");

    const result = await fn("some prompt");

    expect(localLlmFn).toHaveBeenCalledOnce();
    expect(localLlmFn).toHaveBeenCalledWith("some prompt");
    expect(result).toBe("summary text");
  });

  it("archives the summary to semantic memory", async () => {
    const memory = new InMemorySemanticMemory();
    const localLlmFn = vi.fn().mockResolvedValue("archived summary");
    const fn = createBrainCompactionLlmFn(memory, localLlmFn, "session-xyz");

    await fn("prompt");

    const entries = await memory.query("archived summary");
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("archived summary");
  });

  it("archived entry has category 'session-compaction'", async () => {
    const memory = new InMemorySemanticMemory();
    const localLlmFn = vi.fn().mockResolvedValue("my summary");
    const fn = createBrainCompactionLlmFn(memory, localLlmFn, "run-001");

    await fn("prompt");

    const entries = await memory.query("my summary");
    expect(entries.length).toBe(1);
    expect(entries[0].category).toBe("session-compaction");
  });

  it("archived entry includes sessionTag in tags", async () => {
    const memory = new InMemorySemanticMemory();
    const localLlmFn = vi.fn().mockResolvedValue("tagged summary");
    const fn = createBrainCompactionLlmFn(memory, localLlmFn, "run-tag-42");

    await fn("prompt");

    const entries = await memory.query("tagged summary");
    expect(entries.length).toBe(1);
    expect(entries[0].tags).toContain("run-tag-42");
    expect(entries[0].tags).toContain("session-compaction");
  });

  it("is fail-soft: still returns summary if archive() throws", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "archive").mockRejectedValue(new Error("Brain unavailable"));
    const localLlmFn = vi.fn().mockResolvedValue("safe summary");
    const fn = createBrainCompactionLlmFn(memory, localLlmFn, "session-fail");

    // Must not throw
    const result = await fn("prompt");

    expect(result).toBe("safe summary");
  });

  it("archives multiple summaries independently across calls", async () => {
    const memory = new InMemorySemanticMemory();
    const localLlmFn = vi
      .fn()
      .mockResolvedValueOnce("first summary")
      .mockResolvedValueOnce("second summary");
    const fn = createBrainCompactionLlmFn(memory, localLlmFn, "multi-session");

    await fn("prompt 1");
    await fn("prompt 2");

    const firstEntries = await memory.query("first summary");
    const secondEntries = await memory.query("second summary");
    expect(firstEntries.length).toBe(1);
    expect(secondEntries.length).toBe(1);
    expect(firstEntries[0].content).toBe("first summary");
    expect(secondEntries[0].content).toBe("second summary");
  });
});

describe("restoreSessionContext", () => {
  // ── recall() path (port-aligned, ADR-ECO-065) ─────────────────────────────
  // InMemorySemanticMemory exposes recall(), so all tests below exercise the
  // new port-aligned path. recall() is mocked to return controlled RecallResult
  // objects (InMemorySemanticMemory.recall() delegates to brainRecall() which
  // requires BRAIN_URL — mocking avoids the env dependency in unit tests).

  it("returns null when recall returns no chunks", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "recall").mockResolvedValue(EMPTY_RECALL_RESULT);

    const result = await restoreSessionContext(memory, "session-empty");
    expect(result).toBeNull();
  });

  it("returns a formatted string with the '## Long-term context' header", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "recall").mockResolvedValue(makeRecallResult(["prior session summary"]));

    const result = await restoreSessionContext(memory, "session-abc");

    expect(result).not.toBeNull();
    expect(result).toContain("## Long-term context (from prior sessions)");
    expect(result).toContain("prior session summary");
  });

  it("joins multiple chunks with '---' separator", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "recall").mockResolvedValue(
      makeRecallResult(["first prior summary", "second prior summary"]),
    );

    const result = await restoreSessionContext(memory, "proj-multi");

    expect(result).not.toBeNull();
    expect(result).toContain("first prior summary");
    expect(result).toContain("second prior summary");
    expect(result).toContain("---");
  });

  it("returns null if recall throws (fail-soft)", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "recall").mockRejectedValue(new Error("Brain down"));

    const result = await restoreSessionContext(memory, "session-fail");

    expect(result).toBeNull();
  });

  it("respects the limit parameter (passed as topK to recall)", async () => {
    const memory = new InMemorySemanticMemory();
    const recallSpy = vi
      .spyOn(memory, "recall")
      .mockResolvedValue(makeRecallResult(["summary 1", "summary 2"]));

    const result = await restoreSessionContext(memory, "proj-limit", 2);

    expect(result).not.toBeNull();
    // Verify topK=2 was forwarded to recall()
    expect(recallSpy).toHaveBeenCalledWith(
      "session-compaction",
      expect.objectContaining({ topK: 2 }),
    );
    // 2 chunks → 1 separator
    const separatorCount = (result ?? "").split("---").length - 1;
    expect(separatorCount).toBe(1);
  });

  it("uses tier:'fast' (never agentic) for session-restore", async () => {
    const memory = new InMemorySemanticMemory();
    const recallSpy = vi.spyOn(memory, "recall").mockResolvedValue(makeRecallResult(["ctx"]));

    await restoreSessionContext(memory, "run-xyz");

    expect(recallSpy).toHaveBeenCalledWith(
      "session-compaction",
      expect.objectContaining({ tier: "fast" }),
    );
    // Must NOT be 'agentic' or 'auto' — those add multi-hop overhead
    const opts = recallSpy.mock.calls[0][1] as RecallOptions;
    expect(opts.tier).toBe("fast");
  });

  it("passes the sessionTag in the tags filter to recall()", async () => {
    const memory = new InMemorySemanticMemory();
    const recallSpy = vi.spyOn(memory, "recall").mockResolvedValue(makeRecallResult(["ctx"]));

    await restoreSessionContext(memory, "my-run-id");

    const opts = recallSpy.mock.calls[0][1] as RecallOptions;
    expect(opts.tags).toContain("session-compaction");
    expect(opts.tags).toContain("my-run-id");
  });

  it("result starts with the header line", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "recall").mockResolvedValue(makeRecallResult(["context content"]));

    const result = await restoreSessionContext(memory, "sess-header");

    expect(result).not.toBeNull();
    expect((result ?? "").startsWith("## Long-term context")).toBe(true);
  });

  // ── fallback path: implementations without recall() ───────────────────────
  // When SemanticMemoryPort does not expose recall(), restoreSessionContext
  // falls back to the legacy .query() path (backward-compat).

  it("falls back to query() when recall() is not defined on the port", async () => {
    // Minimal SemanticMemoryPort with NO recall() method
    const legacyMemory: SemanticMemoryPort = {
      query: vi.fn().mockResolvedValue([
        {
          id: "e1",
          content: "legacy session summary",
          category: "session-compaction",
          tags: ["session-compaction", "legacy-run"],
        },
      ]),
      archive: vi.fn().mockResolvedValue(null),
      // recall intentionally absent
    };

    const result = await restoreSessionContext(legacyMemory, "legacy-run");

    expect(legacyMemory.query).toHaveBeenCalledWith(
      "session-compaction",
      expect.objectContaining({
        tags: ["session-compaction", "legacy-run"],
      }),
    );
    expect(result).toContain("legacy session summary");
    expect(result).toContain("## Long-term context");
  });

  it("returns null if query() throws in the fallback path (fail-soft)", async () => {
    const legacyMemory: SemanticMemoryPort = {
      query: vi.fn().mockRejectedValue(new Error("Brain down")),
      archive: vi.fn().mockResolvedValue(null),
    };

    const result = await restoreSessionContext(legacyMemory, "session-fail");

    expect(result).toBeNull();
  });

  it("returns null when memory is empty for the given sessionTag", async () => {
    const memory = new InMemorySemanticMemory();
    vi.spyOn(memory, "recall").mockResolvedValue(EMPTY_RECALL_RESULT);

    const result = await restoreSessionContext(memory, "session-nobody");
    expect(result).toBeNull();
  });
});
