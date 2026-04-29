import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { alpacaQuote } from "../src/skills/alpaca-quote.js";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill alpaca_quote", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.ALPACA_API_KEY = "k";
    process.env.ALPACA_API_SECRET = "s";
  });
  afterEach(() => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
  });

  it("rejects bad symbol via Zod", () => {
    expect(() =>
      alpacaQuote.inputSchema.parse({ symbol: "bad symbol!" }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await alpacaQuote.execute({ symbol: "AAPL", mode: "paper" }, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.mode).toBe("replay");
  });

  it("isReplay=false → calls API", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ quote: { bp: 1, ap: 2, t: "2026-04-28T00:00:00Z" } }),
        { status: 200 },
      ),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await alpacaQuote.execute({ symbol: "AAPL", mode: "paper" }, ctx);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.bid).toBe(1);
    expect(out.ask).toBe(2);
  });

  it("throws when keys missing", async () => {
    delete process.env.ALPACA_API_KEY;
    const ctx = makeCtx({ isReplay: false });
    await expect(
      alpacaQuote.execute({ symbol: "AAPL", mode: "paper" }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
  });
});
