/**
 * SlackChannel — MessagingChannelPort adapter for Slack Incoming Webhooks.
 *
 * Uses Block Kit for alerts (color-coded attachments).
 * Webhook mode only — no bot token / chat.postMessage for now.
 * Uses native fetch (Node 18+).
 *
 * @public
 */

import type { AlertLevel, MessagingChannelPort } from "../../ports/messaging.js";
import { InvalidTargetError } from "../../ports/messaging.js";

/** Slack attachment color per alert level. */
const LEVEL_COLOR: Record<AlertLevel, string> = {
  info: "good",
  warn: "warning",
  error: "danger",
  critical: "danger",
};

/** Emoji prefix per alert level. */
const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: "ℹ️",
  warn: "⚠️",
  error: "❌",
  critical: "🚨",
};

/** @public */
export interface SlackChannelConfig {
  /** Slack Incoming Webhook URL. Never hardcoded — pass at runtime. */
  webhookUrl: string;
}

interface SlackPayload {
  text?: string;
  attachments?: SlackAttachment[];
}

interface SlackAttachment {
  color: string;
  title: string;
  text: string;
  footer: string;
  ts: number;
}

/** @public */
export class SlackChannel implements MessagingChannelPort {
  readonly #webhookUrl: string;

  constructor(config: SlackChannelConfig) {
    this.#webhookUrl = config.webhookUrl;
  }

  async sendAlert(level: AlertLevel, title: string, body: string): Promise<void> {
    const emoji = LEVEL_EMOJI[level];
    const color = LEVEL_COLOR[level];
    const payload: SlackPayload = {
      attachments: [
        {
          color,
          title: `${emoji} [${level.toUpperCase()}] ${title}`,
          text: body,
          footer: "vauban-agent-sdk",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
    await this.#post(payload);
  }

  async sendMessage(target: string, text: string): Promise<void> {
    if (!target || target.trim() === "") {
      throw new InvalidTargetError("SlackChannel.sendMessage requires a non-empty target", target);
    }
    // Webhook mode: target is prepended as context (no channel routing)
    const payload: SlackPayload = {
      text: `[→ ${target.trim()}] ${text}`,
    };
    await this.#post(payload);
  }

  async #post(payload: SlackPayload): Promise<void> {
    const res = await fetch(this.#webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      throw new Error("Slack rate limit hit (429); back off before retrying");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Slack webhook error ${res.status}: ${body}`);
    }
  }
}
