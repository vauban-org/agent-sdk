/**
 * TelegramChannel — MessagingChannelPort adapter for Telegram Bot API.
 *
 * Uses native fetch (Node 18+). MarkdownV2 escaping applied automatically.
 * No axios or other HTTP packages.
 *
 * @public
 */

import type { AlertLevel, MessagingChannelPort } from "../../ports/messaging.js";
import { InvalidTargetError } from "../../ports/messaging.js";

/** Emoji prefix per alert level. */
const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: "ℹ️",
  warn: "⚠️",
  error: "❌",
  critical: "🚨",
};

/**
 * Escape text for Telegram MarkdownV2.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMdV2(text: string): string {
  // Characters that must be escaped in MarkdownV2
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

/** @public */
export interface TelegramChannelConfig {
  /** Telegram Bot API token (from @BotFather). Never hardcoded — pass at runtime. */
  botToken: string;
  /** Default chat_id or @channel_username for sendAlert. */
  defaultChatId?: string;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
}

/** Rate-limit error code from Telegram API. */
const TELEGRAM_RATE_LIMIT_CODE = 429;

/**
 * Thrown when Telegram returns a 429 Too Many Requests.
 *
 * @public
 */
export class TelegramRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds?: number) {
    super(
      `Telegram rate limit hit${
        retryAfterSeconds != null ? `; retry after ${retryAfterSeconds}s` : ""
      }`,
    );
    this.name = "TelegramRateLimitError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class TelegramChannel implements MessagingChannelPort {
  readonly #botToken: string;
  readonly #defaultChatId?: string;

  constructor(config: TelegramChannelConfig) {
    this.#botToken = config.botToken;
    this.#defaultChatId = config.defaultChatId;
  }

  async sendAlert(level: AlertLevel, title: string, body: string): Promise<void> {
    const chatId = this.#defaultChatId;
    if (!chatId) {
      throw new InvalidTargetError(
        "TelegramChannel.sendAlert requires defaultChatId in constructor config",
        "",
      );
    }
    const emoji = LEVEL_EMOJI[level];
    const levelUpper = level.toUpperCase();
    const text =
      `${emoji} *\\[${escapeMdV2(levelUpper)}\\] ${escapeMdV2(title)}*\n` + `${escapeMdV2(body)}`;
    await this.#post(chatId, text, "MarkdownV2");
  }

  async sendMessage(target: string, text: string): Promise<void> {
    if (!target || target.trim() === "") {
      throw new InvalidTargetError(
        "TelegramChannel.sendMessage requires a non-empty target (chat_id or @channel)",
        target,
      );
    }
    await this.#post(target.trim(), text);
  }

  async #post(chatId: string, text: string, parseMode?: "MarkdownV2" | "HTML"): Promise<void> {
    const url = `https://api.telegram.org/bot${this.#botToken}/sendMessage`;
    const body: Record<string, string> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === TELEGRAM_RATE_LIMIT_CODE) {
      const data = (await res.json().catch(() => ({}))) as {
        parameters?: { retry_after?: number };
      };
      throw new TelegramRateLimitError(data.parameters?.retry_after);
    }

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as TelegramApiResponse;
      throw new Error(`Telegram API error ${res.status}: ${data.description ?? "unknown"}`);
    }
  }
}
