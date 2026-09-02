/**
 * remote/gateway — multi-platform gateway: one agent session, many surfaces.
 *
 * Built on the T1-T3 remote-control primitives. The `Gateway` multiplexes a
 * `RemoteControlHub` across `GatewayAdapter`s (Telegram, Discord, Slack) — the
 * Hermes-style assistant gateway, SDK-native so every consumer inherits it.
 *
 * @public @since 2.14.0 — preste remote-control T4
 */

export {
  NOOP_LOGGER,
  defaultWebSocketFactory,
  type InboundMessage,
  type ApprovalPrompt,
  type ApprovalCallback,
  type GatewayAdapter,
  type GatewayLogger,
  type WebSocketLike,
  type WebSocketFactory,
} from "./types.js";

export { renderEventForChat, truncate, type RenderOptions } from "./render.js";

export {
  isMemoryLookupTool,
  negativeMemoryVerdicts,
  unobservedMemoryClaimWarning,
} from "./unobserved-memory-claim.js";

export {
  createGateway,
  type GatewayOptions,
  type GatewayHandle,
} from "./gateway.js";

export {
  createTelegramAdapter,
  type TelegramAdapterOptions,
} from "./adapters/telegram.js";

export {
  createDiscordAdapter,
  type DiscordAdapterOptions,
} from "./adapters/discord.js";

export {
  createSlackAdapter,
  type SlackAdapterOptions,
} from "./adapters/slack.js";
