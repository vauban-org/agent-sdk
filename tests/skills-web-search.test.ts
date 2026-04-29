import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { webSearch } from "../src/skills/web-search.js";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill web_search", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.BRAVE_SEARCH_KEY = "test-brave";
    delete process.env.TAVILY_API_KEY;
  });
  afterEach(() => {
    delete process.env.BRAVE_SEARCH_KEY;
  });

  it("rejects invalid input via Zod", () => {
    expect(() => webSearch.inputSchema.parse({ query: "" })).toThrow(ZodError);
    expect(() =>
      webSearch.inputSchema.parse({ query: "x", extra: 1 } as unknown),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await webSearch.execute({ query: "starknet", limit: 5 }, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.provider).toBe("replay");
    expect(out.results).toEqual([]);
  });

  it("isReplay=false → calls Brave API", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: { results: [{ title: "T", url: "u", description: "d" }] },
        }),
        { status: 200 },
      ),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await webSearch.execute({ query: "x", limit: 1 }, ctx);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.provider).toBe("brave");
    expect(out.results[0]?.title).toBe("T");
  });

  it("throws SkillNotConfiguredError if no key", async () => {
    delete process.env.BRAVE_SEARCH_KEY;
    const ctx = makeCtx({ isReplay: false });
    await expect(
      webSearch.execute({ query: "x", limit: 1 }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
