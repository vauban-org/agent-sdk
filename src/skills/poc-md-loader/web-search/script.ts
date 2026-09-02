/**
 * web-search execution script — POC MD loader variant.
 *
 * Identical logic to web-search.ts but as a standalone function
 * with no SDK imports (no Skill<> interface, no withSkillSpan, no errors.ts).
 * This measures the "pure script" execution path of the SKILL.md pattern.
 *
 * @poc-jetable
 */

export interface WebSearchInput {
  query: string;
  limit?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  results: WebSearchResult[];
  provider: "brave" | "tavily" | "replay";
}

export class SkillNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`web-search not configured: missing env ${missing.join(", ")}`);
    this.name = "SkillNotConfiguredError";
  }
}

export class SkillExecutionError extends Error {
  constructor(message: string) {
    super(`web-search failed: ${message}`);
    this.name = "SkillExecutionError";
  }
}

/**
 * Execute web search. Same logic as web-search.ts#webSearch.execute().
 */
export async function execute(input: WebSearchInput): Promise<WebSearchOutput> {
  const query = input.query;
  const limit = input.limit ?? 5;

  const braveKey = process.env.BRAVE_SEARCH_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (!braveKey && !tavilyKey) {
    throw new SkillNotConfiguredError(["BRAVE_SEARCH_KEY", "TAVILY_API_KEY"]);
  }

  if (braveKey) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=${limit}`;
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
      const results: WebSearchResult[] = (data.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
      return { results, provider: "brave" };
    }
    if (!tavilyKey) {
      throw new SkillExecutionError(`brave ${res.status}`);
    }
  }

  // Tavily fallback
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      max_results: limit,
    }),
  });
  if (!res.ok) {
    throw new SkillExecutionError(`tavily ${res.status}`);
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
}
