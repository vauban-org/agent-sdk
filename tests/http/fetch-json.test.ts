import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError, JsonParseError, fetchJson, fetchOrThrow } from "../../src/http/fetch-json.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("fetchOrThrow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the Response on 2xx", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ ok: true }));
    const res = await fetchOrThrow("https://example.com/x");
    expect(res.ok).toBe(true);
  });

  it("throws HttpError with status + body snippet on non-2xx", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errResponse(404, "not found here"),
    );
    await expect(fetchOrThrow("https://example.com/missing")).rejects.toMatchObject({
      status: 404,
      bodySnippet: "not found here",
    });
  });

  it("truncates the body snippet to bodySnippetLength", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errResponse(500, "x".repeat(1000)),
    );
    try {
      await fetchOrThrow("https://example.com/x", undefined, { bodySnippetLength: 10 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).bodySnippet).toHaveLength(10);
    }
  });

  it("prefixes the error message with opts.label when provided", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errResponse(502, "bad gateway"),
    );
    await expect(
      fetchOrThrow("https://example.com/x", undefined, { label: "OTLP" }),
    ).rejects.toThrow(/^OTLP HTTP 502/);
  });

  it("tolerates a minimal Response-shaped mock lacking .text() (common test-double pattern)", async () => {
    const minimalMock = {
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "not found" }),
    } as unknown as Response;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(minimalMock);

    await expect(fetchOrThrow("https://example.com/x")).rejects.toMatchObject({
      status: 404,
      bodySnippet: "",
    });
  });

  it("marks 429 and 5xx as retryable, other 4xx as non-retryable", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(errResponse(429, "slow down"))
      .mockResolvedValueOnce(errResponse(503, "unavailable"))
      .mockResolvedValueOnce(errResponse(400, "bad request"));

    const e429 = await fetchOrThrow("https://x").catch((e) => e as HttpError);
    const e503 = await fetchOrThrow("https://x").catch((e) => e as HttpError);
    const e400 = await fetchOrThrow("https://x").catch((e) => e as HttpError);

    expect(e429.retryable).toBe(true);
    expect(e503.retryable).toBe(true);
    expect(e400.retryable).toBe(false);
  });
});

describe("fetchJson", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the parsed JSON body on success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      okResponse({ hello: "world" }),
    );
    const body = await fetchJson<{ hello: string }>("https://example.com/x");
    expect(body).toEqual({ hello: "world" });
  });

  it("propagates HttpError on non-2xx without attempting to parse", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(errResponse(403, "denied"));
    await expect(fetchJson("https://example.com/x")).rejects.toBeInstanceOf(HttpError);
  });

  it("throws JsonParseError on malformed JSON body", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("not json {{{", { status: 200 }),
    );
    await expect(fetchJson("https://example.com/x")).rejects.toBeInstanceOf(JsonParseError);
  });

  it("passes init through to fetch (method, headers, body)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await fetchJson("https://example.com/x", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/x",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses opts.fetchFn override instead of global fetch when provided", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const customFetch = vi.fn().mockResolvedValueOnce(okResponse({ from: "custom" }));

    const body = await fetchJson("https://example.com/x", undefined, { fetchFn: customFetch });

    expect(body).toEqual({ from: "custom" });
    expect(customFetch).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
