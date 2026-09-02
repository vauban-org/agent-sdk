import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { brainStore } from "../src/skills/brain-store.js";
import { SkillExecutionError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill brain_store", () => {
  it("rejects empty content via Zod", () => {
    expect(() => brainStore.inputSchema.parse({ content: "" })).toThrow(ZodError);
  });

  it("isReplay=true → no archive call", async () => {
    fetchSpy.mockClear();
    const archiveKnowledge = vi.fn().mockResolvedValue({ id: "x" });
    const ctx = makeCtx({ isReplay: true, brain: { archiveKnowledge } });
    const out = await brainStore.execute({ content: "hello" }, ctx);
    expect(archiveKnowledge).not.toHaveBeenCalled();
    expect(out.archived).toBe(false);
  });

  it("isReplay=false → calls archiveKnowledge with mcp_call_hash in metadata", async () => {
    const archiveKnowledge = vi.fn().mockResolvedValue({
      id: "abc-123",
      content: "hello",
    });
    const ctx = makeCtx({ isReplay: false, brain: { archiveKnowledge } });
    const out = await brainStore.execute({ content: "hello", mcp_call_hash: "0xdead" }, ctx);
    expect(archiveKnowledge).toHaveBeenCalledOnce();
    const arg = archiveKnowledge.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(arg.metadata?.mcp_call_hash).toBe("0xdead");
    expect(out.id).toBe("abc-123");
    expect(out.archived).toBe(true);
  });

  it("throws when brain port absent", async () => {
    const ctx = makeCtx({ isReplay: false });
    await expect(brainStore.execute({ content: "x" }, ctx)).rejects.toBeInstanceOf(
      SkillExecutionError,
    );
  });

  it("uses dryRunMock when provided in replay mode", async () => {
    const archiveKnowledge = vi.fn();
    const ctx = makeCtx({
      isReplay: true,
      brain: { archiveKnowledge },
      dryRunMocks: { brain_store: () => ({ id: "mock-id", archived: true }) },
    });
    const out = await brainStore.execute({ content: "mocked" }, ctx);
    expect(out.id).toBe("mock-id");
    expect(out.archived).toBe(true);
    expect(archiveKnowledge).not.toHaveBeenCalled();
  });

  it("returns id=null and archived=false when archiveKnowledge returns null", async () => {
    const archiveKnowledge = vi.fn().mockResolvedValue(null);
    const ctx = makeCtx({ isReplay: false, brain: { archiveKnowledge } });
    const out = await brainStore.execute({ content: "something" }, ctx);
    expect(out.id).toBeNull();
    expect(out.archived).toBe(false);
  });

  it("passes category, tags, author, confidence to archiveKnowledge", async () => {
    const archiveKnowledge = vi.fn().mockResolvedValue({ id: "x" });
    const ctx = makeCtx({ isReplay: false, brain: { archiveKnowledge } });
    await brainStore.execute(
      {
        content: "decision",
        category: "governance",
        tags: ["adr", "security"],
        author: "forge-agent",
        confidence: 0.9,
      },
      ctx,
    );
    const arg = archiveKnowledge.mock.calls[0]?.[0] as {
      category?: string;
      tags?: string[];
      author?: string;
      confidence?: number;
    };
    expect(arg.category).toBe("governance");
    expect(arg.tags).toEqual(["adr", "security"]);
    expect(arg.author).toBe("forge-agent");
    expect(arg.confidence).toBe(0.9);
  });
});
