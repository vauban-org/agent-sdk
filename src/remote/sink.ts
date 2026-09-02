/**
 * remote/sink — the SessionEventSink port.
 *
 * The agent loop emits `SessionEvent`s to a `SessionEventSink`. The sink is
 * the seam between the loop (producer) and any transport (consumer): a no-op
 * sink when remote-control is off, the `RemoteControlHub` when it is on.
 *
 * `emit` MUST be non-blocking and MUST NOT throw — the agent loop is the hot
 * path and a slow/broken observer must never stall or crash a run.
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

import type { SessionEvent } from "./events.js";

/**
 * Consumer of the agent's live event stream.
 * @public
 */
export interface SessionEventSink {
  /** Record one event. Non-blocking, never throws. */
  emit(event: SessionEvent): void;
}

/**
 * No-op sink — the default when remote-control is not active.
 * @public
 */
export const NOOP_SESSION_SINK: SessionEventSink = {
  emit(): void {
    /* discard */
  },
};

/**
 * Fan-out sink — forwards every event to several sinks. Useful to tee the
 * stream (e.g. the remote hub + a local trajectory recorder). A throwing
 * child sink is isolated so it cannot break the others.
 * @public
 */
export function teeSink(...sinks: SessionEventSink[]): SessionEventSink {
  return {
    emit(event: SessionEvent): void {
      for (const s of sinks) {
        try {
          s.emit(event);
        } catch {
          /* an observer must never break the run */
        }
      }
    },
  };
}
