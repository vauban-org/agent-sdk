/**
 * remote/port — the RemoteControlPort + the RemoteControlHub reference impl.
 *
 * The hub is the central object of remote-control. It:
 *   - IS a `SessionEventSink` — the agent loop emits events to it;
 *   - keeps a ring buffer of recent events so a reconnecting client can
 *     backfill gap-free (using each event's monotonic `seq`);
 *   - fans events out to live subscribers (the SSE/relay transports);
 *   - owns the `InstructionInbox` — the inbound steering channel;
 *   - derives live `SessionState` from the event stream.
 *
 * Transport-agnostic: `http-server.ts` and `relay-client.ts` are thin
 * adapters over this hub — exactly the port/transport split the SDK already
 * uses for HITL (`ApprovalChannel` + `hitl/slack.ts`).
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

import { toCanonicalEventType } from "./event-name-map.js";
import type { SessionEvent } from "./events.js";
import { InMemoryInstructionInbox, type InstructionInbox } from "./inbox.js";
import { type PersistencePort, tryPersistEvent } from "./persistence.js";
import { type SignFn, signEvent } from "./signing.js";
import type { SessionEventSink } from "./sink.js";
import { InMemoryVetoChannel, type VetoChannel } from "./veto.js";

/**
 * A finer-grained view of what a session is doing right now than
 * {@link SessionState.status}'s three-value lifecycle — a superset in the
 * sense that every `status` value maps onto one or more `SessionStatus`
 * values (`idle`→`"idle"`, `running`→one of the four in-flight values below,
 * `finished`→`"stopped"`).
 *
 * Every value is grounded in a real `SessionEvent` this hub folds (see
 * `updateState`) EXCEPT `"thinking"`:
 *
 * - `"tool-call"` — between `TOOL_CALL_START` and `TOOL_CALL_END` (the
 *   `tools.execute()` await, `loop/minimal-loop.ts`).
 * - `"blocked"` — between `CUSTOM_TOOL_INTENT` and its resolution (the T6a
 *   pre-tool-call veto window, `vetoChannel.await()`,
 *   `loop/minimal-loop.ts`). Distinct from `"awaiting-hitl"`: this is the
 *   veto gate, not the dangerous-tool approval gate.
 * - `"awaiting-hitl"` — between `CUSTOM_HITL_REQUEST` and
 *   `CUSTOM_HITL_RESOLVED` (`remote/approval.ts`'s dangerous-tool gate).
 * - `"stopped"` — after `RUN_FINISHED`, any `stopReason`.
 * - `"thinking"` — Hypothesis: inferred, not directly emitted. Set on
 *   `RUN_STARTED` and after any `TOOL_CALL_END` / `CUSTOM_HITL_RESOLVED` —
 *   the loop has no gate open and no tool running, which in practice means
 *   it is in the blocking `provider.complete()` round-trip
 *   (`loop/minimal-loop.ts`). No dedicated "LLM call started" event exists
 *   today. The CLI's own activity panel falls back to the identical label
 *   for the identical gap (`ui/tui/model.ts` `currentLabel() ?? "thinking"`
 *   in the `packages/cli` consumer).
 *
 * `STEP_STARTED` deliberately leaves `phase` unchanged: it is retroactive
 * step telemetry emitted synchronously before the event that actually
 * clarifies what happens next (finalize vs. tool call) — no observer can
 * catch a state in between since nothing async separates them.
 * @public @since 2.28.0 — SP2-B status vocabulary
 */
export type SessionStatus =
  | "idle"
  | "thinking"
  | "tool-call"
  | "blocked"
  | "awaiting-hitl"
  | "stopped";

/**
 * A remote controller's own view of its transport link to a session (the
 * SSE `/remote/stream` connection in direct HTTP mode, or the sovereign
 * relay in T2 mode). UNLIKE {@link SessionStatus}, the hub does not derive
 * this — it describes a condition the CONTROLLER observes about ITSELF,
 * which the session side has no visibility into. Ships as a small, validated
 * wire vocabulary ahead of the multi-session controller dashboard that will
 * own the actual state machine.
 *
 * Grounded in real transport conditions already named in this package:
 * - `"connected"` — the SSE stream is open, or the relay guest has joined
 *   (`relay-client.ts`'s `"joined"` SSE event).
 * - `"reconnecting"` — retrying after an unexpected drop.
 * - `"relay-unreachable"` — literally the condition `relay-client.ts`
 *   already comments as "relay unreachable" when the initial
 *   `fetch(hostStream(...))` throws (T2 relay mode only).
 * @public @since 2.28.0 — SP2-B status vocabulary
 */
