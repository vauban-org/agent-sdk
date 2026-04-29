/**
 * web_search — Brave Search API + Tavily fallback.
 *
 * V8-2: isReplay short-circuits BEFORE any network I/O.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
type WebSearchInput = z.infer<typeof inputSchema>;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchOutput {
  results: WebSearchResult[];
  provider: "brave" | "tavily" | "replay";
}

export const webSearch: Skill<WebSearchInput, WebSearchOutput> = {
  name: "web_search",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<WebSearchOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["web_search"];
      if (mock) return mock(input) as WebSearchOutput;
      return { results: [], provider: "replay" };
    }
    return withSkillSpan("web_search", async () => {
      const braveKey = process.env.BRAVE_SEARCH_KEY;
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!braveKey && !tavilyKey) {
        throw new SkillNotConfiguredError("web_search", [
          "BRAVE_SEARCH_KEY",
          "TAVILY_API_KEY",
        ]);
      }
      if (braveKey) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${input.limit}`;
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": braveKey,
          },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            web?: {
              results?: Array<{
                title?: string;
                url?: string;
                description?: string;
              }>;
            };
          };
          const results: WebSearchResult[] = (data.web?.results ?? []).map(
            (r) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.description ?? "",
            }),
          );
          return { results, provider: "brave" };
        }
        if (!tavilyKey) {
          throw new SkillExecutionError("web_search", `brave ${res.status}`, {
            status: res.status,
          });
        }
      }
      // Tavily fallback
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
        throw new SkillExecutionError("web_search", `tavily ${res.status}`, {
          status: res.status,
        });
      }
      const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const results: WebSearchResult[] = (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      }));
      return { results, provider: "tavily" };
    });
  },
};
