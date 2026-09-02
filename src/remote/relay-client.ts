/**
 * remote/relay-client — the PC ("host") side of the sovereign relay.
 *
 * `connectRelay` registers a session on the relay, returns the pairing
 * payload (the PC shows it as a QR), then in the background:
 *   - waits for the phone ("guest") to join → X25519 ECDH → shared key;
 *   - bridges the local `RemoteControlHub` event stream OUT, end-to-end
 *     encrypted, through the relay;
 *   - decrypts inbound frames → instruction injections + HITL verdicts.
 *
 * The relay never holds the shared key — it forwards ciphertext only.
 * Both PC and phone dial OUT to the relay: no inbound ports, NAT-friendly.
 *
 * T6h — durable outgoing queue
 * ----------------------------
 * `sendToGuest()` enqueues frames to SQLite when the socket is unavailable
 * or the send throws. On reconnect (`joined` SSE event) the queue is drained
 * in FIFO order. Frames that fail more than `MAX_OUTGOING_ATTEMPTS` times
 * are logged and dropped to prevent unbounded growth.
 *
 * @public @since 2.12.0 — preste remote-control T2
 */

import { fetchJson } from "../http/fetch-json.js";
import type { RemoteApprovalChannel } from "./approval.js";
import { deriveSharedKey, generateSessionKeyPair, open, seal } from "./crypto.js";
import {
  MAX_OUTGOING_ATTEMPTS,
  OutgoingMessageStore,
  outgoingStorePath,
} from "./outgoing-store.js";
import type { RemoteControlPort } from "./port.js";
import {
  type PairingPayload,
  RELAY_PROTOCOL_VERSION,
  type RelayMessage,
  relayPaths,
} from "./relay-protocol.js";

export interface ConnectRelayOptions {
  /** Base URL of the relay, e.g. https://relay.vauban.tech */
  relayUrl: string;
  /** The local hub whose events are bridged out and whose inbox receives injections. */
  hub: RemoteControlPort;
  /** When set, inbound HITL verdicts are applied to it. */
  approvalChannel?: RemoteApprovalChannel;
  /** Called when the phone successfully pairs. */
  onPaired?: () => void;
  /**
   * Durable store for outgoing frames. When omitted a SQLite-backed
   * `OutgoingMessageStore` is created automatically at
   * `${PRESTE_HOME ?? ~/.preste}/outgoing.sqlite`.
   *
   * Pass an explicit instance (including a custom in-memory mock) for
   * tests or to co-locate the DB with the session's persistence store.
   */
  outgoingStore?: OutgoingMessageStore;
}

/** @public */
export interface RelayConnection {
  /** The pairing payload — encode to a QR with `encodePairingPayload`. */
  readonly pairing: PairingPayload;
  /** True once the guest has paired and the shared key is established. */
  isPaired(): boolean;
  /** Tear down: abort the relay streams, stop bridging. */
  close(): Promise<void>;
}

/** Minimal SSE line parser over a fetch ReadableStream. */
async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data !== "") onEvent(event, data);
      }
    }
  } catch {
    /* aborted or network drop — caller handles reconnection policy */
  } finally {
    reader.releaseLock();
  }
}

/**
 * Register a relayed remote-control session and start bridging.
 * Resolves as soon as the session is registered (so the caller can show the
 * QR immediately); pairing completes asynchronously when the phone joins.
 * @public
 */