export type LinkStatus = "connected" | "reconnecting" | "relay-unreachable";

/**
 * Every {@link LinkStatus} value ; for validating a wire-received string.
 * @public @since 2.28.0
 */
export const ALL_LINK_STATUSES: readonly LinkStatus[] = [
  "connected",
  "reconnecting",
  "relay-unreachable",
];

/**
 * Runtime guard for a `LinkStatus` received off the wire (untrusted input).
 * @public @since 2.28.0
 */
export function isLinkStatus(value: string): value is LinkStatus {
  return (ALL_LINK_STATUSES as readonly string[]).includes(value);
}

/**
 * A live snapshot of the controlled session.
 * @public
 */
export interface SessionState {
  runId: string | null;
  agentId: string | null;
  status: "idle" | "running" | "finished";
  stepCount: number;
  costUsd: number;
  elapsedMs: number;
  /** HITL requests currently awaiting a verdict. */
  pendingHitl: number;
  /** Finer-grained activity phase — see {@link SessionStatus}. @since 2.28.0 */
  phase: SessionStatus;
}

/**
 * The surface a remote client drives. The hub is the reference impl; any
 * transport (HTTP/SSE, relay, a future gRPC adapter) consumes this port.
 * @public
 */
export interface RemoteControlPort extends SessionEventSink {
  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(fn: (event: SessionEvent) => void): () => void;
  /**
   * Replay buffered events with `seq` strictly greater than `sinceSeq`
   * (omit `sinceSeq` for the full buffer) — gap-free reconnection.
   */
  backlog(sinceSeq?: number): SessionEvent[];
  /**
   * The `seq` of the oldest event still retained in the ring buffer, or
   * `null` when empty. O(1) — unlike `backlog()[0]?.seq`, this does not copy
   * the buffer just to read one field.
   *
   * A reconnecting controller compares its own last-seen `seq` against this
   * value: if `lastSeenSeq < backlogOldestSeq() - 1`, the intervening events
   * were evicted and its view has a gap — `backlog(sinceSeq)` on its own
   * returns a silently-truncated slice with no signal that anything is
   * missing.
   * @since 2.28.0 — SP2-B status vocabulary
   */
  backlogOldestSeq(): number | null;
  /** The inbound steering channel. */
  readonly inbox: InstructionInbox;
  /** Pre-tool-call veto bus — T6a veto window. */
  readonly vetoChannel: VetoChannel;
  /** Current derived session state. */
  state(): SessionState;
  /**
   * A sink for events this session should DISPLAY but not interpret as its
   * own state — the interior of a governed child spawned by `delegate` /
   * `coordinate` (ADR-ECO-076 / ADR-ECO-083).
   *
   * Identical to `emit` except the event is NOT folded into
   * {@link SessionState}: it is signed, buffered, persisted and fanned out to
   * subscribers exactly the same way, so the controller's observe transcript
   * shows the child's work live. Without this seam a child's
   * `RUN_STARTED`/`RUN_FINISHED` overwrite the parent's derived envelope —
   * `state().runId` flips to the child's and `state().status` reads
   * `"finished"` while the session is still alive.
   *
   * The parent/child distinction is NOT recoverable from the event: the
   * envelope carries no `runId` and only `RUN_STARTED`/`RUN_FINISHED` name one
   * in `data`. The caller that spawns the child is the only place that knows,
   * so it picks the sink rather than the hub guessing.
   *
   * Returns a stable instance — safe to `teeSink` or compare by identity.
   * @since 3.6.0 — SP-B child-event display seam
   */
  observerSink(): SessionEventSink;
}

