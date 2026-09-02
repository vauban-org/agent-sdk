import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { alpacaQuote } from "../src/skills/alpaca-quote.js";
import { SkillExecutionError, SkillNotConfiguredError } from "../src/skills/errors.js";
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
    expect(() => alpacaQuote.inputSchema.parse({ symbol: "bad symbol!" })).toThrow(ZodError);
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await alpacaQuote.execute({ symbol: "AAPL", mode: "paper" }, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.mode).toBe("replay");
  });

  it("isReplay=false → calls API", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ quote: { bp: 1, ap: 2, t: "2026-04-28T00:00:00Z" } }), {
        status: 200,
      }),
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

  it("uses dryRunMock when provided in replay mode", async () => {
    const mockResult = {
      symbol: "TSLA",
      bid: 250.5,
      ask: 251.0,
      timestamp: "2026-04-28T10:00:00Z",
      mode: "live" as const,
    };
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: { alpaca_quote: () => mockResult },
    });
    const out = await alpacaQuote.execute({ symbol: "TSLA", mode: "live" }, ctx);
    expect(out.bid).toBe(250.5);
    expect(out.mode).toBe("live");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws SkillExecutionError on non-retryable 4xx response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 40410000, message: "symbol not found" }), {
        status: 404,
      }),
    );
    const ctx = makeCtx({ isReplay: false });
    await expect(
      alpacaQuote.execute({ symbol: "INVALID", mode: "paper" }, ctx),
    ).rejects.toBeInstanceOf(SkillExecutionError);
  });

  it("defaults mode to paper when omitted", () => {
    const result = alpacaQuote.inputSchema.parse({ symbol: "SPY" });
    expect(result.mode).toBe("paper");
  });

  it("replay sentinel has bid=0, ask=0", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await alpacaQuote.execute({ symbol: "MSFT" }, ctx);
    expect(out.bid).toBe(0);
    expect(out.ask).toBe(0);
    expect(out.symbol).toBe("MSFT");
  });
});
