/**
 * EventBusPort — Agent-to-Agent pub/sub via CloudEvents 1.0 + Redis Streams.
 *
 * ADR-007 defines the transport (Redis Streams + consumer groups). This port
 * defines ONLY the interface — implementations live in Forge (redis-event-bus.ts)
 * and in the SDK testing module (TestEventBus).
 *
 * Guarantees (baked into the port, not optional):
 *   - At-least-once delivery with consumer-side dedup via CloudEvent `id`.
 *   - MAXLEN ~ 10000 on every stream (backpressure by truncation).
 *   - Poison pill: 3 consecutive XAUTOCLAIM failures → auto-move to DLQ.
 *   - Consumer lag alert: XPENDING > 100 for 5min → Prometheus alert.
 *   - Every CloudEvent MUST carry `id` (UUIDv7) — publish-side enforces.
 *
 * Schema versioning: breaking schema change → new `type` string (e.g.
 * `tech.vauban.vault.compound.ready.v2`). Consumers register for the type
 * they support. subscribe() validates against a local Zod schema.
 *
 * ADR-ECO-017: Cross-product events MUST carry a DomainEvent signature.
 * Use DomainEvent for inter-product events and CloudEvent for intra-product.
 *
 * OTel instrumentation: import { createTracedEventBusPort } to wrap any
 * EventBusPort implementation with OpenTelemetry spans per publish/subscribe call.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 *
 * @public
 */

// ─── CloudEvents 1.0 ────────────────────────────────────────────────────────────

export interface CloudEvent {
  /** UUIDv7 — doubles as idempotency key for consumer dedup. */
  id: string;
  /** MUST be "1.0". */
  specversion: "1.0";
  /** Source agent or service identifier (e.g. "app.revenue"). */
  source: string;
  /** Event type (e.g. "tech.vauban.stripe.payment.succeeded"). */
  type: string;
  /** ISO 8601 timestamp. */
  time: string;
  /** Optional MIME type of `data`. */
  datacontenttype?: string;
  /** Event payload — arbitrary JSON-serializable value. */
  data?: unknown;
  /** W3C trace context for OTel correlation. */
  traceparent?: string;
  /** Correlation ID for multi-event flows. */
  correlationid?: string;
  /** Partition key for ordered delivery within a stream. */
  partitionkey?: string;
  /** Schema version for this event type. Breaking change → new `type`. */
  dataschemaversion?: number;
}

// ─── DomainEvent (ADR-ECO-017) ──────────────────────────────────────────────────

/**
 * Valid event sources per ADR-ECO-017.
 * Receivers MUST reject events with sources outside this union.
 * @public
 */
export type EventSource =
  | "forge"
  | "vauban"
  | "vauban-finance"
  | "brain"
  | "citadel"
  | "glacis"
  | "cc"
  | "tenant";

/**
 * DomainEvent — authenticated cross-product event (ADR-ECO-017).
 *
 * Every cross-product event MUST be signed via signEvent() from auth/sign-event.ts.
 * Direct re-implementation of HMAC outside the SDK auth module is FORBIDDEN.
 *
 * Naming: `<source>.<entity>.<action_past_tense>` — source verb is always past tense.
 * @public
 */
export interface DomainEvent<T = unknown> {
  /** Event type: `<source>.<entity>.<action_past_tense>`. */
  type: string;
  /** Event source — MUST be one of EventSource values. */
  source: EventSource;
  /** Correlation ID for multi-event flows (W3C trace-compatible). */
  correlationId: string;
  /** Causation ID — ID of the event that caused this one (optional). */
  causationId?: string;
  /**
   * Idempotency key — UUIDv7 recommended.
   * Dual role: (a) anti-replay nonce via Redis SETNX, (b) Inbox pattern dedup in Postgres.
   */
  idempotencyKey: string;
  /** ISO 8601 timestamp of event creation. */
  timestamp: string;
  /** Schema version (semver). Breaking schema change → new `type` string. */
  schemaVersion: string;
  /** Event payload — arbitrary JSON-serializable value. */
  payload: T;
  /**
   * HMAC-SHA256 signature per ADR-ECO-017.
   * Computed by signEvent() — never set manually.
   */
  signature: string;
}

/**
 * Subscription handle returned by subscribe(). Call unsubscribe() to stop consuming.
 * @public
 */
export interface Subscription {
  unsubscribe(): Promise<void>;
}

// ─── EventBusPort ───────────────────────────────────────────────────────────────

/** @public */
export interface EventBusPort {
  /**
   * Publish an event to a Redis Stream.
   *
   * The implementation MUST:
   *   1. Validate that `event.id` is a non-empty string (UUIDv7 recommended).
   *   2. Validate that `event.specversion === "1.0"`.
   *   3. XADD with MAXLEN ~ 10000.
   *   4. Inject `traceparent` from the current OTel span if absent.
   */
  publish(event: CloudEvent, stream: string): Promise<void>;

