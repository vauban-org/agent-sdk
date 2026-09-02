/**
 * DiscordChannel — MessagingChannelPort adapter for Discord Webhooks.
 *
 * Uses Discord embed objects with per-level colors.
 * Webhook mode: target is ignored for sendMessage (document limitation below).
 * Uses native fetch (Node 18+).
 *
 * Limitation: Discord webhooks POST to a fixed channel configured at webhook
 * creation time. `sendMessage(target, text)` ignores `target` and always
 * posts to that channel. If per-channel routing is needed, create one
 * DiscordChannel instance per webhook URL.
 *
 * @public
 */

import { HttpError, fetchOrThrow } from "../../http/fetch-json.js";
import type { AlertLevel, MessagingChannelPort } from "../../ports/messaging.js";
import { InvalidTargetError } from "../../ports/messaging.js";

/** Discord embed colour (decimal) per alert level. */
const LEVEL_COLOR: Record<AlertLevel, number> = {
  info: 0x3498db, // blue
  warn: 0xf39c12, // yellow
  error: 0xe74c3c, // red
  critical: 0xff0000, // bright red
};

/** Emoji prefix per alert level. */
const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: "ℹ️",
  warn: "⚠️",
  error: "❌",
  critical: "🚨",
};

/** @public */
export interface DiscordChannelConfig {
  /** Discord Incoming Webhook URL. Never hardcoded — pass at runtime. */
  webhookUrl: string;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  footer: { text: string };
  timestamp: string;
}

interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

/** @public */
export class DiscordChannel implements MessagingChannelPort {
  readonly #webhookUrl: string;

  constructor(config: DiscordChannelConfig) {
    this.#webhookUrl = config.webhookUrl;
  }

  async sendAlert(level: AlertLevel, title: string, body: string): Promise<void> {
    const emoji = LEVEL_EMOJI[level];
    const payload: DiscordPayload = {
      embeds: [
        {
          title: `${emoji} [${level.toUpperCase()}] ${title}`,
          description: body,
          color: LEVEL_COLOR[level],
          footer: { text: "vauban-agent-sdk" },
          timestamp: new Date().toISOString(),
        },
      ],
    };
    await this.#post(payload);
  }

  /**
   * Send a message to the webhook channel.
   *
   * Note: `target` is included in the message text as context but does NOT
   * route to a different channel — Discord webhooks are bound to a single
   * channel at creation. To send to different channels, use separate
   * DiscordChannel instances with distinct webhook URLs.
   */
  async sendMessage(target: string, text: string): Promise<void> {
    if (!target || target.trim() === "") {
      throw new InvalidTargetError(
        "DiscordChannel.sendMessage requires a non-empty target (used as context label)",
        target,
      );
    }
    const payload: DiscordPayload = {
      content: `[→ ${target.trim()}] ${text}`,
    };
    await this.#post(payload);
  }

  async #post(payload: DiscordPayload): Promise<void> {
    try {
      // 204 No Content on success — fetchOrThrow returns the Response
      // (2xx is ok), nothing further to do with the body.
      await fetchOrThrow(this.#webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429) {
          throw new Error("Discord rate limit hit (429); back off before retrying");
        }
        throw new Error(`Discord webhook error ${err.status}: ${err.bodySnippet}`);
      }
      throw err;
    }
  }
}
