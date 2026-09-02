/**
 * web_search — Brave Search API + Tavily fallback.
 *
 * V8-2: isReplay short-circuits BEFORE any network I/O.
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

const SEARCH_RETRY: RetryConfig = {
  ...RETRY_TRANSIENT,
  retryIf: (err) => err instanceof RetryableHttpError || err instanceof TypeError,
};

const inputSchema = z
  .object({
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
type WebSearchInput = z.infer<typeof inputSchema>;

/** @public */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}
/** @public */
export interface WebSearchOutput {
  results: WebSearchResult[];
  provider: "brave" | "tavily" | "replay";
}

/** @public */
export const webSearch: Skill<WebSearchInput, WebSearchOutput> = {
  name: "web_search",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<WebSearchOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks.web_search;
      if (mock) return mock(input) as WebSearchOutput;
      return { results: [], provider: "replay" };
    }
    return withSkillSpan("web_search", async () => {
      const braveKey = readSecret(ctx, "BRAVE_SEARCH_KEY");
      const tavilyKey = readSecret(ctx, "TAVILY_API_KEY");
      if (!braveKey && !tavilyKey) {
        throw new SkillNotConfiguredError("web_search", ["BRAVE_SEARCH_KEY", "TAVILY_API_KEY"]);
      }

      // Try Brave first when configured. Retry on 5xx/429. Fall back to
      // Tavily on any final non-OK (4xx other than 429 short-circuits).
      if (braveKey) {
        try {
          return await retry(
            async () => {
              const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
                input.query,
              )}&count=${input.limit}`;
              const res = await fetch(url, {
                headers: {
                  Accept: "application/json",
                  "X-Subscription-Token": braveKey,
                },
              });
              if (!res.ok) {
                const body = await res.text().catch(() => "");
                if (res.status >= 500 || res.status === 429) {
                  throw new RetryableHttpError(res.status, body);
                }
                throw new SkillExecutionError("web_search", `brave ${res.status}`, {
                  status: res.status,
                });
              }
              const data = (await res.json()) as {
                web?: {
                  results?: Array<{
                    title?: string;
                    url?: string;
                    description?: string;
                  }>;
                };
              };
              const results: WebSearchResult[] = (data.web?.results ?? []).map((r) => ({
                title: r.title ?? "",
                url: r.url ?? "",
                snippet: r.description ?? "",
              }));
              return { results, provider: "brave" as const };
            },
            { config: SEARCH_RETRY },
          );
        } catch (err) {
          if (!tavilyKey) {
            const cause = err instanceof RetryExhaustedError ? err.lastError : err;
            if (cause instanceof RetryableHttpError) {
              throw new SkillExecutionError("web_search", `brave ${cause.status} after retries`, {
                status: cause.status,
              });
            }
            throw cause;
          }
          // Brave failed — fall through to Tavily.
        }
      }

      // Tavily (primary if no Brave key, else fallback)
      try {
        return await retry(
          async () => {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: tavilyKey,
                query: input.query,
                max_results: input.limit,
              }),
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              if (res.status >= 500 || res.status === 429) {
                throw new RetryableHttpError(res.status, body);
              }
              throw new SkillExecutionError("web_search", `tavily ${res.status}`, {
                status: res.status,
              });
            }
            const data = (await res.json()) as {
              results?: Array<{
                title?: string;
                url?: string;
                content?: string;
              }>;
            };
            const results: WebSearchResult[] = (data.results ?? []).map((r) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
            }));
            return { results, provider: "tavily" as const };
          },
          { config: SEARCH_RETRY },
        );
      } catch (err) {
        const cause = err instanceof RetryExhaustedError ? err.lastError : err;
        if (cause instanceof RetryableHttpError) {
          throw new SkillExecutionError("web_search", `tavily ${cause.status} after retries`, {
            status: cause.status,
          });
        }
        throw cause;
      }
    });
  },
};
