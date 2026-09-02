import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearCboeVixCache, cboeVixSpot } from "../src/skills/cboe-vix-spot.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill cboe_vix_spot", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    _clearCboeVixCache();
  });
  afterEach(() => {
    _clearCboeVixCache();
  });

  it("rejects extra fields via .strict()", () => {
    expect(() => cboeVixSpot.inputSchema.parse({ extra: 1 } as unknown)).toThrow();
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await cboeVixSpot.execute({}, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.symbol).toBe("VIX");
    expect(out.cached).toBe(false);
  });

  it("isReplay=false → fetches CBOE then caches", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { last: 18.42 } }), { status: 200 }),
    );
    const ctx = makeCtx({ isReplay: false });
    const a = await cboeVixSpot.execute({}, ctx);
    expect(a.last).toBe(18.42);
    expect(a.cached).toBe(false);
    const b = await cboeVixSpot.execute({}, ctx);
    expect(b.cached).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("throws SkillExecutionError on non-2xx HTTP response", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 503 }));
    const ctx = makeCtx({ isReplay: false });
    await expect(cboeVixSpot.execute({}, ctx)).rejects.toThrow("503");
  });

  it("uses dryRunMock when provided in replay mode", async () => {
    const mockResult = {
      symbol: "VIX",
      last: 99.9,
      delayed_minutes: 0,
      fetched_at: "2026-01-01T00:00:00Z",
      cached: false,
    };
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: { cboe_vix_spot: () => mockResult },
    });
    const out = await cboeVixSpot.execute({}, ctx);
    expect(out.last).toBe(99.9);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses string last value as number", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { last: "21.5" } }), { status: 200 }),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await cboeVixSpot.execute({}, ctx);
    expect(out.last).toBe(21.5);
  });

  it("falls back to current_price when last is missing", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { current_price: 17.3 } }), {
        status: 200,
      }),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await cboeVixSpot.execute({}, ctx);
    expect(out.last).toBe(17.3);
  });
});
