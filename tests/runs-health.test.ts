/**
 * createRunsClient — health / anomaly / circuit-breaker REST client tests.
 *
 * Sprint: command-center:sprint-523:quick-6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRunsClient } from "../src/runs/health.js";
import type { AgentHealth, Anomaly, CircuitBreakerSnapshot } from "../src/runs/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("createRunsClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getHealth", () => {
    it("fetches agent health for the given agent id and window", async () => {
      const healthFixture: AgentHealth = {
        agent_id: "forecaster",
        window: "7d",
        uptime_pct: 0.98,
        error_rate: 0.02,
        p50_latency_ms: 120,
        p99_latency_ms: 980,
        run_count: 50,
        last_run_at: "2026-04-28T10:00:00Z",
        last_status: "succeeded",
      };

      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(healthFixture));
      vi.stubGlobal("fetch", mockFetch);

      const client = createRunsClient({ baseUrl: "http://localhost:8080" });
      const result = await client.getHealth("forecaster", "7d");

      expect(result).toEqual(healthFixture);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/api/agents/forecaster/health?window=7d");
    });

    it("uses 24h as default window", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({
        agent_id: "narrator",
        window: "24h",
        uptime_pct: 1,
        error_rate: 0,
        p50_latency_ms: 0,
        p99_latency_ms: 0,
        run_count: 0,
        last_run_at: null,
        last_status: null,
      } satisfies AgentHealth));
      vi.stubGlobal("fetch", mockFetch);

      const client = createRunsClient({ baseUrl: "http://localhost:8080" });
      await client.getHealth("narrator");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("window=24h");
    });

    it("throws on non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404)));

      const client = createRunsClient({ baseUrl: "http://localhost:8080" });
      await expect(client.getHealth("unknown-agent")).rejects.toThrow("HTTP 404");
    });
  });

  describe("getAnomalies", () => {
    it("returns anomalies array from response", async () => {
      const anomalyFixture: Anomaly = {
        agent_id: "market-radar",
        cost_dimension: "groq_tokens",
        run_id: "run-xyz",
        observed: 12000,
        baseline_mean: 5000,
        baseline_stddev: 1200,
        z_score: 5.83,
        severity: "high",
        detected_at: "2026-04-28T09:30:00Z",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        jsonResponse({ agent_id: "market-radar", anomalies: [anomalyFixture] })
      ));

      const client = createRunsClient({ baseUrl: "http://localhost:8080" });
      const result = await client.getAnomalies("market-radar");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(anomalyFixture);
    });
  });

  describe("getCircuitBreakers", () => {
    it("returns circuit breaker snapshots", async () => {
      const snapshot: CircuitBreakerSnapshot = {
        provider: "groq",
        state: "closed",
        failure_count: 0,
        last_failure: null,
        last_success: "2026-04-28T10:00:00Z",
        reset_after_ms: null,
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        jsonResponse({ circuit_breakers: [snapshot] })
      ));

      const client = createRunsClient({ baseUrl: "http://localhost:8080" });
      const result = await client.getCircuitBreakers();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(snapshot);
    });
  });

  describe("auth", () => {
    it("injects Authorization header when getToken is provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
        agent_id: "test",
        window: "24h",
        uptime_pct: 1,
        error_rate: 0,
        p50_latency_ms: 0,
        p99_latency_ms: 0,
        run_count: 0,
        last_run_at: null,
        last_status: null,
      } satisfies AgentHealth)));

      const mockGetToken = vi.fn().mockResolvedValue("test-jwt-token");
      const client = createRunsClient({
        baseUrl: "http://localhost:8080",
        getToken: mockGetToken,
      });

      await client.getHealth("test");

      const [, callOpts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit];
      const headers = callOpts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-jwt-token");
      expect(mockGetToken).toHaveBeenCalledOnce();
    });
  });
});
