/**
 * Runs health + anomaly REST clients — @vauban-org/agent-sdk v0.5.3.
 *
 * Wraps:
 *   GET /api/agents/:id/health         → AgentHealth
 *   GET /api/agents/:id/anomalies      → Anomaly[]
 *   GET /api/router/circuit-breakers   → CircuitBreakerSnapshot[]
 *
 * Sprint: command-center:sprint-523:quick-6
 */

import type { AgentHealth, Anomaly, CircuitBreakerSnapshot } from "./types.js";
import type { SubscribeHandle, SubscribeToRunOptions } from "./subscribe.js";
import { subscribeToRun } from "./subscribe.js";

export interface RunsClientOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
}

async function apiFetch<T>(
  url: string,
  getToken: (() => Promise<string>) | undefined,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (getToken) {
    const token = await getToken();
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`RunsClient: HTTP ${response.status} — ${url}`);
  }
  return response.json() as Promise<T>;
}

export interface RunsClient {
  getHealth(agentId: string, window?: "24h" | "7d" | "30d"): Promise<AgentHealth>;
  getAnomalies(agentId: string): Promise<Anomaly[]>;
  getCircuitBreakers(): Promise<CircuitBreakerSnapshot[]>;
  subscribeToRun(runId: string, opts: Omit<SubscribeToRunOptions, "baseUrl" | "getToken">): Promise<SubscribeHandle>;
}

interface AnomaliesResponse {
  agent_id: string;
  anomalies: Anomaly[];
}

interface CircuitBreakersResponse {
  circuit_breakers: CircuitBreakerSnapshot[];
}

export function createRunsClient(opts: RunsClientOptions): RunsClient {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async getHealth(agentId, window = "24h") {
      const url = `${base}/api/agents/${encodeURIComponent(agentId)}/health?window=${window}`;
      return apiFetch<AgentHealth>(url, opts.getToken);
    },

    async getAnomalies(agentId) {
      const url = `${base}/api/agents/${encodeURIComponent(agentId)}/anomalies`;
      const res = await apiFetch<AnomaliesResponse>(url, opts.getToken);
      return res.anomalies;
    },

    async getCircuitBreakers() {
      const url = `${base}/api/router/circuit-breakers`;
      const res = await apiFetch<CircuitBreakersResponse>(url, opts.getToken);
      return res.circuit_breakers;
    },

    subscribeToRun(runId, subOpts) {
      return subscribeToRun(runId, {
        ...subOpts,
        baseUrl: base,
        getToken: opts.getToken,
      });
    },
  };
}
