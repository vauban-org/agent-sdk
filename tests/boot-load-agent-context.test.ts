/**
 * Tests for:
 *   agent-sdk/src/boot/load-agent-context.ts
 *
 * Coverage:
 *   Returns AgentContext with all three fields
 *   projectMdContent is null when no projectMd option provided
 *   projectMdContent is populated when brain returns an entry
 *   projectMdContent is null when brain returns empty array for projectMd
 *   projectMdContent is null (no throw) when brain throws on projectMd query
 *   recentDecisions populated from brain query
 *   recentDecisions is empty (no throw) when brain throws on decisions query
 *   domainContext populated from brain query
 *   domainContext is empty (no throw) when brain throws on domain context query
 *   recentDecisionsLimit is forwarded to brain query
 *   default recentDecisionsLimit=10
 *   domainContextLimit is forwarded to brain query
 *   default domainContextLimit=20
 *   decisionsCategory is forwarded to brain query
 *   default decisionsCategory='decision'
 *   Multiple brain queries are made when projectMd is provided
 *   Two brain queries are made when projectMd is omitted
 *   Each recentDecisions entry exposes content field
 *   Each domainContext entry exposes content field
 *   created_at is preserved in recentDecisions entries
 *   created_at is preserved in domainContext entries
 *   Empty brain (all queries return []) yields null/empty without throw
 *   domainTags forwarded to decisions query
 *   domainTags + agentId forwarded to domain context query
 *   logger.info called after successful context load
 *   logger.warn called when projectMd query throws
 *   logger.warn called when decisions query throws
 *   logger.warn called when domain context query throws
 *   projectMdContent uses first entry content when brain returns multiple entries
 */

import { describe, expect, it, vi } from "vitest";
import { loadAgentContext } from "../src/boot/load-agent-context.js";
import type { BrainEntry, BrainPort } from "../src/ports/brain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(content: string, created_at?: string, id?: string): BrainEntry {
  return {
    id: id ?? `id-${Math.random()}`,
    content,
    created_at,
  };
}

/**
 * Build a BrainPort mock with a spy on queryKnowledge.
 *
 * @param queryFn - Implementation called for every queryKnowledge invocation.
 */
function makeBrain(
  queryFn: (query: string, filters?: unknown) => Promise<BrainEntry[]> = vi
    .fn()
    .mockResolvedValue([]),
): { brain: BrainPort; queryKnowledge: ReturnType<typeof vi.fn> } {
  const queryKnowledge = vi.fn().mockImplementation(queryFn);
  const brain: BrainPort = {
    archiveKnowledge: vi.fn().mockResolvedValue(null),
    queryKnowledge,
  };
  return { brain, queryKnowledge };
}

function makeSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const LOGGER = makeSilentLogger();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("loadAgentContext", () => {
  // 1. Returns AgentContext with all three fields
  it("returns an AgentContext with projectMdContent, recentDecisions, domainContext", async () => {
    const { brain } = makeBrain();
    const ctx = await loadAgentContext(brain, "agent1", ["tag1"], LOGGER);
    expect(ctx).toHaveProperty("projectMdContent");
    expect(ctx).toHaveProperty("recentDecisions");
    expect(ctx).toHaveProperty("domainContext");
  });

  // 2. projectMdContent is null when no projectMd option
  it("projectMdContent is null when no projectMd option provided", async () => {
    const { brain } = makeBrain();
    const ctx = await loadAgentContext(brain, "agent1", [], LOGGER);
    expect(ctx.projectMdContent).toBeNull();
  });

  // 3. projectMdContent populated when brain returns an entry
  it("projectMdContent is the first entry content when brain returns an entry", async () => {
    const { brain } = makeBrain(vi.fn().mockResolvedValue([makeEntry("# CLAUDE.md text")]));
    const ctx = await loadAgentContext(brain, "agent1", [], LOGGER, {
      projectMd: {
        query: "CLAUDE.md",
        category: "claude_config",
        tag: "claude-md",
      },
    });
    expect(ctx.projectMdContent).toBe("# CLAUDE.md text");
  });

  // 4. projectMdContent is null when brain returns empty array for projectMd
  it("projectMdContent is null when brain returns empty array for projectMd query", async () => {
    const { brain } = makeBrain(vi.fn().mockResolvedValue([]));
    const ctx = await loadAgentContext(brain, "agent1", [], LOGGER, {
      projectMd: { query: "CLAUDE.md", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBeNull();
  });

  // 5. projectMdContent is null (no throw) when brain throws on projectMd query
  it("projectMdContent is null and does not throw when projectMd query throws", async () => {
    const queryKnowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error("brain offline"))
      .mockResolvedValue([]);
    const { brain } = makeBrain(queryKnowledge);
    const logger = makeSilentLogger();
    const ctx = await loadAgentContext(brain, "agent1", [], logger, {
      projectMd: { query: "q", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBeNull();
  });

  // 6. recentDecisions populated from brain query
  it("recentDecisions is populated from brain query", async () => {
    // No projectMd option → first call = decisions, second = domain context
    const queryKnowledge = vi
      .fn()
      .mockResolvedValueOnce([makeEntry("decision A", "2026-01-01")])
      .mockResolvedValue([]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["tag"], LOGGER);
    expect(ctx.recentDecisions).toHaveLength(1);
    expect(ctx.recentDecisions[0].content).toBe("decision A");
  });

  // 7. recentDecisions is empty (no throw) when brain throws on decisions query
  it("recentDecisions is empty array and does not throw when decisions query throws", async () => {
    let callCount = 0;
    const queryKnowledge = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail decisions"));
      return Promise.resolve([]);
    });
    const { brain } = makeBrain(queryKnowledge);
    const logger = makeSilentLogger();
    const ctx = await loadAgentContext(brain, "agent1", ["t"], logger);
    expect(ctx.recentDecisions).toEqual([]);
  });

  // 8. domainContext populated from brain query
  it("domainContext is populated from brain query", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValueOnce([]) // decisions
      .mockResolvedValueOnce([makeEntry("ctx entry", "2026-05-01")]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["t"], LOGGER);
    expect(ctx.domainContext).toHaveLength(1);
    expect(ctx.domainContext[0].content).toBe("ctx entry");
  });

  // 9. domainContext is empty (no throw) when brain throws on domain context query
  it("domainContext is empty array and does not throw when domain context query throws", async () => {
    let callCount = 0;
    const queryKnowledge = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("fail domain ctx"));
      return Promise.resolve([]);
    });
    const { brain } = makeBrain(queryKnowledge);
    const logger = makeSilentLogger();
    const ctx = await loadAgentContext(brain, "agent1", ["t"], logger);
    expect(ctx.domainContext).toEqual([]);
  });

  // 10. recentDecisionsLimit forwarded to brain query
  it("recentDecisionsLimit is forwarded to the decisions brain query", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER, {
      recentDecisionsLimit: 5,
    });
    const decisionsCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("recent decisions"),
    );
    expect(decisionsCall).toBeDefined();
    expect(decisionsCall![1]).toMatchObject({ limit: 5 });
  });

  // 11. Default recentDecisionsLimit=10
  it("defaults recentDecisionsLimit to 10 when not specified", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER);
    const decisionsCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("recent decisions"),
    );
    expect(decisionsCall![1]).toMatchObject({ limit: 10 });
  });

  // 12. domainContextLimit forwarded to brain query
  it("domainContextLimit is forwarded to the domain context brain query", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER, {
      domainContextLimit: 7,
    });
    const ctxCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("domain context"),
    );
    expect(ctxCall).toBeDefined();
    expect(ctxCall![1]).toMatchObject({ limit: 7 });
  });

  // 13. Default domainContextLimit=20
  it("defaults domainContextLimit to 20 when not specified", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER);
    const ctxCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("domain context"),
    );
    expect(ctxCall![1]).toMatchObject({ limit: 20 });
  });

  // 14. decisionsCategory forwarded to brain query
  it("decisionsCategory is forwarded to the decisions brain query", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER, {
      decisionsCategory: "forge_decision",
    });
    const decisionsCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("recent decisions"),
    );
    expect(decisionsCall![1]).toMatchObject({ category: "forge_decision" });
  });

  // 15. Default decisionsCategory='decision'
  it("defaults decisionsCategory to 'decision' when not specified", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER);
    const decisionsCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("recent decisions"),
    );
    expect(decisionsCall![1]).toMatchObject({ category: "decision" });
  });

  // 16. Three brain queries made when projectMd is provided
  it("makes 3 brain queries when projectMd option is provided", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER, {
      projectMd: {
        query: "FORGE.md",
        category: "forge_config",
        tag: "forge-md",
      },
    });
    expect(queryKnowledge).toHaveBeenCalledTimes(3);
  });

  // 17. Two brain queries made when projectMd is omitted
  it("makes 2 brain queries when projectMd option is omitted", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", [], LOGGER);
    expect(queryKnowledge).toHaveBeenCalledTimes(2);
  });

  // 18. Each recentDecisions entry has content field
  it("each recentDecisions entry exposes a content field", async () => {
    const entries = [makeEntry("d1", "2026-01-01"), makeEntry("d2", "2026-01-02")];
    const queryKnowledge = vi.fn().mockResolvedValueOnce(entries).mockResolvedValue([]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["t"], LOGGER);
    for (const d of ctx.recentDecisions) {
      expect(d).toHaveProperty("content");
      expect(typeof d.content).toBe("string");
    }
  });

  // 19. Each domainContext entry has content field
  it("each domainContext entry exposes a content field", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValueOnce([]) // decisions
      .mockResolvedValueOnce([makeEntry("ctx A"), makeEntry("ctx B")]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["t"], LOGGER);
    for (const c of ctx.domainContext) {
      expect(c).toHaveProperty("content");
      expect(typeof c.content).toBe("string");
    }
  });

  // 20. created_at preserved in recentDecisions entries
  it("preserves created_at in recentDecisions entries", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValueOnce([makeEntry("decision", "2026-03-15T10:00:00Z")])
      .mockResolvedValue([]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["t"], LOGGER);
    expect(ctx.recentDecisions[0].created_at).toBe("2026-03-15T10:00:00Z");
  });

  // 21. created_at preserved in domainContext entries
  it("preserves created_at in domainContext entries", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValueOnce([]) // decisions
      .mockResolvedValueOnce([makeEntry("ctx", "2026-04-01T00:00:00Z")]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", ["t"], LOGGER);
    expect(ctx.domainContext[0].created_at).toBe("2026-04-01T00:00:00Z");
  });

  // 22. Empty brain yields null/empty without throw
  it("empty brain returns null projectMdContent and empty arrays without throwing", async () => {
    const { brain } = makeBrain(vi.fn().mockResolvedValue([]));
    const ctx = await loadAgentContext(brain, "agent", ["t"], LOGGER, {
      projectMd: { query: "q", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBeNull();
    expect(ctx.recentDecisions).toEqual([]);
    expect(ctx.domainContext).toEqual([]);
  });

  // 23. domainTags forwarded to decisions query
  it("domainTags are forwarded to the decisions brain query", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "agent1", ["revenue", "gtm"], LOGGER);
    const decisionsCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("recent decisions"),
    );
    expect(decisionsCall![1]).toMatchObject({ tags: ["revenue", "gtm"] });
  });

  // 24. domainTags + agentId forwarded to domain context query
  it("agentId and domainTags are included in the domain context brain query tags", async () => {
    const { brain, queryKnowledge } = makeBrain();
    await loadAgentContext(brain, "forge-revenue", ["revenue", "gtm"], LOGGER);
    const ctxCall = queryKnowledge.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("domain context"),
    );
    const tags: string[] = ctxCall![1].tags;
    expect(tags).toContain("forge-revenue");
    expect(tags).toContain("revenue");
    expect(tags).toContain("gtm");
  });

  // 25. logger.info called after successful context load
  it("calls logger.info after successful context load", async () => {
    const { brain } = makeBrain();
    const logger = makeSilentLogger();
    await loadAgentContext(brain, "agent1", [], logger);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  // 26. logger.warn called when projectMd query throws
  it("calls logger.warn when projectMd query throws", async () => {
    const queryKnowledge = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue([]);
    const { brain } = makeBrain(queryKnowledge);
    const logger = makeSilentLogger();
    await loadAgentContext(brain, "agent1", [], logger, {
      projectMd: { query: "q", category: "c", tag: "t" },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // 27. logger.warn called when decisions query throws
  it("calls logger.warn when decisions query throws", async () => {
    let callCount = 0;
    const queryKnowledge = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve([]);
    });
    const { brain } = makeBrain(queryKnowledge);
    const logger = makeSilentLogger();
    await loadAgentContext(brain, "agent1", ["t"], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // 28. logger.warn called when domain context query throws
  it("calls logger.warn when domain context query throws", async () => {
    let callCount = 0;
    const queryKnowledge = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("fail ctx"));
      return Promise.resolve([]);
    });
    const { brain } = makeBrain(queryKnowledge);
    const logger = makeSilentLogger();
    await loadAgentContext(brain, "agent1", ["t"], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // 29. projectMdContent uses first entry content when brain returns multiple
  it("uses only the first entry content when brain returns multiple entries for projectMd", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValueOnce([makeEntry("first content"), makeEntry("second content")])
      .mockResolvedValue([]);
    const { brain } = makeBrain(queryKnowledge);
    const ctx = await loadAgentContext(brain, "agent1", [], LOGGER, {
      projectMd: { query: "q", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBe("first content");
  });

  // 30. All three queries fail simultaneously — result is fully empty, no throw
  it("handles all three queries failing simultaneously without throwing", async () => {
    const { brain } = makeBrain(vi.fn().mockRejectedValue(new Error("total brain outage")));
    const logger = makeSilentLogger();
    const ctx = await loadAgentContext(brain, "agent1", ["t"], logger, {
      projectMd: { query: "q", category: "c", tag: "t" },
    });
    expect(ctx.projectMdContent).toBeNull();
    expect(ctx.recentDecisions).toEqual([]);
    expect(ctx.domainContext).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});
