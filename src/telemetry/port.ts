/**
 * TelemetryPort — sovereign multi-sink observability for agent runs.
 *
 * Per ADR-ECO-039 (accepted 2026-05-16). Sink-based interface replaces the
 * implicit coupling between agent-sdk and the CC `agent_run` table (legacy
 * `AgentRunTracker`). Callers configure 0..N sinks; the `TelemetryBus`
 * fans events out non-blockingly.
 *
 * Three modes :
 *   1. Standalone   : `[stdoutTelemetrySink(), localSqliteTelemetrySink()]`
 *   2. + CC SaaS    : add `commandCenterTelemetrySink({apiKey})`
 *   3. Tiered       : same code, API key changes entitlement server-side
 *
 * Ref: command-center:sprint-693:port-interface
 * @public
 */

// ─── Run lifecycle types (compatible with legacy AgentRunTracker) ────────────

export interface TelemetryRunStart {
  /** Caller-generated run id (matches the OODA loop's runId / trace). */
  runId: string;
  agentId: string;
  agentVersion: string;
  model: string;
  provider: string;
  /** Optional tenant scoping — required by the CC sink. */
  tenantId?: string;
  /** OTel trace id for replay linkage. */
  traceId?: string;
  /** ISO8601 timestamp of cycle start. */
  startedAt: string;
}

/** @public */
export interface TelemetryRunStep {
  /** Monotonic step index within the run, starting at 0. */
  stepIndex: number;
  /** OODA phase or step kind ("observe" | "orient" | "decide" | "act" | ...). */
  kind: string;
  /** Status of THIS step (not the whole run). */
  status: "completed" | "failed" | "skipped";
  inputTokens: number;
  outputTokens: number;
  toolCalls?: number;
  /**
   * USD cost delta. MUST be >= 0. Use 0 for non-LLM steps.
   * Fixed(6) precision recommended.
   */
  costUsd: number;
  /** Optional duration in ms — useful for OTLP span span_start/span_end. */
  durationMs?: number;
  /** Optional metadata. Hashed at sink boundary unless `includePayloads`. */
  metadata?: Record<string, unknown>;
}

/**
 * Run final status.
 *
 * NEW (sprint-693) : "skipped" — added so that session_guard /
 * risk_guard / heap_exceeded short-circuits are observably distinct
 * from "success" or "failed".
 * @public
 */
export type TelemetryRunStatus = "success" | "failed" | "skipped" | "timeout" | "incoherent";

/** @public */
export interface TelemetryRunFinish {
  status: TelemetryRunStatus;
  /** Free-text reason — e.g. "session_guard:business-hours". */
  stopReason?: string;
  /** Only set when status === "failed" | "incoherent". */
  errorMessage?: string;
  /** ISO8601 timestamp of cycle finish. */
  finishedAt: string;
  /** Optional cumulative totals — sinks may compute or trust caller. */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  totalToolCalls?: number;
  /**
   * Outcome record emitted by the agent's `outcomeMapping(feedback)`. The SDK
   * propagates it as-is on the finish event ; consuming sinks decide what to
   * do with it (CC sink writes `agent_run.outcome_quality`, OTLP collector
   * surfaces as span attributes, etc.). Pure data — no coupling to any
   * specific backend.
   *
   * @since 1.6.0 (ADR-ECO-039)
   */
  outcome?: {
    type: string;
    valueCents: number;
    /** Business quality of the cycle output, 0..1. Distinct from confidence. */
    quality?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
  };
}

// ─── Sink interface ──────────────────────────────────────────────────────────

/**
 * TelemetrySink — pluggable destination for run lifecycle events.
 *
 * Contract :
 *   - `start` is called ONCE per run before any `step`.
 *   - `step` MAY be called 0..N times after start; the bus serialises per-run.
 *   - `finish` is called ONCE after the last `step` (or directly after `start`
 *     for skipped runs).
 *   - All methods MUST be idempotent w.r.t. their (runId, stepIndex) pair —
 *     the bus may retry on transient sink failures.
 *   - Implementations MUST NOT throw on transient errors ; return a rejected
 *     Promise instead so the bus can isolate the failure.
 *
 * Implementations should NOT block the agent loop. Long-running I/O should
 * be batched/queued internally.
 * @public
 */
export interface TelemetrySink {
  /** Unique sink identifier — used for audit log + Prometheus labels. */
  readonly name: string;

  /**
   * Record run start. Returns a sink-local reference (e.g. DB UUID, file
   * offset, span id) the bus may pass back to `step` / `finish` for
   * correlation. Return value is opaque to the bus.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: opaque/absent return; void is intentional.
  start(event: TelemetryRunStart): Promise<string | void>;

  /** Record a single OODA step delta. */
  step(runId: string, delta: TelemetryRunStep): Promise<void>;

  /** Record run finish. */
  finish(runId: string, event: TelemetryRunFinish): Promise<void>;

  /**
   * Flush pending I/O (best-effort). Called on agent shutdown.
   * Implementations without a buffer can no-op.
   */
  flush?(): Promise<void>;
}

// ─── NOOP — default when no sinks configured ─────────────────────────────────

/**
 * No-op sink. The bus uses this when no sinks are configured, so callers
 * never need to null-check.
 * @public
 */
export const NOOP_TELEMETRY_SINK: TelemetrySink = {
  name: "noop",
  async start() {
    /* no-op */
  },
  async step() {
    /* no-op */
  },
  async finish() {
    /* no-op */
  },
};

// ─── Error type ──────────────────────────────────────────────────────────────

/**
 * Thrown only at the BUS boundary when ALL sinks fail. Individual sink
 * failures are warned and isolated (see `TelemetryBus`).
 * @public
 */
export class TelemetrySinkError extends Error {
  constructor(
    message: string,
    public readonly sinkName: string,
    public readonly cause?: unknown,
  ) {
    super(`[telemetry:${sinkName}] ${message}`);
    this.name = "TelemetrySinkError";
  }
}
