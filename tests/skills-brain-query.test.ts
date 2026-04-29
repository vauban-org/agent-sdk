import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { brainQuery } from "../src/skills/brain-query.js";
import { SkillExecutionError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

describe("skill brain_query", () => {
  it("rejects too-long query via Zod", () => {
    expect(() =>
      brainQuery.inputSchema.parse({ query: "x".repeat(513) }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no port call", async () => {
    const queryKnowledge = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({ isReplay: true, brain: { queryKnowledge } });
    const out = await brainQuery.execute({ query: "x", limit: 5 }, ctx);
    expect(queryKnowledge).not.toHaveBeenCalled();
    expect(out.entries).toEqual([]);
  });

  it("isReplay=false → calls queryKnowledge", async () => {
    const queryKnowledge = vi
      .fn()
      .mockResolvedValue([{ id: "a", content: "c" }]);
    const ctx = makeCtx({ isReplay: false, brain: { queryKnowledge } });
    const out = await brainQuery.execute(
      { query: "x", limit: 5, mcp_call_hash: "0x1" },
      ctx,
    );
    expect(queryKnowledge).toHaveBeenCalledOnce();
    expect(out.entries.length).toBe(1);
  });

  it("throws when no queryKnowledge port", async () => {
    const ctx = makeCtx({ isReplay: false });
    await expect(
      brainQuery.execute({ query: "x", limit: 5 }, ctx),
    ).rejects.toBeInstanceOf(SkillExecutionError);
  });
});
