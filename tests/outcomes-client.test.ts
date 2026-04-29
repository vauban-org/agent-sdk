import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomesApiError, createOutcomesClient } from "../src/outcomes/client.js";
import type { CfoView, Outcome, OutcomeSummary, RoiPerAgent } from "../src/outcomes/types.js";

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(status: number, body: unknown): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OUTCOME: Outcome = {
  id: "out-1",
  agent_id: "agent-test",
  agent_run_id: "run-abc",
  outcome_type: "forecast_accurate",
  value_cents: 1500,
  currency: "USD",
  occurred_at: "2026-04-01T10:00:00.000Z",
  is_pending_backfill: false,
  metadata: null,
};

const SUMMARY: OutcomeSummary = {
  period: { from: "2026-04-01T00:00:00Z", to: "2026-04-28T23:59:59Z" },
  total_value_cents: 15000,
  total_cost_cents: 3000,
  value_to_cost_ratio: 5,
  net_roi_pct: 400,
  outcome_count: 12,
  attributed_count: 10,
  pending_attribution_count: 2,
};

const CFO_VIEW: CfoView = {
  period: { from: "2026-04-01T00:00:00Z", to: "2026-04-28T23:59:59Z" },
  burn_rate_per_day_cents: 100,
  projected_30d_cents: 3000,
  by_initiative: [],
  pending_value_estimate_cents: 500,
};

const ROI_PER_AGENT: RoiPerAgent[] = [
  {
    agent_id: "agent-test",
    period: { from: "2026-04-01T00:00:00Z", to: "2026-04-28T23:59:59Z" },
    value_cents: 15000,
    cost_cents: 3000,
    net_roi_pct: 400,
    outcome_count: 12,
    pending_ratio: 0.167,
    wow_delta_pct: 5,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createOutcomesClient", () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeClient = () =>
    createOutcomesClient({
      baseUrl: "https://cc.example.com",
      getToken: () => Promise.resolve("test-token"),
    });

  it("list() builds correct URL without filters", async () => {
    fetchSpy.mockImplementation(mockFetch(200, { items: [OUTCOME] }));
    const client = makeClient();
    const result = await client.list();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/cc\.example\.com\/api\/outcomes(\?|$)/);
    expect(url).not.toContain("agent_id");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("out-1");
  });

  it("list() appends all provided filters to query string", async () => {
    fetchSpy.mockImplementation(mockFetch(200, { items: [], nextCursor: "cur-2" }));
    const client = makeClient();
    await client.list({
      agentId: "agent-xyz",
      type: "trade_pnl",
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-28T23:59:59Z",
      limit: 50,
      cursor: "cur-1",
    });

    const [url] = fetchSpy.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("agent_id")).toBe("agent-xyz");
    expect(parsed.searchParams.get("type")).toBe("trade_pnl");
    expect(parsed.searchParams.get("from")).toBe("2026-04-01T00:00:00Z");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.get("cursor")).toBe("cur-1");
  });

  it("summary() returns OutcomeSummary shape", async () => {
    fetchSpy.mockImplementation(mockFetch(200, SUMMARY));
    const client = makeClient();
    const result = await client.summary({
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-28T23:59:59Z",
    });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("/api/outcomes/summary");
    expect(result.total_value_cents).toBe(15000);
    expect(result.net_roi_pct).toBe(400);
    expect(result.pending_attribution_count).toBe(2);
  });

  it("cfo() returns CfoView shape", async () => {
    fetchSpy.mockImplementation(mockFetch(200, CFO_VIEW));
    const client = makeClient();
    const result = await client.cfo({
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-28T23:59:59Z",
    });

    expect(result.burn_rate_per_day_cents).toBe(100);
    expect(result.pending_value_estimate_cents).toBe(500);
  });

  it("roi() passes sort_by and limit parameters", async () => {
    fetchSpy.mockImplementation(mockFetch(200, ROI_PER_AGENT));
    const client = makeClient();
    await client.roi(
      { from: "2026-04-01T00:00:00Z", to: "2026-04-28T23:59:59Z" },
      { sortBy: "net_roi_pct", limit: 10 },
    );

    const [url] = fetchSpy.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("sort_by")).toBe("net_roi_pct");
    expect(parsed.searchParams.get("limit")).toBe("10");
  });

  it("throws OutcomesApiError on 401 with body propagated", async () => {
    const errorBody = { error: "Unauthorized", code: "INVALID_TOKEN" };
    fetchSpy.mockImplementation(mockFetch(401, errorBody));
    const client = makeClient();

    await expect(
      client.summary({ from: "2026-04-01T00:00:00Z", to: "2026-04-28T23:59:59Z" }),
    ).rejects.toMatchObject({
      name: "OutcomesApiError",
      status: 401,
    });
  });

  it("throws OutcomesApiError on 404", async () => {
    fetchSpy.mockImplementation(mockFetch(404, { error: "Not Found" }));
    const client = makeClient();

    await expect(client.list()).rejects.toBeInstanceOf(OutcomesApiError);
  });

  it("injects Bearer token from getToken into Authorization header", async () => {
    fetchSpy.mockImplementation(mockFetch(200, { items: [] }));
    const client = createOutcomesClient({
      baseUrl: "https://cc.example.com",
      getToken: () => Promise.resolve("secret-jwt-token"),
    });
    await client.list();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-jwt-token");
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchSpy.mockImplementation(mockFetch(200, { items: [] }));
    const client = createOutcomesClient({
      baseUrl: "https://cc.example.com/",
      getToken: () => Promise.resolve("tok"),
    });
    await client.list();

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/cc\.example\.com\/api\/outcomes/);
    expect(url).not.toContain("//api");
  });
});
