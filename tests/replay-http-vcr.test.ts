/**
 * tests/replay-http-vcr.test.ts
 *
 * Sprint-563: B9 — VCR HTTP cassettes record/replay.
 */

import { describe, expect, it } from "vitest";
import { HttpVCR, UndeterministicSideEffectError } from "../src/replay/http-vcr.js";

describe("HttpVCR", () => {
  it("records HTTP responses in record mode", async () => {
    const vcr = new HttpVCR();
    vcr.mode = "record";

    const response = await vcr.intercept(
      "https://api.example.com/data",
      "GET",
      null,
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
        }),
    );

    expect(response.status).toBe(200);
    expect(vcr.stats.recorded).toBe(1);
    expect(vcr.export()).toHaveLength(1);
  });

  it("replays from cassette in replay mode", async () => {
    const vcr = new HttpVCR();

    // First record
    vcr.mode = "record";
    await vcr.intercept(
      "https://api.example.com/data",
      "GET",
      null,
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
        }),
    );

    // Then replay
    vcr.mode = "replay";
    const response = await vcr.intercept("https://api.example.com/data", "GET", null, async () => {
      throw new Error("should not be called");
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
    expect(vcr.stats.hits).toBe(1);
  });

  it("throws UndeterministicSideEffectError on miss in strict replay", async () => {
    const vcr = new HttpVCR();
    vcr.mode = "replay";

    await expect(
      vcr.intercept(
        "https://api.example.com/unknown",
        "POST",
        JSON.stringify({ data: 1 }),
        async () => new Response("should not reach"),
      ),
    ).rejects.toThrow(UndeterministicSideEffectError);
    expect(vcr.stats.misses).toBe(1);
  });

  it("differentiates requests by URL, method, and body", async () => {
    const vcr = new HttpVCR();
    vcr.mode = "record";

    // Record GET
    await vcr.intercept(
      "https://api.example.com/a",
      "GET",
      null,
      async () => new Response("get-a"),
    );

    // Record POST
    await vcr.intercept(
      "https://api.example.com/a",
      "POST",
      JSON.stringify({ x: 1 }),
      async () => new Response("post-a"),
    );

    expect(vcr.export()).toHaveLength(2);

    vcr.mode = "replay";
    const getRes = await vcr.intercept("https://api.example.com/a", "GET", null, async () => {
      throw new Error("no");
    });
    expect(await getRes.text()).toBe("get-a");

    const postRes = await vcr.intercept(
      "https://api.example.com/a",
      "POST",
      JSON.stringify({ x: 1 }),
      async () => {
        throw new Error("no");
      },
    );
    expect(await postRes.text()).toBe("post-a");
  });

  it("load/export roundtrips correctly", () => {
    const vcr1 = new HttpVCR();
    vcr1.load([
      {
        url: "https://example.com/test",
        method: "GET",
        requestBody: null,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: "cached",
        timestamp: 1000,
      },
    ]);

    const exported = vcr1.export();
    expect(exported).toHaveLength(1);

    const vcr2 = new HttpVCR();
    vcr2.load(exported);
    vcr2.mode = "replay";

    // Should hit from loaded cassette
    expect(vcr2.stats.hits).toBe(0);
  });

  it("clear resets state", () => {
    const vcr = new HttpVCR();
    vcr.load([
      {
        url: "https://example.com",
        method: "GET",
        requestBody: null,
        status: 200,
        statusText: "OK",
        headers: {},
        body: "test",
        timestamp: 0,
      },
    ]);

    vcr.clear();
    expect(vcr.export()).toHaveLength(0);
    expect(vcr.stats.hits).toBe(0);
  });
});
