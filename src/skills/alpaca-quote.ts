/**
 * alpaca_quote — Alpaca paper/live quote.
 *
 * cc:read scope. Live mode requires ALPACA_API_KEY / ALPACA_API_SECRET.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    symbol: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Z0-9.\-]+$/),
    mode: z.enum(["paper", "live"]).default("paper"),
  })
  .strict();
type AlpacaQuoteInput = z.infer<typeof inputSchema>;

export interface AlpacaQuoteOutput {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: string;
  mode: "paper" | "live" | "replay";
}

export const alpacaQuote: Skill<AlpacaQuoteInput, AlpacaQuoteOutput> = {
  name: "alpaca_quote",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<AlpacaQuoteOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["alpaca_quote"];
      if (mock) return mock(input) as AlpacaQuoteOutput;
      return {
        symbol: input.symbol,
        bid: 0,
        ask: 0,
        timestamp: new Date(0).toISOString(),
        mode: "replay",
      };
    }
    return withSkillSpan("alpaca_quote", async () => {
      const apiKey = process.env.ALPACA_API_KEY;
      const apiSecret = process.env.ALPACA_API_SECRET;
      if (!apiKey || !apiSecret) {
        throw new SkillNotConfiguredError("alpaca_quote", [
          "ALPACA_API_KEY",
          "ALPACA_API_SECRET",
        ]);
      }
      const dataHost = "https://data.alpaca.markets";
      const url = `${dataHost}/v2/stocks/${encodeURIComponent(input.symbol)}/quotes/latest`;
      const res = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": apiSecret,
        },
      });
      if (!res.ok) {
        throw new SkillExecutionError("alpaca_quote", `${res.status}`, {
          status: res.status,
        });
      }
      const data = (await res.json()) as {
        quote?: { bp?: number; ap?: number; t?: string };
      };
      return {
        symbol: input.symbol,
        bid: data.quote?.bp ?? 0,
        ask: data.quote?.ap ?? 0,
        timestamp: data.quote?.t ?? new Date().toISOString(),
        mode: input.mode,
      };
    });
  },
};