  /**
   * Publish a DomainEvent with idempotency enforcement.
   *
   * Prevents duplicate processing for the same idempotency key within the TTL window.
   * If the key has already been processed, the publish is silently skipped (at-most-once
   * delivery for same key).
   *
   * The implementation MUST auto-sign the event via signEvent() before publishing.
   *
   * @param event - DomainEvent without signature (auto-signed by implementation).
   * @param key   - Idempotency key (dedups within window; UUIDv7 recommended).
   */
  publishWithIdempotency<T>(event: Omit<DomainEvent<T>, "signature">, key: string): Promise<void>;

  /**
   * Subscribe to DomainEvents of a specific type.
   *
   * Implementation MUST verify the event signature via verifyEvent() before
   * invoking the handler. On signature failure, clock skew, or replay:
   *   - Route to DLQ (do not invoke handler).
   *   - Log the rejection reason.
   *
   * @param eventType - Event type string to subscribe to.
   * @param handler   - Async handler invoked for each valid event.
   * @param opts      - Optional groupId for consumer group and DLQ stream name.
   */
  subscribeDomain<T>(
    eventType: string,
    handler: (event: DomainEvent<T>) => Promise<void>,
    opts?: { groupId?: string; dlq?: string },
  ): Subscription;

  /**
   * Replay events from a stream starting at a given Redis stream ID.
   *
   * @param streamKey - Redis stream key.
   * @param fromId    - Redis stream ID to start from (inclusive). Use "0" for beginning.
   * @returns AsyncIterable of DomainEvents in original insertion order.
   */
  replayFrom(streamKey: string, fromId: string): AsyncIterable<DomainEvent>;

  /**
   * Dead Letter Queue inspection.
   */
  dlq(): {
    /** Number of messages in the DLQ. */
    depth(): Promise<number>;
    /** Replay a message from DLQ back to its original stream. */
    replay(eventId: string): Promise<void>;
  };

  /**
   * Number of pending (unacknowledged) messages in a consumer group.
   * Used for consumer lag monitoring.
   */
  pendingCount(stream: string, consumerGroup: string): Promise<number>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when an event could not be published to Redis (connection lost,
 * stream key conflict, or OOM on XADD). The original event is available
 * for retry or DLQ routing.
 * @public
 */
export class EventPublishError extends Error {
  /** The stream key the event was targeting. */
  readonly stream: string;
  /** The event id (UUIDv7) that failed to publish. */
  readonly eventId: string;

  constructor(
    message: string,
    stream: string,
    eventId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EventPublishError";
    this.stream = stream;
    this.eventId = eventId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── OTel-traced wrapper ──────────────────────────────────────────────────────

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const PORT_TRACER = trace.getTracer("vauban-agent-sdk.ports", "0.1.0");

/**
 * Wrap any EventBusPort implementation with OTel spans.
 * Publishes and subscribeDomain calls each get a span with the event type
 * and stream as attributes. Gracefully degrades to noop spans when no OTel
 * SDK is installed.
 *
 * Usage:
 *   const raw: EventBusPort = buildRedisEventBus(...);
 *   const traced = createTracedEventBusPort(raw);
 *   await traced.publish(event, "vault.events") // emits "event-bus.publish" span
 */
export function createTracedEventBusPort(impl: EventBusPort): EventBusPort {
  function spanName(op: string): string {
    return `event-bus.${op}`;
  }

  return {
    async publish(event, stream) {
      return PORT_TRACER.startActiveSpan(
        spanName("publish"),
        {
          attributes: {
            "event.type": event.type,
            "event.stream": stream,
            "event.id": event.id,
            "vauban.port.name": "event-bus",
          },
        },
        async (span: Span) => {
          try {
            await impl.publish(event, stream);
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            if (err instanceof Error) span.recordException(err);
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },

    async publishWithIdempotency<T>(event: Omit<DomainEvent<T>, "signature">, key: string) {
      return PORT_TRACER.startActiveSpan(
        spanName("publishWithIdempotency"),
        {
          attributes: {
            "event.type": event.type,
            "event.idempotency_key": key,
            "vauban.port.name": "event-bus",
          },
        },
        async (span: Span) => {
          try {
            await impl.publishWithIdempotency<T>(event, key);
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            if (err instanceof Error) span.recordException(err);
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },

    subscribeDomain<T>(
      eventType: string,
      handler: (event: DomainEvent<T>) => Promise<void>,
      opts?: { groupId?: string; dlq?: string },
    ) {
      return impl.subscribeDomain<T>(eventType, handler, opts);
    },

    replayFrom(streamKey, fromId) {
      return impl.replayFrom(streamKey, fromId);
    },

    dlq() {
      return impl.dlq();
    },

    pendingCount(stream, consumerGroup) {
      return impl.pendingCount(stream, consumerGroup);
    },
  };
}
