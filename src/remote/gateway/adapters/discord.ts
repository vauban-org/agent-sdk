/**
 * remote/gateway/adapters/discord — Discord Gateway adapter.
 *
 * Inbound: a Discord Gateway WebSocket (v10) — Hello → heartbeat + Identify,
 * then MESSAGE_CREATE dispatches. Outbound: the REST channel-messages endpoint.
 *
 * The WebSocket is injected (`wsFactory`) so the protocol is unit-testable
 * without a network. Node >=22 supplies a global `WebSocket`; older runtimes
 * pass a factory backed by the `ws` package.
 *
 * Zero-trust: `allowedChannelIds` MUST be non-empty — allowlist AND delivery
 * targets in one. Messages authored by bots (including this one) are ignored.
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

/** GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15). */
const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
/** Discord message content hard limit. */
const DISCORD_MAX_CHARS = 2000;

export interface DiscordAdapterOptions {
  /** Bot token (the Discord application's bot token). */
  botToken: string;
  /** Allowlist of channel ids permitted to control + receive. Non-empty. */
  allowedChannelIds: string[];
  /** Injected WebSocket factory — defaults to the global `WebSocket`. */
  wsFactory?: WebSocketFactory;
  /** Injected fetch — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** REST API base. Default https://discord.com/api/v10. */
  apiBase?: string;
  /** Gateway WSS URL. Default wss://gateway.discord.gg/?v=10&encoding=json. */
  gatewayUrl?: string;
  /** Logger. Default no-op. */
  log?: GatewayLogger;
}

interface DiscordFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string;
}

/**
 * Create a Discord gateway adapter.
 * @public
 */
export function createDiscordAdapter(opts: DiscordAdapterOptions): GatewayAdapter {
  const botToken = opts.botToken.trim();
  if (botToken === "") {
    throw new Error("discord adapter: botToken is required");
  }
  const allowed = new Set(opts.allowedChannelIds.map((c) => String(c).trim()));
  allowed.delete("");
  if (allowed.size === 0) {
    throw new Error("discord adapter: allowedChannelIds must be non-empty (zero-trust)");
  }
  const wsFactory: WebSocketFactory = opts.wsFactory ?? defaultWebSocketFactory;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? "https://discord.com/api/v10").replace(/\/+$/, "");
  const gatewayUrl = opts.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
  const log = opts.log ?? NOOP_LOGGER;

  let running = false;
  let ws: WebSocketLike | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeq: number | null = null;
  let onMessageCb: ((m: InboundMessage) => void) | null = null;

  function clearHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function handleFrame(raw: string): void {
    let frame: DiscordFrame;
    try {
      frame = JSON.parse(raw) as DiscordFrame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") lastSeq = frame.s;

    switch (frame.op) {
      case 10: {
        // Hello — start the heartbeat, send Identify.
        const interval =
          (frame.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41250;
        clearHeartbeat();
        heartbeat = setInterval(() => {
          try {
            ws?.send(JSON.stringify({ op: 1, d: lastSeq }));
          } catch {
            /* socket gone — onclose will reconnect */
          }
        }, interval);
        heartbeat.unref?.();
        ws?.send(
          JSON.stringify({
            op: 2,
            d: {
              token: botToken,
              intents: DISCORD_INTENTS,
              properties: {
                os: "linux",
                browser: "preste",
                device: "preste",
              },
            },
          }),
        );
        break;
      }
      case 1:
        // Server-requested heartbeat.
        try {
          ws?.send(JSON.stringify({ op: 1, d: lastSeq }));
        } catch {
          /* socket gone */
        }
        break;
      case 0:
        if (frame.t === "MESSAGE_CREATE") {
          const d = frame.d as
            | {
                channel_id?: string;
                content?: string;
                author?: { id?: string; bot?: boolean };
              }
            | undefined;
          if (!d || d.author?.bot) break; // ignore bots (incl. self) — no loops
          const channelId = String(d.channel_id ?? "");
          if (!allowed.has(channelId)) {
            log(`discord: ignored message in non-allowlisted channel ${channelId}`);
            break;
          }
          if (typeof d.content !== "string" || d.content === "") break;
          onMessageCb?.({
            platform: "discord",
            chatId: channelId,
            userId: String(d.author?.id ?? ""),
            text: d.content,
            ts: new Date().toISOString(),
          });
        }
        break;
      default:
        break;
    }
  }

  function connect(): void {
    ws = wsFactory(gatewayUrl);
    ws.onopen = () => log("discord: gateway socket open");
    ws.onmessage = (ev) => handleFrame(String(ev.data));
    ws.onerror = () => log("discord: gateway socket error");
    ws.onclose = () => {
      clearHeartbeat();
      ws = null;
      if (running) {
        log("discord: socket closed — reconnecting in 3s");
        reconnectTimer = setTimeout(connect, 3000);
        reconnectTimer.unref?.();
      }
    };
  }

  return {
    platform: "discord",

    async start(onMessage): Promise<void> {
      if (running) return;
      running = true;
      onMessageCb = onMessage;
      connect();
    },

    async deliver(text): Promise<void> {
      const content =
        text.length > DISCORD_MAX_CHARS ? `${text.slice(0, DISCORD_MAX_CHARS - 1)}…` : text;
      for (const channelId of allowed) {
        try {
          const res = await fetchImpl(`${apiBase}/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
              authorization: `Bot ${botToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ content }),
          });
          if (!res.ok) {
            log(`discord: deliver to ${channelId} failed — HTTP ${res.status}`);
          }
        } catch (err) {
          log(`discord: deliver to ${channelId} failed — ${(err as Error).message}`);
        }
      }
    },

    async stop(): Promise<void> {
      running = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHeartbeat();
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
      ws = null;
    },
  };
}
