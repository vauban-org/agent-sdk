import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cboeVixSpot,
  _clearCboeVixCache,
} from "../src/skills/cboe-vix-spot.js";
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
    expect(() =>
      cboeVixSpot.inputSchema.parse({ extra: 1 } as unknown),
    ).toThrow();
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
});