export async function connectRelay(opts: ConnectRelayOptions): Promise<RelayConnection> {
  const base = opts.relayUrl.replace(/\/$/, "");
  const keyPair = generateSessionKeyPair();

  // 1. Register the session on the relay.
  const reg = await fetchJson<{
    sessionId: string;
    pairingToken: string;
    hostToken: string;
  }>(
    `${base}${relayPaths.session}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostPubKey: keyPair.publicKeyB64 }),
    },
    { label: "relay: session registration failed" },
  );

  const pairing: PairingPayload = {
    v: RELAY_PROTOCOL_VERSION,
    relayUrl: base,
    sessionId: reg.sessionId,
    pairingToken: reg.pairingToken,
    hostPubKey: keyPair.publicKeyB64,
  };

  const abort = new AbortController();
  let sharedKey: Buffer | null = null;
  let unsubscribe: (() => void) | null = null;

  // T6h — durable outgoing queue. Lazily created on first use so callers
  // that never pair (e.g. the registration-only path) pay no I/O cost.
  let _store: OutgoingMessageStore | null = opts.outgoingStore ?? null;
  function getStore(): OutgoingMessageStore {
    if (!_store) {
      _store = new OutgoingMessageStore({ dbPath: outgoingStorePath() });
    }
    return _store;
  }

  /**
   * Drain the outgoing queue for this session. Called after the shared key
   * is established so all enqueued frames are sent in FIFO order. Frames
   * that exceed `MAX_OUTGOING_ATTEMPTS` are logged and dropped.
   */
  async function drainQueue(): Promise<void> {
    if (!sharedKey) return;
    const store = getStore();
    const batch = store.dequeueBatch(reg.sessionId, 100);
    for (const row of batch) {
      if (row.attempts >= MAX_OUTGOING_ATTEMPTS) {
        console.error(`relay: dropping frame id=${row.id} after ${row.attempts} failed attempts`);
        store.markDelivered(row.id);
        continue;
      }
      try {
        await fetch(`${base}${relayPaths.hostSend(reg.sessionId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${reg.hostToken}`,
          },
          body: JSON.stringify({ frame: row.frame }),
          signal: abort.signal,
        });
        store.markDelivered(row.id);
      } catch {
        store.markFailed(row.id);
      }
    }
  }

  /** Seal + POST a session message to the guest via the relay. */
  async function sendToGuest(msg: RelayMessage): Promise<void> {
    if (!sharedKey) return;
    const frame = seal(sharedKey, JSON.stringify(msg));
    try {
      await fetch(`${base}${relayPaths.hostSend(reg.sessionId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${reg.hostToken}`,
        },
        body: JSON.stringify({ frame }),
        signal: abort.signal,
      });
    } catch {
      // Send failed — persist so the frame survives a reconnect (T6h).
      try {
        getStore().enqueue(reg.sessionId, frame);
      } catch {
        /* store unavailable — best-effort, must not crash the agent run */
      }
    }
  }

  /** Handle a decrypted message from the guest. */
  function handleGuestMessage(msg: RelayMessage): void {
    if (msg.kind === "inject") {
      opts.hub.inbox.enqueue(msg.text, "remote:relay", msg.whisper);
    } else if (msg.kind === "hitl") {
      opts.approvalChannel?.resolve(msg.requestId, msg.approved, "remote:relay");
    }
    // "event" / "ping" from the guest are ignored — events flow host→guest.
  }

  // 2. Open the host-stream SSE — receive pairing + guest frames.
  void (async (): Promise<void> => {
    let streamRes: Response;
    try {
      streamRes = await fetch(`${base}${relayPaths.hostStream(reg.sessionId)}`, {
        headers: { Authorization: `Bearer ${reg.hostToken}` },
        signal: abort.signal,
      });
    } catch {
      return; // relay unreachable — caller already has the pairing payload
    }
    if (!streamRes.ok || !streamRes.body) return;

    await consumeSse(
      streamRes.body,
      (event, data) => {
        if (event === "joined") {
          // The guest joined — the relay relays its public key (public, in
          // clear). Derive the shared key; the relay still cannot read frames.
          try {
            const { guestPubKey } = JSON.parse(data) as {
              guestPubKey: string;
            };
            sharedKey = deriveSharedKey(keyPair.privateKey, guestPubKey, reg.sessionId);
            // T6h — drain any frames queued while disconnected first, then
            // flush the hub backlog so the phone sees the session from the
            // start in the correct order.
            void drainQueue();
            // Flush the backlog so the phone sees the session from the start.
            for (const ev of opts.hub.backlog()) {
              void sendToGuest({ kind: "event", event: ev });
            }
            // Bridge every subsequent event out, encrypted.
            unsubscribe = opts.hub.subscribe((ev) => {
              void sendToGuest({ kind: "event", event: ev });
            });
            opts.onPaired?.();
          } catch {
            /* malformed join — ignore, stay unpaired */
          }
        } else if (event === "frame") {
          if (!sharedKey) return;
          try {
            const { frame } = JSON.parse(data) as { frame: string };
            const msg = JSON.parse(open(sharedKey, frame)) as RelayMessage;
            handleGuestMessage(msg);
          } catch {
            // tampered / undecryptable frame — reject silently (zero-trust)
          }
        }
      },
      abort.signal,
    );
  })();

  return {
    pairing,
    isPaired(): boolean {
      return sharedKey !== null;
    },
    async close(): Promise<void> {
      unsubscribe?.();
      abort.abort();
      // Best-effort: tell the relay to drop the session.
      try {
        await fetch(`${base}${relayPaths.hostSend(reg.sessionId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${reg.hostToken}`,
            "X-Relay-Close": "1",
          },
          body: JSON.stringify({ frame: "" }),
        });
      } catch {
        /* relay will GC the session on idle timeout anyway */
      }
    },
  };
}
