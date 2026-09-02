/**
 * OutcomePort — post-run outcome instrumentation.
 *
 * Host attributes a monetary value to each agent run via its
 * domain-specific rules (config/outcomes.yaml in CC). The agent simply
 * calls recordOutcomeAsync after its tracker.finish() — fire-and-forget.
 *
 * OTel instrumentation: import { createTracedOutcomePort } to wrap any
 * OutcomePort implementation with OpenTelemetry spans. Gracefully degrades
 * to noop spans when no OTel SDK is installed.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const PORT_TRACER = trace.getTracer("vauban-agent-sdk.ports", "0.1.0");

/** @public */
export interface AgentRunRef {
  /** agent_run.id (UUID) produced by AgentRunTracker. */
  id: string;
  /** Logical agent identity, matches AgentDescriptor.id. */
  agent_id: string;
  /** Hash / caller-generated run id for trace correlation. */
  run_id?: string;
  /** Already-linked outcome id; idempotency guard. */
  outcome_id?: string | null;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when the outcome store write fails (DB connection lost, serialization
 * error, or queue full). Since recordOutcomeAsync is fire-and-forget, this
 * error is surfaced only when the implementation chooses to throw synchronously
 * (e.g., during validation or when the write queue is persistently full).
 * @public
 */
export class OutcomeWriteError extends Error {
  readonly runId: string;

  constructor(
    message: string,
    runId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OutcomeWriteError";
    this.runId = runId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export interface OutcomePort {
  /**
   * Enqueue outcome attribution. Fire-and-forget: never throws,
   * never blocks the agent lifecycle. Errors are logged by the impl.
   */
  recordOutcomeAsync(run: AgentRunRef): void;
}

/**
 * Wrap any OutcomePort implementation with OTel spans.
 * The span captures the run id and agent_id as attributes.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 *
 * Usage:
 *   const raw: OutcomePort = buildPostgresOutcome(...);
 *   const traced = createTracedOutcomePort(raw);
 *   traced.recordOutcomeAsync({...}) // emits "outcome.recordOutcomeAsync" span
 */
export function createTracedOutcomePort(impl: OutcomePort): OutcomePort {
  return {
    recordOutcomeAsync(run: AgentRunRef): void {
      PORT_TRACER.startActiveSpan(
        "outcome.recordOutcomeAsync",
        {
          attributes: {
            "outcome.run_id": run.id,
            "outcome.agent_id": run.agent_id,
            "vauban.port.name": "outcome",
          },
        },
        (span: Span) => {
          try {
            impl.recordOutcomeAsync(run);
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (err) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            span.recordException(err as Error);
          } finally {
            span.end();
          }
        },
      );
    },
  };
}
