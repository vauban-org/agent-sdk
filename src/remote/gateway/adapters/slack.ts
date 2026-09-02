/**
 * remote/gateway/adapters/slack — Slack Socket Mode adapter.
 *
 * Inbound: a Socket Mode WebSocket (`apps.connections.open` → wss URL → event
 * envelopes, each ACKed). No inbound port — Socket Mode dials out, the same
 * sovereignty posture as the relay. Outbound: `chat.postMessage`.
 *
 * Two tokens: an app-level token (`xapp-…`) opens the socket; a bot token
 * (`xoxb-…`) posts messages.
 *
 * Zero-trust: `allowedChannelIds` MUST be non-empty. Messages with a
 * `bot_id` or a `subtype` (edits, joins, bot posts) are ignored — no loops.
 *
 * @public @since 2.14.0 — preste remote-control T4
 */

import type {
  GatewayAdapter,
  GatewayLogger,
  InboundMessage,
  WebSocketFactory,
  WebSocketLike,
} from "../types.js";
import { NOOP_LOGGER, defaultWebSocketFactory } from "../types.js";

export interface SlackAdapterOptions {
  /** App-level token (`xapp-…`) — opens the Socket Mode connection. */
  appToken: string;
  /** Bot token (`xoxb-…`) — posts messages. */
  botToken: string;
  /** Allowlist of channel ids permitted to control + receive. Non-empty. */
  allowedChannelIds: string[];
  /** Injected WebSocket factory — defaults to the global `WebSocket`. */
  wsFactory?: WebSocketFactory;
  /** Injected fetch — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Slack API base. Default https://slack.com/api. */
  apiBase?: string;
  /** Logger. Default no-op. */
  log?: GatewayLogger;
}

interface SlackFrame {
  type?: string;
  envelope_id?: string;
  payload?: { event?: Record<string, unknown> };
}

/**
 * Create a Slack Socket Mode gateway adapter.
 * @public
 */
export function createSlackAdapter(opts: SlackAdapterOptions): GatewayAdapter {
  const appToken = opts.appToken.trim();
  const botToken = opts.botToken.trim();
  if (appToken === "" || botToken === "") {
    throw new Error("slack adapter: appToken and botToken are required");
  }
  const allowed = new Set(opts.allowedChannelIds.map((c) => String(c).trim()));
  allowed.delete("");
  if (allowed.size === 0) {
    throw new Error("slack adapter: allowedChannelIds must be non-empty (zero-trust)");
  }
  const wsFactory: WebSocketFactory = opts.wsFactory ?? defaultWebSocketFactory;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? "https://slack.com/api").replace(/\/+$/, "");
  const log = opts.log ?? NOOP_LOGGER;

  let running = false;
  let ws: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let onMessageCb: ((m: InboundMessage) => void) | null = null;

  function handleFrame(raw: string): void {
    let msg: SlackFrame;
    try {
      msg = JSON.parse(raw) as SlackFrame;
    } catch {
      return;
    }
    if (msg.type === "hello") return;
    if (msg.type === "disconnect") {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg.type !== "events_api") return;

    // Socket Mode requires an envelope ACK (within 3s) or Slack retries.
    if (msg.envelope_id) {
      try {
        ws?.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      } catch {
        /* socket gone */
      }
    }
    const ev = msg.payload?.event;
    if (
      !ev ||
      ev.type !== "message" ||
      typeof ev.text !== "string" ||
      ev.bot_id !== undefined ||
      ev.subtype !== undefined
    ) {
      return;
    }
    const channel = String(ev.channel ?? "");
    if (!allowed.has(channel)) {
      log(`slack: ignored message in non-allowlisted channel ${channel}`);
      return;
    }
    onMessageCb?.({
      platform: "slack",
      chatId: channel,
      userId: String(ev.user ?? ""),
      text: ev.text,
      ts: new Date().toISOString(),
    });
  }

  async function connect(): Promise<void> {
    const res = await fetchImpl(`${apiBase}/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}` },
    });
    const json = (await res.json()) as {
      ok?: boolean;
      url?: string;
      error?: string;
    };
    if (!json || json.ok !== true || !json.url) {
      throw new Error(`slack apps.connections.open: ${json?.error ?? `HTTP ${res.status}`}`);
    }
    ws = wsFactory(json.url);
    ws.onopen = () => log("slack: socket mode connection open");
    ws.onmessage = (ev) => handleFrame(String(ev.data));
    ws.onerror = () => log("slack: socket error");
    ws.onclose = () => {
      ws = null;
      if (running) {
        log("slack: socket closed — reconnecting in 3s");
        reconnectTimer = setTimeout(() => {
          void connect().catch((err) => log(`slack: reconnect failed — ${(err as Error).message}`));
        }, 3000);
        reconnectTimer.unref?.();
      }
    };
  }

  return {
    platform: "slack",

    async start(onMessage): Promise<void> {
      if (running) return;
      running = true;
      onMessageCb = onMessage;
      // The first connection is awaited — a bad token surfaces to the caller.
      // Reconnects after a drop are fail-soft (see onclose).
      await connect();
    },

    async deliver(text): Promise<void> {
      for (const channel of allowed) {
        try {
          const res = await fetchImpl(`${apiBase}/chat.postMessage`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${botToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ channel, text }),
          });
          const json = (await res.json()) as { ok?: boolean; error?: string };
          if (!json || json.ok !== true) {
            log(`slack: deliver to ${channel} failed — ${json?.error ?? `HTTP ${res.status}`}`);
          }
        } catch (err) {
          log(`slack: deliver to ${channel} failed — ${(err as Error).message}`);
        }
      }
    },

    async stop(): Promise<void> {
      running = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
      ws = null;
    },
  };
}
