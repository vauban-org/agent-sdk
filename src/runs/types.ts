/**
 * Runs module types — @vauban-org/agent-sdk v0.5.3 (sprint-523 Bloc 3).
 *
 * Mirrors:
 *   - src/routes/run-stream.ts  (RunStepStreamEventName, RunStepStreamEvent)
 *   - src/routes/agent-health.ts (AgentHealth, Anomaly, CircuitBreakerSnapshot)
 *
 * Intentionally kept free of server-side dependencies.
 */

import type { RunStep } from "../proof/types.js";

export type { RunStep };

export type RunStreamEventName =
  | "step_existing"
  | "step_new"
  | "run_complete"
  | "ping"
  | "error";

export interface RunStreamEvent {
  name: RunStreamEventName;
  id?: string;
  data:
    | RunStep
    | { status: string; duration_ms?: number }
    | { error: string }
    | undefined;
}

export interface AgentHealth {
  agent_id: string;
  window: "24h" | "7d" | "30d";
  uptime_pct: number;
  error_rate: number;
  p50_latency_ms: number;
  p99_latency_ms: number;
  run_count: number;
  last_run_at: string | null;
  last_status: string | null;
}

export interface Anomaly {
  agent_id: string;
  cost_dimension: string;
  run_id: string | null;
  observed: number;
  baseline_mean: number;
  baseline_stddev: number;
  z_score: number;
  severity: "low" | "medium" | "high";
  detected_at: string;
}

export interface CircuitBreakerSnapshot {
  provider: string;
  state: "closed" | "open" | "half-open";
  failure_count: number;
  last_failure: string | null;
  last_success: string | null;
  reset_after_ms: number | null;
}