export interface RemoteControlHubOptions {
  /** Max events retained for backfill. Default 5000 ; sized from the measured
   * busy-loop worst burst (90 events/min -> ~55 min of outage coverage) per
   * ADR-ECO-119 Amendement A1. */
  bufferSize?: number;
  /** Inbox implementation. Default: a fresh InMemoryInstructionInbox. */
  inbox?: InstructionInbox;
  /**
   * When provided, every emitted event is Ed25519-signed before it is
   * buffered + streamed — the remote-control transcript becomes a
   * tamper-evident audit trail. See `remote/signing.ts`.
   */
  signFn?: SignFn;
  /** Pre-tool-call veto bus (T6a). Default: a fresh InMemoryVetoChannel. */
  vetoChannel?: VetoChannel;
  /**
   * Durable backing store for events + revocations (T7). When provided,
   * every emitted event is fire-and-forget written to disk. Persistence
   * failures are logged but never thrown into the agent loop.
   *
   * The hub does NOT pre-load events from persistence — callers wanting
   * to warm the buffer after a crash should call
   * `await loadHubFromPersistence(hub, persistence, opts)` before
   * starting the agent run.
   */
  persistence?: PersistencePort;
}

/**
 * Create a RemoteControlHub — the reference RemoteControlPort.
 * @public
 */
export function createRemoteControlHub(opts: RemoteControlHubOptions = {}): RemoteControlPort {
  const bufferSize = opts.bufferSize ?? 5000;
  const inbox: InstructionInbox = opts.inbox ?? new InMemoryInstructionInbox();
  const vetoChannel: VetoChannel = opts.vetoChannel ?? new InMemoryVetoChannel();

  const buffer: SessionEvent[] = [];
  const subscribers = new Set<(e: SessionEvent) => void>();

  const state: SessionState = {
    runId: null,
    agentId: null,
    status: "idle",
    stepCount: 0,
    costUsd: 0,
    elapsedMs: 0,
    pendingHitl: 0,
    phase: "idle",
  };
  let startedAtMs: number | null = null;

  /**
   * Fold one event into the derived session state. Matches on canonical
   * AG-UI UPPER_SNAKE_CASE type strings (3.0.0+).
   */
  function updateState(event: SessionEvent): void {
    switch (event.type) {
      case "RUN_STARTED":
        state.runId = (event.data as { runId: string }).runId;
        state.agentId = (event.data as { agentId: string }).agentId;
        state.status = "running";
        state.stepCount = 0;
        state.costUsd = 0;
        state.phase = "thinking";
        startedAtMs = Date.now();
        break;
      case "STEP_STARTED":
        state.stepCount = (event.data as { stepIndex: number }).stepIndex + 1;
        state.costUsd += (event.data as { costUsd: number }).costUsd;
        // `phase` intentionally unchanged — see the SessionStatus doc comment.
        break;
      case "CUSTOM_TOOL_INTENT":
        state.phase = "blocked";
        break;
      case "TOOL_CALL_START":
        state.phase = "tool-call";
        break;
      case "TOOL_CALL_END":
        state.phase = "thinking";
        break;
      case "RUN_FINISHED":
        state.status = "finished";
        state.stepCount = (event.data as { stepCount: number }).stepCount;
        state.costUsd = (event.data as { costUsd: number }).costUsd;
        state.phase = "stopped";
        break;
      case "CUSTOM_HITL_REQUEST":
        state.pendingHitl += 1;
        state.phase = "awaiting-hitl";
        break;
      case "CUSTOM_HITL_RESOLVED":
        state.pendingHitl = Math.max(0, state.pendingHitl - 1);
        state.phase = "thinking";
        break;
      default:
        break;
    }
  }

  /**
   * The shared emit path. `fold` is the ONLY difference between an event this
   * session produced and a delegated child's event we merely display: a child
   * must reach the transcript identically (signed, buffered, persisted, fanned
   * out) without overwriting the parent's derived state.
   */
  function ingest(rawEvent: SessionEvent, fold: boolean): void {
    // Normalise the `type` field to canonical AG-UI UPPER_SNAKE_CASE at the
    // emit boundary (3.0.0+). Callers that still pass legacy dotted types
    // are transparently upgraded; canonical types pass through unchanged.
    let event = rawEvent;
    const canonicalType = toCanonicalEventType(event.type);
    if (canonicalType !== event.type) {
      event = { ...event, type: canonicalType } as SessionEvent;
    }
    // Sign AFTER the type rewrite so the verifier validates the
    // canonical-typed event. The buffered + streamed event carries `sig`
    // so a reconnecting client and a live client see the same signed event.
    if (opts.signFn) {
      try {
        event = signEvent(event, opts.signFn);
      } catch {
        // signing failure is non-fatal — emit unsigned
      }
    }
    if (fold) updateState(event);
    // C2 streaming (session-dans-la-poche) : TEXT_MESSAGE_CONTENT deltas are
    // EPHEMERAL ; fanned out live to subscribers so a remote cursor comes
    // alive, but NEVER retained in the ring nor persisted. Keeping them off the
    // ring keeps the durable event `seq` stream gap-free (so `backlogOldestSeq`
    // truncation detection stays exact), and a `?since=` / `sync` replay carries
    // only the durable transcript ; `TEXT_MESSAGE_END` is the durable record of
    // an assistant message. See `makeEphemeralDelta` + the design doc C2.
    if (event.type !== "TEXT_MESSAGE_CONTENT") {
      buffer.push(event);
      if (buffer.length > bufferSize) buffer.shift();
      // Fire-and-forget persistence write. Failures are logged inside
      // tryPersistEvent; never throw into the agent loop.
      void tryPersistEvent(opts.persistence, event);
    }
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must never break the run
        subscribers.delete(fn);
      }
    }
  }

  const observer: SessionEventSink = {
    emit(event: SessionEvent): void {
      ingest(event, false);
    },
  };

  return {
    emit(rawEvent: SessionEvent): void {
      ingest(rawEvent, true);
    },

    observerSink(): SessionEventSink {
      return observer;
    },

    subscribe(fn: (event: SessionEvent) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    backlog(sinceSeq?: number): SessionEvent[] {
      if (sinceSeq === undefined) return [...buffer];
      return buffer.filter((e) => e.seq > sinceSeq);
    },

    backlogOldestSeq(): number | null {
      return buffer.length > 0 ? buffer[0].seq : null;
    },

    inbox,

    vetoChannel,

    state(): SessionState {
      return {
        ...state,
        elapsedMs: startedAtMs === null ? 0 : Date.now() - startedAtMs,
      };
    },
  };
}

