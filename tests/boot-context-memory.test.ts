/**
 * Tests for:
 *   agent-sdk/src/boot/load-agent-context.ts
 *   agent-sdk/src/boot/load-recent-memory.ts
 *
 * Coverage (loadAgentContext):
 *   returns null projectMdContent when no projectMd option
 *   loads projectMdContent from Brain when projectMd option provided
 *   falls back gracefully when projectMd query throws
 *   loads recentDecisions with correct category + tags
 *   loads domainContext with agentId + domainTags combined
 *   all queries are non-fatal (Brain throws → returns empty data)
 *   respects limit options (recentDecisionsLimit, domainContextLimit)
 *
 * Coverage (loadRecentMemory):
 *   returns empty string when Brain throws
 *   returns empty string when Brain returns no entries
 *   formats entries as "date: preview\n..."
 *   truncates long entries to maxEntryChars
 *   truncates total output to maxChars
 *   uses custom category and tags when provided
 *   defaults limit=5 when not specified
 *
 * Ref: test coverage for agent-sdk/boot/load-agent-context.ts +
 *      agent-sdk/boot/load-recent-memory.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { loadAgentContext } from "../src/boot/load-agent-context.js";
import { loadRecentMemory } from "../src/boot/load-recent-memory.js";
import type { BrainPort } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBrain(queryFn: (query: string, opts?: unknown) => Promise<unknown>): BrainPort {
  return {
    queryKnowledge: queryFn,
  } as unknown as BrainPort;
}

const SILENT_LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ─── loadAgentContext ─────────────────────────────────────────────────────────

describe("loadAgentContext", () => {
  it("returns null projectMdContent when no projectMd option", async () => {
    const brain = makeBrain(vi.fn().mockResolvedValue([]));
    const ctx = await loadAgentContext(brain, "agent1", ["tag1"], SILENT_LOGGER);
    expect(ctx.projectMdContent).toBeNull();
  });

  it("loads projectMdContent from Brain when projectMd option provided", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValue([{ content: "# FORGE.md content", created_at: "2026-05-01" }]);
    const brain = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "forge", ["forge"], SILENT_LOGGER, {
      projectMd: {
        query: "FORGE.md",
        category: "forge_config",
        tag: "forge-md",
      },
    });
    expect(ctx.projectMdContent).toBe("# FORGE.md content");
  });

  it("passes correct params for projectMd query", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([{ content: "md content" }]);
    const brain = makeBrain(queryKnowledge);
    await loadAgentContext(brain, "forge", [], SILENT_LOGGER, {
      projectMd: {
        query: "FORGE.md",
        category: "forge_config",
        tag: "forge-md",
      },
    });
    const firstCall = queryKnowledge.mock.calls[0];
    expect(firstCall[0]).toBe("FORGE.md");
    expect(firstCall[1]).toMatchObject({
      category: "forge_config",
      tags: ["forge-md"],
      limit: 1,
    });
  });

  it("falls back gracefully when projectMd query throws", async () => {
    const queryKnowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error("brain down"))
      .mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "forge", [], SILENT_LOGGER, {
      projectMd: { query: "FORGE.md", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBeNull();
  });

  it("loads recentDecisions with correct category and tags", async () => {
    const queryKnowledge = vi
      .fn()
      .mockImplementation((query: string, opts: { category?: string }) => {
        if (opts?.category === "my_decisions") {
          return Promise.resolve([{ content: "decision A", created_at: "2026-05-01" }]);
        }
        return Promise.resolve([]);
      });
    const brain = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["revenue"], SILENT_LOGGER, {
      decisionsCategory: "my_decisions",
    });
    expect(ctx.recentDecisions).toHaveLength(1);
    expect(ctx.recentDecisions[0].content).toBe("decision A");
  });

  it("loads domainContext and includes agentId in tags", async () => {
    const queryKnowledge = vi.fn().mockImplementation((query: string) => {
      if (query.includes("domain context")) {
        return Promise.resolve([{ content: "ctx entry", created_at: "2026-05-02" }]);
      }
      return Promise.resolve([]);
    });
    const brain = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "my-agent", ["tag1"], SILENT_LOGGER);
    expect(ctx.domainContext).toHaveLength(1);
    // Verify agentId + domainTags are passed as tags
    const domainCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("domain context"),
    );
    expect(domainCall[1].tags).toContain("my-agent");
    expect(domainCall[1].tags).toContain("tag1");
  });

  it("returns empty arrays when all queries fail", async () => {
    const brain = makeBrain(vi.fn().mockRejectedValue(new Error("brain down")));
    const ctx = await loadAgentContext(brain, "agent", ["tag"], SILENT_LOGGER, {
      projectMd: { query: "q", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBeNull();
    expect(ctx.recentDecisions).toHaveLength(0);
    expect(ctx.domainContext).toHaveLength(0);
  });

  it("respects recentDecisionsLimit option", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    await loadAgentContext(brain, "agent", [], SILENT_LOGGER, {
      recentDecisionsLimit: 3,
    });
    const decisionsCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("recent decisions"),
    );
    expect(decisionsCall[1].limit).toBe(3);
  });

  it("respects domainContextLimit option", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    await loadAgentContext(brain, "agent", [], SILENT_LOGGER, {
      domainContextLimit: 7,
    });
    const ctxCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("domain context"),
    );
    expect(ctxCall[1].limit).toBe(7);
  });
});

// ─── loadRecentMemory ─────────────────────────────────────────────────────────

describe("loadRecentMemory", () => {
  it("returns empty string when Brain throws", async () => {
    const brain = makeBrain(vi.fn().mockRejectedValue(new Error("down")));
    const result = await loadRecentMemory(brain, "agent1");
    expect(result).toBe("");
  });

  it("returns empty string when Brain returns no entries", async () => {
    const brain = makeBrain(vi.fn().mockResolvedValue([]));
    const result = await loadRecentMemory(brain, "agent1");
    expect(result).toBe("");
  });

  it("formats entries as 'date: content'", async () => {
    const brain = makeBrain(
      vi.fn().mockResolvedValue([{ content: "3 leads qualified", created_at: "2026-05-07" }]),
    );
    const result = await loadRecentMemory(brain, "agent1");
    expect(result).toBe("2026-05-07: 3 leads qualified");
  });

  it("uses 'unknown' when created_at is absent", async () => {
    const brain = makeBrain(vi.fn().mockResolvedValue([{ content: "something happened" }]));
    const result = await loadRecentMemory(brain, "agent1");
    expect(result).toBe("unknown: something happened");
  });

  it("truncates long entries to maxEntryChars", async () => {
    const longContent = "x".repeat(500);
    const brain = makeBrain(
      vi.fn().mockResolvedValue([{ content: longContent, created_at: "d1" }]),
    );
    const result = await loadRecentMemory(brain, "agent1", {
      maxEntryChars: 10,
    });
    expect(result).toBe(`d1: ${"x".repeat(10)}...`);
  });

  it("joins multiple entries with newlines", async () => {
    const brain = makeBrain(
      vi.fn().mockResolvedValue([
        { content: "entry1", created_at: "d1" },
        { content: "entry2", created_at: "d2" },
      ]),
    );
    const result = await loadRecentMemory(brain, "agent1");
    expect(result).toBe("d1: entry1\nd2: entry2");
  });

  it("truncates total output to maxChars", async () => {
    const brain = makeBrain(
      vi.fn().mockResolvedValue([
        { content: "a".repeat(50), created_at: "d1" },
        { content: "b".repeat(50), created_at: "d2" },
      ]),
    );
    const result = await loadRecentMemory(brain, "agent1", { maxChars: 20 });
    expect(result.length).toBe(20);
  });

  it("uses custom category and tags when provided", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    await loadRecentMemory(brain, "agent1", {
      category: "forge_outcome",
      tags: ["forge", "agent:forge-revenue"],
    });
    const call = queryKnowledge.mock.calls[0];
    expect(call[1].category).toBe("forge_outcome");
    expect(call[1].tags).toEqual(["forge", "agent:forge-revenue"]);
  });

  it("defaults to agentId as tag when no tags provided", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    await loadRecentMemory(brain, "my-agent");
    const call = queryKnowledge.mock.calls[0];
    expect(call[1].tags).toEqual(["my-agent"]);
  });

  it("passes limit=5 by default", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    await loadRecentMemory(brain, "agent1");
    expect(queryKnowledge.mock.calls[0][1].limit).toBe(5);
  });

  it("passes custom limit when provided", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const brain = makeBrain(queryKnowledge);
    await loadRecentMemory(brain, "agent1", { limit: 3 });
    expect(queryKnowledge.mock.calls[0][1].limit).toBe(3);
  });
});
