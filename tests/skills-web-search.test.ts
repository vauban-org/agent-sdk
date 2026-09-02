import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { SkillExecutionError, SkillNotConfiguredError } from "../src/skills/errors.js";
import { webSearch } from "../src/skills/web-search.js";
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
    delete process.env.TAVILY_API_KEY;
  });

  it("rejects invalid input via Zod", () => {
    expect(() => webSearch.inputSchema.parse({ query: "" })).toThrow(ZodError);
    expect(() => webSearch.inputSchema.parse({ query: "x", extra: 1 } as unknown)).toThrow(
      ZodError,
    );
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
    await expect(webSearch.execute({ query: "x", limit: 1 }, ctx)).rejects.toBeInstanceOf(
      SkillNotConfiguredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses dryRunMock when provided in replay mode", async () => {
    const mockResult = {
      results: [{ title: "Mock", url: "https://mock.test", snippet: "s" }],
      provider: "brave" as const,
    };
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: { web_search: () => mockResult },
    });
    const out = await webSearch.execute({ query: "test" }, ctx);
    expect(out.provider).toBe("brave");
    expect(out.results[0]?.title).toBe("Mock");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses Tavily when no Brave key configured", async () => {
    delete process.env.BRAVE_SEARCH_KEY;
    process.env.TAVILY_API_KEY = "tav-key";
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{ title: "TV", url: "tv-url", content: "tv-snippet" }],
        }),
        { status: 200 },
      ),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await webSearch.execute({ query: "starknet" }, ctx);
    expect(out.provider).toBe("tavily");
    expect(out.results[0]?.title).toBe("TV");
  });

  it("throws SkillExecutionError when Brave returns 4xx (no Tavily fallback)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const ctx = makeCtx({ isReplay: false });
    await expect(webSearch.execute({ query: "x" }, ctx)).rejects.toBeInstanceOf(
      SkillExecutionError,
    );
  });

  it("defaults limit to 5 when omitted", () => {
    const result = webSearch.inputSchema.parse({ query: "cairo" });
    expect(result.limit).toBe(5);
  });
});
