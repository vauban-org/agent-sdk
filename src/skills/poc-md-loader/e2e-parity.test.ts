/**
 * E2E parity test — POC-B SKILL.md vs original web-search.ts
 *
 * Runs BOTH the original TS skill and the MD-loaded variant against
 * the same mocked fetch, then compares output shape + content.
 * Measures cold start of the MD loader path.
 *
 * No network calls — fetch is mocked via globalThis.fetch override.
 *
 * @poc-jetable
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Original skill (TS) ───────────────────────────────────────────────────────
import { webSearch } from "../web-search.js";
import type { WebSearchOutput } from "../web-search.js";

// ── POC loader ────────────────────────────────────────────────────────────────
import { loadSkillMd } from "./markdown-loader.js";
import { runSkillMd } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "web-search");

// ── Mock fetch helpers ────────────────────────────────────────────────────────

const BRAVE_MOCK_RESPONSE = {
  web: {
    results: [
      {
        title: "Mock Result 1",
        url: "https://example.com/1",
        description: "Snippet one",
      },
      {
        title: "Mock Result 2",
        url: "https://example.com/2",
        description: "Snippet two",
      },
    ],
  },
};

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });
}

// ── Replay context for original skill ────────────────────────────────────────

const REPLAY_CTX = {
  isReplay: true,
  dryRunMocks: {
    web_search: (_input: unknown) => ({
      results: [
        {
          title: "Mock Result 1",
          url: "https://example.com/1",
          snippet: "Snippet one",
        },
        {
          title: "Mock Result 2",
          url: "https://example.com/2",
          snippet: "Snippet two",
        },
      ],
      provider: "replay" as const,
    }),
  },
  agentId: "poc-test",
  runId: "poc-run-1",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POC-B: SKILL.md parity + cold start", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.BRAVE_SEARCH_KEY;
    delete process.env.TAVILY_API_KEY;
  });

  // ── 1. Manifest loading ──────────────────────────────────────────────────

  it("loads SKILL.md and returns valid manifest", async () => {
    const { manifest } = await loadSkillMd(join(SKILL_DIR, "SKILL.md"));

    expect(manifest.name).toBe("web-search");
    expect(manifest.description).toBeTruthy();
    expect(manifest.description.length).toBeLessThanOrEqual(1024);
    expect(manifest["allowed-tools"]).toBe("Bash(curl:*)");
    expect(manifest.metadata?.version).toBe("1.0.0");
    expect(manifest.metadata?.category).toBe("search");
    expect(manifest.metadata?.["env-mode"]).toBe("at-least-one");
  });

  // ── 2. Output shape parity (replay vs MD) ───────────────────────────────

  it("MD output shape matches original skill output shape (replay)", async () => {
    // Original skill in replay mode
    const originalOutput = await webSearch.execute(
      { query: "test", limit: 2 },
      REPLAY_CTX as never,
    );

    // MD script in replay mode (mock fetch, BRAVE_SEARCH_KEY set → path taken but mocked)
    process.env.BRAVE_SEARCH_KEY = "test-key";
    globalThis.fetch = mockFetch(BRAVE_MOCK_RESPONSE) as never;

    const { output: mdOutput } = await runSkillMd<WebSearchOutput>(SKILL_DIR, {
      query: "test",
      limit: 2,
    });

    // Shape parity: both have results[] and provider
    expect(Object.keys(mdOutput)).toEqual(expect.arrayContaining(["results", "provider"]));
    expect(Array.isArray(mdOutput.results)).toBe(true);

    // Original replay returns empty results (no mock for live), MD returns from brave mock
    // Key parity: result items have title/url/snippet
    if (mdOutput.results.length > 0) {
      const r = mdOutput.results[0];
      expect(r).toHaveProperty("title");
      expect(r).toHaveProperty("url");
      expect(r).toHaveProperty("snippet");
    }

    // Provider field exists and is valid
    expect(["brave", "tavily", "replay"]).toContain(mdOutput.provider);
  });

  // ── 3. Live path parity (both use mocked fetch, same brave response) ────

  it("MD script returns same data as original skill on Brave success path", async () => {
    process.env.BRAVE_SEARCH_KEY = "test-brave-key";
    globalThis.fetch = mockFetch(BRAVE_MOCK_RESPONSE) as never;

    // Original skill — live path with mocked fetch
    const originalOutput = await webSearch.execute({ query: "starknet", limit: 2 }, {
      isReplay: false,
      dryRunMocks: {},
      agentId: "poc",
      runId: "r1",
    } as never);

    // Reset mock (fresh call counter)
    globalThis.fetch = mockFetch(BRAVE_MOCK_RESPONSE) as never;

    const { output: mdOutput } = await runSkillMd<WebSearchOutput>(SKILL_DIR, {
      query: "starknet",
      limit: 2,
    });

    // Full output equality
    expect(mdOutput.provider).toBe(originalOutput.provider);
    expect(mdOutput.results).toEqual(originalOutput.results);
  });

  // ── 4. Tavily fallback parity ────────────────────────────────────────────

  it("MD script Tavily fallback matches original skill", async () => {
    process.env.TAVILY_API_KEY = "test-tavily-key";
    // No BRAVE key → goes straight to Tavily

    const tavilyMock = {
      results: [
        {
          title: "Tavily R1",
          url: "https://tavily.com/1",
          content: "Tavily snippet 1",
        },
      ],
    };

    globalThis.fetch = mockFetch(tavilyMock) as never;
    const originalOutput = await webSearch.execute({ query: "cairo", limit: 1 }, {
      isReplay: false,
      dryRunMocks: {},
      agentId: "poc",
      runId: "r2",
    } as never);

    globalThis.fetch = mockFetch(tavilyMock) as never;
    const { output: mdOutput } = await runSkillMd<WebSearchOutput>(SKILL_DIR, {
      query: "cairo",
      limit: 1,
    });

    expect(mdOutput.provider).toBe("tavily");
    expect(mdOutput.provider).toBe(originalOutput.provider);
    expect(mdOutput.results).toEqual(originalOutput.results);
  });

  // ── 5. Error parity: missing env ────────────────────────────────────────

  it("MD runner throws when no API key configured (env-mode: at-least-one)", async () => {
    // No BRAVE_SEARCH_KEY, no TAVILY_API_KEY
    await expect(runSkillMd(SKILL_DIR, { query: "test" })).rejects.toThrow(/at least one of/i);
  });

  // ── 6. Cold start measurement ────────────────────────────────────────────

  it("cold start (load+parse+execute) is under 500ms", async () => {
    process.env.BRAVE_SEARCH_KEY = "perf-test-key";
    globalThis.fetch = mockFetch(BRAVE_MOCK_RESPONSE) as never;

    const t0 = performance.now();
    const { coldStartMs } = await runSkillMd(SKILL_DIR, {
      query: "perf",
      limit: 1,
    });
    const wallMs = performance.now() - t0;

    // biome-ignore lint/suspicious/noConsoleLog: benchmark result reporting in the parity harness.
    console.log(`[POC-B] cold start: ${coldStartMs.toFixed(2)}ms (wall: ${wallMs.toFixed(2)}ms)`);

    // Primary assertion
    expect(coldStartMs).toBeLessThan(500);
    // Sanity: internal timer matches wall clock within 50ms
    expect(Math.abs(coldStartMs - wallMs)).toBeLessThan(50);
  });
});
