/**
 * Prometheus metrics factory for SDK agents.
 *
 * Promoted from forge/src/agents/shared/metrics.ts (Vague 1.B.4).
 *
 * prom-client is an optional peer dependency. If absent, all metrics are
 * no-op stubs so consumers that do not use Prometheus can still import this
 * module without errors.
 *
 * @public @since 0.18.0
 */

import { createRequire } from "node:module";

// ─── prom-client types (type-only, peer dep) ──────────────────────────────────

// Type-only imports — erased at compile time. The actual module is loaded
// lazily via createRequire so the factory works even when prom-client is absent.
type PromClient = typeof import("prom-client");
type Registry = import("prom-client").Registry;
type Counter<L extends string> = import("prom-client").Counter<L>;
type Histogram<L extends string> = import("prom-client").Histogram<L>;

// ─── Lazy prom-client loader ──────────────────────────────────────────────────

let _prom: PromClient | null | undefined;

/**
 * Load prom-client synchronously once, cache result.
 * Returns null if prom-client is not installed.
 */
function loadPromClient(): PromClient | null {
  if (_prom !== undefined) return _prom;
  try {
    const req = createRequire(import.meta.url);
    _prom = req("prom-client") as PromClient;
  } catch {
    _prom = null;
  }
  return _prom;
}

// ─── No-op stubs ──────────────────────────────────────────────────────────────

/** Minimal no-op counter. Safe to call `.inc()` / `.labels()` without effect. */
function noopCounter<L extends string>(): Counter<L> {
  const stub = {
    inc: () => undefined,
    labels: () => stub as unknown as ReturnType<Counter<L>["labels"]>,
    reset: () => undefined,
    remove: () => undefined,
  };
  return stub as unknown as Counter<L>;
}

/** Minimal no-op histogram. Safe to call `.observe()` / `.startTimer()` without effect. */
function noopHistogram<L extends string>(): Histogram<L> {
  const stub = {
    observe: () => undefined,
    startTimer: () => () => 0 as number,
    labels: () => stub as unknown as ReturnType<Histogram<L>["labels"]>,
    reset: () => undefined,
    remove: () => undefined,
    zero: () => undefined,
  };
  return stub as unknown as Histogram<L>;
}

// ─── Public interfaces ────────────────────────────────────────────────────────

/**
 * Standard metrics exposed by every SDK agent.
 *
 * Label sets follow Prometheus conventions: snake_case, no spaces.
 *
 * @public
 */
export interface AgentMetrics {
  /** Incremented when an OODA cycle begins. */
  cycleStarted: Counter<"agent_id">;
  /** Incremented when an OODA cycle finishes; `outcome` = "success" | "error" | "skipped". */
  cycleCompleted: Counter<"agent_id" | "outcome">;
  /** Duration of an OODA cycle by phase ("observe"|"orient"|"decide"|"act"|"total"). */
  cycleDuration: Histogram<"agent_id" | "phase">;
  /** Incremented when a HITL approval request is sent. */
  hitlRequested: Counter<"agent_id">;
  /** Incremented when a HITL request resolves; `decision` = "approved" | "rejected" | "timeout". */
  hitlResolved: Counter<"agent_id" | "decision">;
  /** Incremented for every LLM API call attempted. */
  llmCallCount: Counter<"agent_id" | "provider">;
  /** Total tokens used; `direction` = "input" | "output". */
  llmTokensUsed: Counter<"agent_id" | "provider" | "direction">;
  /** Cumulative LLM cost in USD (Counter, never resets). */
  llmCostUsd: Counter<"agent_id" | "provider">;
}

/**
 * Options for `createAgentMetrics`.
 *
 * @public
 */
export interface CreateAgentMetricsOptions {
  /**
   * prom-client Registry to register metrics on.
   * Defaults to a fresh isolated Registry per call so multiple consumers do
   * not collide on the global default registry.
   * Pass your own Registry to aggregate with other metrics.
   */
  registry?: Registry;
  /**
   * Metric name prefix (must end with `_`).
   * @default "agent_"
   * @example "forge_"
   */
  prefix?: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a set of standard Prometheus metrics for an SDK agent.
 *
 * If prom-client is not installed (optional peer dependency), returns no-op
 * stubs so the call site does not need to handle `null`.
 *
 * @example
 * ```ts
 * import { createAgentMetrics } from "@vauban-org/agent-sdk/metrics";
 *
 * const m = createAgentMetrics({ prefix: "forge_" });
 * m.cycleStarted.inc({ agent_id: "my-agent" });
 * ```
 *
 * @public
 */
export function createAgentMetrics(opts: CreateAgentMetricsOptions = {}): AgentMetrics {
  const prefix = opts.prefix ?? "agent_";
  const prom = loadPromClient();

  if (prom === null) {
    return {
      cycleStarted: noopCounter<"agent_id">(),
      cycleCompleted: noopCounter<"agent_id" | "outcome">(),
      cycleDuration: noopHistogram<"agent_id" | "phase">(),
      hitlRequested: noopCounter<"agent_id">(),
      hitlResolved: noopCounter<"agent_id" | "decision">(),
      llmCallCount: noopCounter<"agent_id" | "provider">(),
      llmTokensUsed: noopCounter<"agent_id" | "provider" | "direction">(),
      llmCostUsd: noopCounter<"agent_id" | "provider">(),
    };
  }

  const registry = opts.registry ?? new prom.Registry();

  function counter<L extends string>(name: string, help: string, labelNames: L[]): Counter<L> {
    // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
    return new prom!.Counter({
      name: `${prefix}${name}`,
      help,
      labelNames,
      registers: [registry],
    });
  }

  function histogram<L extends string>(
    name: string,
    help: string,
    labelNames: L[],
    buckets?: number[],
  ): Histogram<L> {
    // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
    return new prom!.Histogram({
      name: `${prefix}${name}`,
      help,
      labelNames,
      // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
      buckets: buckets ?? prom!.linearBuckets(0, 500, 12),
      registers: [registry],
    });
  }

  return {
    cycleStarted: counter<"agent_id">("cycle_started_total", "OODA cycles started", ["agent_id"]),
    cycleCompleted: counter<"agent_id" | "outcome">(
      "cycle_completed_total",
      "OODA cycles completed",
      ["agent_id", "outcome"],
    ),
    cycleDuration: histogram<"agent_id" | "phase">(
      "cycle_duration_ms",
      "OODA cycle duration in milliseconds",
      ["agent_id", "phase"],
    ),
    hitlRequested: counter<"agent_id">("hitl_requested_total", "HITL requests sent", ["agent_id"]),
    hitlResolved: counter<"agent_id" | "decision">(
      "hitl_resolved_total",
      "HITL requests resolved",
      ["agent_id", "decision"],
    ),
    llmCallCount: counter<"agent_id" | "provider">("llm_calls_total", "LLM API calls", [
      "agent_id",
      "provider",
    ]),
    llmTokensUsed: counter<"agent_id" | "provider" | "direction">(
      "llm_tokens_total",
      "LLM tokens consumed",
      ["agent_id", "provider", "direction"],
    ),
    llmCostUsd: counter<"agent_id" | "provider">(
      "llm_cost_usd_total",
      "Cumulative LLM cost in USD",
      ["agent_id", "provider"],
    ),
  };
}

// ─── Re-export Registry type for convenience ──────────────────────────────────

export type { Registry };
