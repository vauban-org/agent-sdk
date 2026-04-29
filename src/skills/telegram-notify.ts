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
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

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

export interface TelegramNotifyOutput {
  delivered: boolean;
  message_id: number | null;
}

export const telegramNotify: Skill<TelegramNotifyInput, TelegramNotifyOutput> =
  {
    name: "telegram_notify",
    inputSchema,
    async execute(input, ctx: SkillContext): Promise<TelegramNotifyOutput> {
      if (ctx.isReplay) {
        const mock = ctx.dryRunMocks["telegram_notify"];
        if (mock) return mock(input) as TelegramNotifyOutput;
        return { delivered: false, message_id: null };
      }
      return withSkillSpan("telegram_notify", async () => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
          throw new SkillNotConfiguredError("telegram_notify", [
            "TELEGRAM_BOT_TOKEN",
          ]);
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
      });
    },
  };
