import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { httpFetch, isHostAllowed } from "../src/skills/http-fetch.js";
import { HttpFetchAllowlistError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill http_fetch", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.HTTP_FETCH_ALLOWLIST = "api.example.com,*.public.dev";
  });
  afterEach(() => {
    delete process.env.HTTP_FETCH_ALLOWLIST;
  });

  it("rejects non-URL via Zod", () => {
    expect(() => httpFetch.inputSchema.parse({ url: "not a url" })).toThrow(
      ZodError,
    );
  });

  it("isHostAllowed handles wildcards", () => {
    expect(isHostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(isHostAllowed("a.public.dev", ["*.public.dev"])).toBe(true);
    expect(isHostAllowed("public.dev", ["*.public.dev"])).toBe(false);
    expect(isHostAllowed("evil.com", ["api.example.com"])).toBe(false);
  });

  it("rejects host not in allowlist (no fetch)", async () => {
    const ctx = makeCtx({ isReplay: false });
    await expect(
      httpFetch.execute({ url: "https://evil.com/x", timeout_ms: 1000 }, ctx),
    ).rejects.toBeInstanceOf(HttpFetchAllowlistError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("isReplay=true → no fetch even for allowed host", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await httpFetch.execute(
      { url: "https://api.example.com/x", timeout_ms: 1000 },
      ctx,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.status).toBe(0);
  });

  it("isReplay=false → fetches allowed host", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await httpFetch.execute(
      { url: "https://api.example.com/x", timeout_ms: 1000 },
      ctx,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.status).toBe(200);
    expect(out.body).toBe("hello");
  });
});
