/**
 * ObservabilityPort — cross-cutting telemetry for Vauban Integration Spine.
 *
 * Implements S0 §6 (ObservabilityPort, port #14): OpenTelemetry-compatible spans,
 * structured event logging, metrics, and graceful shutdown. Adapters emit to
 * Prometheus, Sentry, audit logs, or custom backends.
 *
 * Design: structured types only — no hard dependency on @opentelemetry/api.
 * Real OTel Spans satisfy the structural Span interface.
 *
 * Reference: S0 §6 type definition + createTracedBrainPort pattern in brain.ts
 */

// ─── Attribute value types ────────────────────────────────────────────────────

export type AttrValue = string | number | boolean | (string | number)[];

export interface SpanAttributes {
  readonly [key: string]: AttrValue;
}

// ─── Span interface (structural — compatible with OTel Span) ─────────────────

export interface Span {
  /** Record a key-value attribute on this span. */
  setAttribute(key: string, value: AttrValue): void;

  /** Record an exception / error on this span. */
  recordException(error: Error | unknown): void;

  /**
   * Set the final status of this span.
   * @param code 'OK', 'ERROR', or other OTel SpanStatusCode equivalent
   * @param message optional message (used when code is 'ERROR')
   */
  setStatus(opts: { code: string; message?: string }): void;

  /** Mark the span as complete. */
  end(): void;
}

// ─── Observability event types ────────────────────────────────────────────────

export type EventSeverity = "debug" | "info" | "warn" | "error" | "fatal";

export interface ObservabilityEvent {
  readonly name: string;
  readonly severity: EventSeverity;
  readonly attributes?: Record<string, AttrValue>;
  readonly timestamp?: number; // unix ms, default = Date.now()
  readonly traceId?: string; // OTel W3C trace ID
  readonly spanId?: string; // OTel span ID
}

// ─── Metric types ────────────────────────────────────────────────────────────

export type MetricType = "gauge" | "counter" | "histogram";

export interface MetricInput {
  readonly name: string;
  readonly type: MetricType;
  readonly value: number;
  readonly labels?: Record<string, string>;
  readonly timestamp?: number; // unix ms, default = Date.now()
}

// ─── ObservabilityPort interface ─────────────────────────────────────────────

/** @public */
export interface ObservabilityPort {
  /**
   * Start a new OTel-compatible span.
   *
   * @param name span name (e.g., "workflow.execute", "brain.query")
   * @param attrs optional span attributes
   * @returns Span handle for setAttribute, recordException, setStatus, end calls
   */
  startSpan(name: string, attrs?: SpanAttributes): Span;

  /**
   * Record a structured observability event (log, audit, compliance event).
   *
   * @param event event with name, severity, attributes, optional trace/span IDs
   */
  recordEvent(event: ObservabilityEvent): void;

  /**
   * Record a metric (gauge, counter, histogram).
   *
   * @param metric metric name, type, value, optional labels and timestamp
   */
  recordMetric(metric: MetricInput): void;

  /**
   * Graceful shutdown — flush all pending telemetry.
   * Called at process exit or service shutdown.
   */
  flush(): Promise<void>;
}

// ─── Noop implementation (for tests, fallback, or offline mode) ──────────────

/**
 * NoopObservabilityPort — no-op implementation for tests or offline mode.
 * All calls are discarded; span operations succeed silently.
 * @public
 */
export class NoopObservabilityPort implements ObservabilityPort {
  private readonly noopSpan: Span = {
    setAttribute: () => {},
    recordException: () => {},
    setStatus: () => {},
    end: () => {},
  };

  startSpan(_name: string, _attrs?: SpanAttributes): Span {
    return this.noopSpan;
  }

  recordEvent(_event: ObservabilityEvent): void {
    // no-op
  }

  recordMetric(_metric: MetricInput): void {
    // no-op
  }

  async flush(): Promise<void> {
    // no-op
  }
}

// ─── Typed errors ────────────────────────────────────────────────────────────

export class ObservabilityError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ObservabilityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ObservabilityFlushTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly cause?: unknown,
  ) {
    super(`Observability flush timed out after ${timeoutMs}ms`);
    this.name = "ObservabilityFlushTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
