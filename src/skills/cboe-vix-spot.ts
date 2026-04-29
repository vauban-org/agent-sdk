/**
 * cboe_vix_spot — CBOE delayed VIX quote with 15min cache.
 *
 * V5 piège 4: NOT Yahoo Finance. CBOE delayed quote is the canonical source.
 * Cache stub uses an in-process Map; host can override via SkillContext.cache.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z.object({}).strict();
type CboeVixSpotInput = z.infer<typeof inputSchema>;

export interface CboeVixSpotOutput {
  symbol: "VIX";
  last: number;
  delayed_minutes: number;
  fetched_at: string;
  cached: boolean;
}

interface CacheEntry {
  expires_at: number;
  value: CboeVixSpotOutput;
}
const PROCESS_CACHE = new Map<string, CacheEntry>();
const CACHE_KEY = "vix-spot";
const CACHE_TTL_MS = 15 * 60 * 1000;

export const cboeVixSpot: Skill<CboeVixSpotInput, CboeVixSpotOutput> = {
  name: "cboe_vix_spot",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<CboeVixSpotOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["cboe_vix_spot"];
      if (mock) return mock(input) as CboeVixSpotOutput;
      return {
        symbol: "VIX",
        last: 0,
        delayed_minutes: 15,
        fetched_at: new Date(0).toISOString(),
        cached: false,
      };
    }
    const now = Date.now();
    const hit = PROCESS_CACHE.get(CACHE_KEY);
    if (hit && hit.expires_at > now) {
      return { ...hit.value, cached: true };
    }
    return withSkillSpan("cboe_vix_spot", async () => {
      // CBOE delayed-quote endpoint (public, no API key).
      const url =
        "https://cdn.cboe.com/api/global/delayed_quotes/quotes/VIX.json";
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new SkillExecutionError("cboe_vix_spot", `${res.status}`, {
          status: res.status,
        });
      }
      const data = (await res.json()) as {
        data?: { last?: number | string; current_price?: number | string };
      };
      const lastRaw = data.data?.last ?? data.data?.current_price ?? 0;
      const last = typeof lastRaw === "string" ? Number(lastRaw) : lastRaw;
      const value: CboeVixSpotOutput = {
        symbol: "VIX",
        last,
        delayed_minutes: 15,
        fetched_at: new Date(now).toISOString(),
        cached: false,
      };
      PROCESS_CACHE.set(CACHE_KEY, {
        value,
        expires_at: now + CACHE_TTL_MS,
      });
      return value;
    });
  },
};

/** Test helper: clear in-process VIX cache. */
export function _clearCboeVixCache(): void {
  PROCESS_CACHE.clear();
}
