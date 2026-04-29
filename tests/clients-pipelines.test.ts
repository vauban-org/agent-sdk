/**
 * Tests for packages/agent-sdk/src/clients/pipelines.ts
 *
 * Uses mocked fetch — no real backend calls.
 * Sprint: command-center:sprint-524:quick-9
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPipelinesClient,
  type PipelinesClientOptions,
} from "../src/clients/pipelines.js";

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

function mockFetchError(status: number, text = "Error"): void {
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

const opts: PipelinesClientOptions = {
  baseUrl: "https://command.vauban.tech",
  getToken: async () => "pipeline-token",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createPipelinesClient", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("run()", () => {
    it("calls POST /api/pipelines/run with inline pipeline definition", async () => {
      mockFetchOk(
        { runId: "run_123_abc", pipeline: "daily-digest", status: "running" },
        202,
      );

      const client = createPipelinesClient(opts);
      const result = await client.run({ name: "daily-digest" });

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://command.vauban.tech/api/pipelines/run");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer pipeline-token",
        "Content-Type": "application/json",
      });

      const body = JSON.parse(init.body as string) as {
        pipeline: { name: string; trigger: unknown };
      };
      expect(body.pipeline.name).toBe("daily-digest");
      expect(body.pipeline.trigger).toEqual({ type: "webhook" });

      expect(result.runId).toBe("run_123_abc");
      expect(result.pipelineId).toBe("daily-digest");
      expect(result.statusUrl).toBe(
        "https://command.vauban.tech/api/pipelines/run_123_abc/status",
      );
    });

    it("includes payload in pipeline context when provided", async () => {
      mockFetchOk({ runId: "run_xyz", pipeline: "knowledge-compounder" });
      const client = createPipelinesClient(opts);
      await client.run({
        name: "knowledge-compounder",
        payload: { source: "commit", sha: "abc123" },
      });

      const fetchMock = vi.mocked(fetch);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        pipeline: { context?: { source: string } };
      };
      expect(body.pipeline.context?.source).toBe("commit");
    });

    it("synthesises runId when backend omits it", async () => {
      mockFetchOk({ pipeline: "vault-guardian", status: "running" });
      const client = createPipelinesClient(opts);
      const result = await client.run({ name: "vault-guardian" });
      expect(result.runId).toMatch(/^pipe-/);
    });

    it("throws on non-OK response", async () => {
      mockFetchError(429, "rate limit exceeded");
      const client = createPipelinesClient(opts);
      await expect(client.run({ name: "daily-digest" })).rejects.toThrow(
        "PipelinesClient.run failed (429)",
      );
    });

    it("strips trailing slash from baseUrl", async () => {
      mockFetchOk({ runId: "run_ok", pipeline: "ecosystem-health" });
      const client = createPipelinesClient({
        ...opts,
        baseUrl: "https://command.vauban.tech/",
      });
      await client.run({ name: "ecosystem-health" });
      const fetchMock = vi.mocked(fetch);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://command.vauban.tech/api/pipelines/run");
    });
  });

  describe("list()", () => {
    it("returns the 10 known pipelines without making a fetch call", async () => {
      // list() uses static registry — no fetch expected
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = createPipelinesClient(opts);
      const result = await client.list();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.pipelines).toHaveLength(10);

      const names = result.pipelines.map((p) => p.name);
      expect(names).toContain("vault-guardian");
      expect(names).toContain("daily-digest");
      expect(names).toContain("cairo-sentinel");
      expect(names).toContain("pr-review");
    });

    it("correctly labels tier-1 and tier-2 pipelines", async () => {
      const client = createPipelinesClient(opts);
      const result = await client.list();

      const tier1 = result.pipelines.filter((p) => p.tier === 1);
      const tier2 = result.pipelines.filter((p) => p.tier === 2);
      expect(tier1).toHaveLength(5);
      expect(tier2).toHaveLength(5);
    });
  });

  describe("status()", () => {
    it("calls GET /api/pipelines/:id/status and computes progress", async () => {
      mockFetchOk({
        runId: "run_123_abc",
        pipeline: "daily-digest",
        status: "running",
        stepsTotal: 4,
        stepsCompleted: 2,
        stepsFailed: 0,
        stepsSkipped: 0,
      });

      const client = createPipelinesClient(opts);
      const result = await client.status("run_123_abc");

      const fetchMock = vi.mocked(fetch);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(
        "https://command.vauban.tech/api/pipelines/run_123_abc/status",
      );

      expect(result.status).toBe("running");
      expect(result.progress).toBe(50);
    });

    it("returns 100% progress when all steps completed", async () => {
      mockFetchOk({
        status: "completed",
        stepsTotal: 3,
        stepsCompleted: 3,
      });
      const client = createPipelinesClient(opts);
      const result = await client.status("run_done");
      expect(result.progress).toBe(100);
    });

    it("returns 0% progress when stepsTotal is 0 (no steps)", async () => {
      mockFetchOk({ status: "pending", stepsTotal: 0, stepsCompleted: 0 });
      const client = createPipelinesClient(opts);
      const result = await client.status("run_pending");
      // total=0 → default to 1 to avoid div-by-zero; progress = 0/1 = 0
      expect(result.progress).toBe(0);
    });

    it("returns unknown status when field missing", async () => {
      mockFetchOk({});
      const client = createPipelinesClient(opts);
      const result = await client.status("run_xyz");
      expect(result.status).toBe("unknown");
    });

    it("throws on 404 not found", async () => {
      mockFetchError(404, "Run not found");
      const client = createPipelinesClient(opts);
      await expect(client.status("no-such-run")).rejects.toThrow(
        "PipelinesClient.status failed (404)",
      );
    });
  });
});
