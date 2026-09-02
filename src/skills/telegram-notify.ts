/**
 * telegram_notify — POST Telegram bot sendMessage.
 *
 * Resolves chat_id from messaging_user_binding when `binding_user_id`
 * is provided; else uses `chat_id` directly.
 *
 * @public
 */
import { z } from "zod";

import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { RETRY_TRANSIENT, type RetryConfig, RetryExhaustedError, retry } from "../retry/index.js";

import { withSkillSpan } from "./_otel.js";
import { readSecret } from "./_secrets.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";

class RetryableHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "RetryableHttpError";
  }
}

const TELEGRAM_RETRY: RetryConfig = {
  ...RETRY_TRANSIENT,
  retryIf: (err) => err instanceof RetryableHttpError || err instanceof TypeError,
};

const inputSchema = z
  .object({
    text: z.string().min(1).max(4096),
    chat_id: z.string().optional(),
    binding_user_id: z.string().uuid().optional(),
    parse_mode: z.enum(["MarkdownV2", "HTML"]).optional(),
  })
  .strict()
  .refine((v) => v.chat_id || v.binding_user_id, {
    message: "chat_id or binding_user_id required",
  });
type TelegramNotifyInput = z.infer<typeof inputSchema>;

/** @public */
export interface TelegramNotifyOutput {
  delivered: boolean;
  message_id: number | null;
}

/** @public */
export const telegramNotify: Skill<TelegramNotifyInput, TelegramNotifyOutput> = {
  name: "telegram_notify",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<TelegramNotifyOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks.telegram_notify;
      if (mock) return mock(input) as TelegramNotifyOutput;
      return { delivered: false, message_id: null };
    }
    return withSkillSpan("telegram_notify", async () => {
      const token = readSecret(ctx, "TELEGRAM_BOT_TOKEN");
      if (!token) {
        throw new SkillNotConfiguredError("telegram_notify", ["TELEGRAM_BOT_TOKEN"]);
      }
      let chatId = input.chat_id;
      if (!chatId && input.binding_user_id) {
        const { rows } = await ctx.db.query<{ chat_id: string }>(
          "SELECT chat_id FROM messaging_user_binding WHERE user_id = $1 AND channel = 'telegram' LIMIT 1",
          [input.binding_user_id],
        );
        chatId = rows[0]?.chat_id;
        if (!chatId) {
          throw new SkillExecutionError(
            "telegram_notify",
            `no telegram binding for user ${input.binding_user_id}`,
          );
        }
      }
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      try {
        return await retry(
          async () => {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: input.text,
                parse_mode: input.parse_mode,
              }),
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              if (res.status >= 500 || res.status === 429) {
                throw new RetryableHttpError(res.status, body);
              }
              throw new SkillExecutionError("telegram_notify", `${res.status}`, {
                status: res.status,
              });
            }
            const data = (await res.json()) as {
              ok?: boolean;
              result?: { message_id?: number };
            };
            return {
              delivered: data.ok === true,
              message_id: data.result?.message_id ?? null,
            };
          },
          { config: TELEGRAM_RETRY },
        );
      } catch (err) {
        const cause = err instanceof RetryExhaustedError ? err.lastError : err;
        if (cause instanceof RetryableHttpError) {
          throw new SkillExecutionError("telegram_notify", `${cause.status} after retries`, {
            status: cause.status,
          });
        }
        throw cause;
      }
    });
  },
};
