/**
 * TestEventBus — In-memory EventBusPort for unit testing.
 *
 * No Redis dependency. Messages are stored in a Map and dispatched
 * synchronously to in-process subscribers. Use for agent unit tests
 * that need to publish/subscribe without infrastructure.
 *
 * Extended in SDK v0.17.0 (sprint-615:quick-7) with:
 *   - publishWithIdempotency (dedup via InMemoryNonceStore)
 *   - subscribeDomain (signature verification + DLQ routing)
 *   - replayFrom (ordered replay from a stream ID)
 *
 * @public
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemoryNonceStore } from "../auth/nonce-store.js";
import { signEvent } from "../auth/sign-event.js";
import { verifyEvent } from "../auth/verify-event.js";
import type { CloudEvent, DomainEvent, EventBusPort, Subscription } from "../ports/event-bus.js";

const TEST_TRACER = trace.getTracer("vauban-agent-sdk.ports.test", "0.1.0");

type CloudHandler = (event: CloudEvent) => Promise<void>;
type DomainHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

interface StoredDomainEvent {
  streamId: string;
  event: DomainEvent;
}

export class TestEventBus implements EventBusPort {
  private streams = new Map<string, CloudEvent[]>();
  private subscribers = new Map<string, Map<string, CloudHandler>>();
  private dlqMessages = new Map<string, CloudEvent>();
  private _consumed = new Map<string, CloudEvent[]>();

  // Domain event support
  private domainStreams = new Map<string, StoredDomainEvent[]>();
  private domainSubscribers = new Map<string, Map<string, DomainHandler>>();
  private domainDlq: DomainEvent[] = [];
  // Two separate stores: publish dedup (producer side) vs consumer-side replay detection
  private publishIdempotencyStore = new InMemoryNonceStore();
  private consumerNonceStore = new InMemoryNonceStore();

  /**
   * Secret used to auto-sign events in publishWithIdempotency.
   * Override in tests via setSigningSecret().
   */
  private signingSecret = "test-secret-32-bytes-padding-here";

  /** Override the signing secret for tests that check signature roundtrip. */
  setSigningSecret(secret: string): void {
    this.signingSecret = secret;
  }

  // ─── EventBusPort ──────────────────────────────────────────────────────────

  async publish(event: CloudEvent, stream: string): Promise<void> {
    return TEST_TRACER.startActiveSpan(
      "event-bus.publish",
      {
        attributes: {
          "event.type": event.type,
          "event.stream": stream,
          "event.id": event.id,
          "vauban.port.name": "event-bus",
          "vauban.port.impl": "TestEventBus",
        },
      },
      async (span: Span) => {
        try {
          if (!event.id) throw new Error("CloudEvent.id is required");
          if (event.specversion !== "1.0") throw new Error("CloudEvent.specversion must be 1.0");

          const events = this.streams.get(stream) ?? [];
          events.push(event);
          this.streams.set(stream, events);

          // Track consumed events per stream
          const consumed = this._consumed.get(stream) ?? [];
          consumed.push(event);
          this._consumed.set(stream, consumed);

          // Dispatch to subscribers
          const streamSubs = this.subscribers.get(stream);
          if (streamSubs) {
            for (const handler of streamSubs.values()) {
              await handler(event);
            }
          }
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
  }

  async publishWithIdempotency<T>(
    event: Omit<DomainEvent<T>, "signature">,
    key: string,
  ): Promise<void> {
    return TEST_TRACER.startActiveSpan(
      "event-bus.publishWithIdempotency",
      {
        attributes: {
          "event.type": event.type,
          "event.idempotency_key": key,
          "vauban.port.name": "event-bus",
          "vauban.port.impl": "TestEventBus",
        },
      },
      async (span: Span) => {
        try {
          // Dedup: silently skip if key already processed (producer-side)
          const isNew = await this.publishIdempotencyStore.setNX(key, 10 * 60 * 1000);
          if (!isNew) {
            span.setAttribute("event.dedup.skipped", true);
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }

          // Auto-sign the event
          const signature = signEvent(event as Omit<DomainEvent, "signature">, this.signingSecret);
          const signed: DomainEvent<T> = {
            ...(event as DomainEvent<T>),
            signature,
          };

          // Store in domain stream
          const streamKey = `domain:${event.type}`;
          const stored = this.domainStreams.get(streamKey) ?? [];
          const streamId = `${Date.now()}-${stored.length}`;
          stored.push({ streamId, event: signed as DomainEvent });
          this.domainStreams.set(streamKey, stored);

          // Dispatch to domain subscribers
          const typeSubs = this.domainSubscribers.get(event.type);
          if (typeSubs) {
            for (const handler of typeSubs.values()) {
              await (handler as DomainHandler<T>)(signed);
            }
          }
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
  }

  subscribe(
    stream: string,
    consumerGroup: string,
    handler: (event: CloudEvent) => Promise<void>,
  ): Promise<() => void> {
    const key = `${stream}:${consumerGroup}`;
    let streamSubs = this.subscribers.get(stream);
    if (!streamSubs) {
      streamSubs = new Map();
      this.subscribers.set(stream, streamSubs);
    }
    streamSubs.set(key, handler);

    return Promise.resolve(() => {
      const subs = this.subscribers.get(stream);
      if (subs) {
        subs.delete(key);
        if (subs.size === 0) this.subscribers.delete(stream);
      }
    });
  }

  subscribeDomain<T>(
    eventType: string,
    handler: (event: DomainEvent<T>) => Promise<void>,
    opts?: { groupId?: string; dlq?: string },
  ): Subscription {
    const groupId = opts?.groupId ?? "default";
    const key = `${eventType}:${groupId}`;

    let typeSubs = this.domainSubscribers.get(eventType);
    if (!typeSubs) {
      typeSubs = new Map();
      this.domainSubscribers.set(eventType, typeSubs);
    }

    // Wrap handler with signature verification + DLQ routing
    const wrappedHandler: DomainHandler = async (event: DomainEvent) => {
      try {
        await verifyEvent(event, this.signingSecret, {
          nonceStore: this.consumerNonceStore,
        });
        await (handler as DomainHandler<T>)(event as DomainEvent<T>);
      } catch {
        // Route to DLQ on any auth failure
        this.domainDlq.push(event);
      }
    };

    typeSubs.set(key, wrappedHandler);

    return {
      unsubscribe: async () => {
        const subs = this.domainSubscribers.get(eventType);
        if (subs) {
          subs.delete(key);
          if (subs.size === 0) this.domainSubscribers.delete(eventType);
        }
      },
    };
  }

  async *replayFrom(streamKey: string, fromId: string): AsyncIterable<DomainEvent> {
    const stored = this.domainStreams.get(streamKey) ?? [];

    for (const { streamId, event } of stored) {
      // Compare stream IDs lexicographically (Redis stream ID format: timestamp-seq)
      if (streamId >= fromId) {
        yield event;
      }
    }
  }

  dlq(): { depth(): Promise<number>; replay(eventId: string): Promise<void> } {
    return {
      depth: async () => this.dlqMessages.size,
      replay: async (eventId: string) => {
        const event = this.dlqMessages.get(eventId);
        if (event) {
          this.dlqMessages.delete(eventId);
          // Re-publish to original stream (inferred from type convention)
          const stream = `vauban.events.${event.type.split(".").slice(1, 3).join(".")}`;
          await this.publish(event, stream);
        }
      },
    };
  }

  async pendingCount(_stream: string, _consumerGroup: string): Promise<number> {
    return 0;
  }

  // ─── Test Helpers ─────────────────────────────────────────────────────────

  /** All events published to a stream. */
  published(stream: string): CloudEvent[] {
    return this.streams.get(stream) ?? [];
  }

  /** All events consumed (published) to a stream since creation. */
  consumed(stream: string): CloudEvent[] {
    return this._consumed.get(stream) ?? [];
  }

  /** Move an event to DLQ (simulates poison pill). */
  moveToDlq(event: CloudEvent): void {
    this.dlqMessages.set(event.id, structuredClone(event));
  }

  /** Domain DLQ — events rejected by signature/clock/replay checks. */
  get domainDlqEvents(): DomainEvent[] {
    return [...this.domainDlq];
  }

  /** Clear all state. */
  reset(): void {
    this.streams.clear();
    this.subscribers.clear();
    this.dlqMessages.clear();
    this._consumed.clear();
    this.domainStreams.clear();
    this.domainSubscribers.clear();
    this.domainDlq.length = 0;
    this.publishIdempotencyStore.reset();
    this.consumerNonceStore.reset();
  }
}
