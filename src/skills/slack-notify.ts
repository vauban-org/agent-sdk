/**
 * slack_notify — Slack chat.postMessage.
 *
 * Resolves channel from messaging_user_binding when binding_user_id provided.
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

const SLACK_RETRY: RetryConfig = {
  ...RETRY_TRANSIENT,
  retryIf: (err) => err instanceof RetryableHttpError || err instanceof TypeError,
};

const inputSchema = z
  .object({
    text: z.string().min(1).max(40_000),
    channel: z.string().optional(),
    binding_user_id: z.string().uuid().optional(),
    blocks: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict()
  .refine((v) => v.channel || v.binding_user_id, {
    message: "channel or binding_user_id required",
  });
type SlackNotifyInput = z.infer<typeof inputSchema>;

/** @public */
export interface SlackNotifyOutput {
  delivered: boolean;
  ts: string | null;
}

/** @public */
export const slackNotify: Skill<SlackNotifyInput, SlackNotifyOutput> = {
  name: "slack_notify",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<SlackNotifyOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks.slack_notify;
      if (mock) return mock(input) as SlackNotifyOutput;
      return { delivered: false, ts: null };
    }
    return withSkillSpan("slack_notify", async () => {
      const token = readSecret(ctx, "SLACK_BOT_TOKEN");
      if (!token) {
        throw new SkillNotConfiguredError("slack_notify", ["SLACK_BOT_TOKEN"]);
      }
      let channel = input.channel;
      if (!channel && input.binding_user_id) {
        const { rows } = await ctx.db.query<{ chat_id: string }>(
          "SELECT chat_id FROM messaging_user_binding WHERE user_id = $1 AND channel = 'slack' LIMIT 1",
          [input.binding_user_id],
        );
        channel = rows[0]?.chat_id;
        if (!channel) {
          throw new SkillExecutionError(
            "slack_notify",
            `no slack binding for user ${input.binding_user_id}`,
          );
        }
      }
      try {
        return await retry(
          async () => {
            const res = await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                channel,
                text: input.text,
                blocks: input.blocks,
              }),
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              if (res.status >= 500 || res.status === 429) {
                throw new RetryableHttpError(res.status, body);
              }
              throw new SkillExecutionError("slack_notify", `${res.status}`, {
                status: res.status,
              });
            }
            const data = (await res.json()) as {
              ok?: boolean;
              ts?: string;
              error?: string;
            };
            if (!data.ok) {
              throw new SkillExecutionError("slack_notify", data.error ?? "unknown slack error");
            }
            return { delivered: true, ts: data.ts ?? null };
          },
          { config: SLACK_RETRY },
        );
      } catch (err) {
        const cause = err instanceof RetryExhaustedError ? err.lastError : err;
        if (cause instanceof RetryableHttpError) {
          throw new SkillExecutionError("slack_notify", `${cause.status} after retries`, {
            status: cause.status,
          });
        }
        throw cause;
      }
    });
  },
};
