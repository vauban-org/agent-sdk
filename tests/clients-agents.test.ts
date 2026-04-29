/**
 * Tests for packages/agent-sdk/src/clients/agents.ts
 *
 * Uses mocked fetch — no real backend calls.
 * Sprint: command-center:sprint-524:quick-9
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAgentsClient,
  type AgentsClientOptions,
} from "../src/clients/agents.js";

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockFetchOk(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

function mockFetchError(status: number, text = "Internal Server Error"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(text),
    }),
  );
}

// ─── Shared options ───────────────────────────────────────────────────────────

const opts: AgentsClientOptions = {
  baseUrl: "https://command.vauban.tech",
  getToken: async () => "test-token",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createAgentsClient", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("execute()", () => {
    it("calls POST /api/agents/execute with correct payload", async () => {
      mockFetchOk({
        content: "done",
        model: "llama-3.3-70b",
        provider: "groq",
        tokens: { input: 100, output: 200, total: 300 },
        cost: 0,
        latencyMs: 1200,
      });

      const client = createAgentsClient(opts);
      const result = await client.execute({
        agentId: "ARCHITECT",
        taskType: "code-review",
        description: "Review auth module",
        archiveToBrain: true,
      });

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://command.vauban.tech/api/agents/execute");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agentType).toBe("ARCHITECT");
      expect(body.taskType).toBe("code-review");
      expect(body.description).toBe("Review auth module");
      expect(body.archive).toBe(true);

      expect(result.status).toBe("completed");
      expect(result.runId).toMatch(/^exec-/);
      expect(result.runUrl).toContain("/runs/exec-");
    });

    it("strips trailing slash from baseUrl", async () => {
      mockFetchOk({ content: "ok" });
      const client = createAgentsClient({
        ...opts,
        baseUrl: "https://command.vauban.tech/",
      });
      await client.execute({
        agentId: "BUILDER",
        taskType: "task",
        description: "x",
      });
      const fetchMock = vi.mocked(fetch);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://command.vauban.tech/api/agents/execute");
    });

    it("defaults archiveToBrain to false when omitted", async () => {
      mockFetchOk({ content: "ok" });
      const client = createAgentsClient(opts);
      await client.execute({
        agentId: "TESTER",
        taskType: "test",
        description: "run tests",
      });
      const fetchMock = vi.mocked(fetch);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { archive: boolean };
      expect(body.archive).toBe(false);
    });

    it("uses backend runId when present in response", async () => {
      mockFetchOk({ content: "ok", runId: "backend-run-42", status: "running" });
      const client = createAgentsClient(opts);
      const result = await client.execute({
        agentId: "SCRIBE",
        taskType: "doc",
        description: "write docs",
      });
      expect(result.runId).toBe("backend-run-42");
      expect(result.runUrl).toBe(
        "https://command.vauban.tech/runs/backend-run-42",
      );
      expect(result.status).toBe("running");
    });

    it("throws on non-OK response", async () => {
      mockFetchError(500, "internal error");
      const client = createAgentsClient(opts);
      await expect(
        client.execute({ agentId: "ARCHITECT", taskType: "t", description: "d" }),
      ).rejects.toThrow("AgentsClient.execute failed (500)");
    });

    it("throws on 429 rate limit", async () => {
      mockFetchError(429, "rate limit exceeded");
      const client = createAgentsClient(opts);
      await expect(
        client.execute({ agentId: "ARCHITECT", taskType: "t", description: "d" }),
      ).rejects.toThrow("429");
    });
  });

  describe("listRegistry()", () => {
    it("calls GET /api/agents and maps agents correctly", async () => {
      mockFetchOk({
        agents: [
          { type: "ARCHITECT", displayName: "Architect", model: "llama-3.3-70b" },
          { type: "BUILDER", displayName: "Builder", model: "llama-3.3-70b" },
        ],
      });

      const client = createAgentsClient(opts);
      const result = await client.listRegistry();

      const fetchMock = vi.mocked(fetch);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://command.vauban.tech/api/agents");
      expect((init as { method: string }).method).toBe("GET");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer test-token",
      });

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0]).toEqual({
        agentId: "ARCHITECT",
        type: "ARCHITECT",
        status: "active",
      });
      expect(result.agents[1]).toEqual({
        agentId: "BUILDER",
        type: "BUILDER",
        status: "active",
      });
    });

    it("returns empty agents array when backend returns empty list", async () => {
      mockFetchOk({ agents: [] });
      const client = createAgentsClient(opts);
      const result = await client.listRegistry();
      expect(result.agents).toEqual([]);
    });

    it("handles missing agents field gracefully", async () => {
      mockFetchOk({});
      const client = createAgentsClient(opts);
      const result = await client.listRegistry();
      expect(result.agents).toEqual([]);
    });

    it("throws on non-OK response", async () => {
      mockFetchError(401, "Unauthorized");
      const client = createAgentsClient(opts);
      await expect(client.listRegistry()).rejects.toThrow(
        "AgentsClient.listRegistry failed (401)",
      );
    });
  });
});
