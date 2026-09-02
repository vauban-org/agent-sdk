/**
 * alpaca_quote — Alpaca paper/live quote.
 *
 * cc:read scope. Live mode requires ALPACA_API_KEY / ALPACA_API_SECRET.
 *
 * @public
 */
import { z } from "zod";

import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { RETRY_TRANSIENT, type RetryConfig, RetryExhaustedError, retry } from "../retry/index.js";

import { withSkillSpan } from "./_otel.js";
import { readSecret } from "./_secrets.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";

class RetryableHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "RetryableHttpError";
  }
}

const ALPACA_RETRY: RetryConfig = {
  ...RETRY_TRANSIENT,
  retryIf: (err) => err instanceof RetryableHttpError || err instanceof TypeError,
};

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

/** @public */
export interface AlpacaQuoteOutput {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: string;
  mode: "paper" | "live" | "replay";
}

/** @public */
export const alpacaQuote: Skill<AlpacaQuoteInput, AlpacaQuoteOutput> = {
  name: "alpaca_quote",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<AlpacaQuoteOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks.alpaca_quote;
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
      const apiKey = readSecret(ctx, "ALPACA_API_KEY");
      const apiSecret = readSecret(ctx, "ALPACA_API_SECRET");
      if (!apiKey || !apiSecret) {
        throw new SkillNotConfiguredError("alpaca_quote", ["ALPACA_API_KEY", "ALPACA_API_SECRET"]);
      }
      const dataHost = "https://data.alpaca.markets";
      const url = `${dataHost}/v2/stocks/${encodeURIComponent(input.symbol)}/quotes/latest`;
      try {
        return await retry(
          async () => {
            const res = await fetch(url, {
              headers: {
                "APCA-API-KEY-ID": apiKey,
                "APCA-API-SECRET-KEY": apiSecret,
              },
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              if (res.status >= 500 || res.status === 429) {
                throw new RetryableHttpError(res.status, body);
              }
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
          },
          { config: ALPACA_RETRY },
        );
      } catch (err) {
        const cause = err instanceof RetryExhaustedError ? err.lastError : err;
        if (cause instanceof RetryableHttpError) {
          throw new SkillExecutionError("alpaca_quote", `${cause.status} after retries`, {
            status: cause.status,
          });
        }
        throw cause;
      }
    });
  },
};