/**
 * Warm a hub's in-memory backlog from a persistence store. Call once
 * after `createRemoteControlHub` and before serving traffic ; the events
 * become accessible via `hub.backlog()` exactly as if they had just been
 * emitted (no re-signing, no subscriber dispatch).
 *
 * Bounded by the hub's `bufferSize` ; oldest events are dropped first.
 *
 * @param hub          The hub returned by {@link createRemoteControlHub}.
 * @param persistence  The same persistence handed to the hub options.
 * @param opts         Optional cutoff `sinceSeq` (load only newer events).
 *
 * @public @since 2.21.0 — preste remote-control P7
 */
export async function loadHubFromPersistence(
  hub: RemoteControlPort,
  persistence: PersistencePort,
  opts: { sinceSeq?: number } = {},
): Promise<{ loaded: number; maxSeq: number }> {
  const events = await persistence.loadEvents(opts.sinceSeq);
  const maxSeq = await persistence.getMaxSeq();
  // The port doesn't expose `buffer.push` directly — we go through emit().
  // To avoid double-persistence (re-writing every loaded event), the port
  // skips `tryPersistEvent` when no persistence is configured. For replay,
  // we therefore use a side-door: subscribe-replay-unsubscribe.
  //
  // The simpler path is to use the public `emit` and accept idempotent
  // re-writes — `InMemoryPersistencePort.saveEvent` is idempotent on
  // `(seq, id)` and SQLite uses `INSERT OR IGNORE`. The cost is one extra
  // round-trip per event but reload is a startup-time operation.
  for (const event of events) {
    hub.emit(event);
  }
  return { loaded: events.length, maxSeq };
}
