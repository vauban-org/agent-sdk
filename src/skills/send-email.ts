/**
 * send_email — SMTP via SMTP_URL OR Resend API key (whichever set).
 *
 * SDK does NOT pull nodemailer. SMTP_URL takes precedence ONLY if a
 * dynamically-imported `nodemailer` is available; else falls back to
 * Resend HTTP API. Choose one path at deploy time.
 *
 * @public
 */
import { z } from "zod";
import { HttpError, fetchJson } from "../http/fetch-json.js";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { withSkillSpan } from "./_otel.js";
import { readSecret } from "./_secrets.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";

const inputSchema = z
  .object({
    to: z.string().email(),
    from: z.string().email().optional(),
    subject: z.string().min(1).max(998),
    text: z.string().min(1),
    html: z.string().optional(),
  })
  .strict();
type SendEmailInput = z.infer<typeof inputSchema>;

/** @public */
export interface SendEmailOutput {
  delivered: boolean;
  provider: "smtp" | "resend" | "replay";
  message_id: string | null;
}

/** @public */
export const sendEmail: Skill<SendEmailInput, SendEmailOutput> = {
  name: "send_email",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<SendEmailOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks.send_email;
      if (mock) return mock(input) as SendEmailOutput;
      return { delivered: false, provider: "replay", message_id: null };
    }
    return withSkillSpan("send_email", async () => {
      const resendKey = readSecret(ctx, "RESEND_API_KEY");
      const smtpUrl = readSecret(ctx, "SMTP_URL");
      const defaultFrom = readSecret(ctx, "EMAIL_FROM") ?? input.from;
      if (!resendKey && !smtpUrl) {
        throw new SkillNotConfiguredError("send_email", ["RESEND_API_KEY", "SMTP_URL"]);
      }
      if (!defaultFrom) {
        throw new SkillNotConfiguredError("send_email", ["EMAIL_FROM (or input.from)"]);
      }
      // Prefer Resend (HTTP) — no native dep.
      if (resendKey) {
        let data: { id?: string };
        try {
          data = await fetchJson("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: defaultFrom,
              to: [input.to],
              subject: input.subject,
              text: input.text,
              html: input.html,
            }),
          });
        } catch (err) {
          if (err instanceof HttpError) {
            throw new SkillExecutionError("send_email", `resend ${err.status}`, {
              status: err.status,
            });
          }
          throw err;
        }
        return {
          delivered: true,
          provider: "resend",
          message_id: data.id ?? null,
        };
      }
      // SMTP via dynamic import — host must add nodemailer if used.
      try {
        const mod = (await import(/* @vite-ignore */ "nodemailer")) as {
          createTransport: (url: string) => {
            sendMail: (opts: object) => Promise<{ messageId?: string }>;
          };
        };
        const transport = mod.createTransport(smtpUrl as string);
        const info = await transport.sendMail({
          from: defaultFrom,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        return {
          delivered: true,
          provider: "smtp",
          message_id: info.messageId ?? null,
        };
      } catch (err) {
        throw new SkillExecutionError("send_email", "smtp transport error", {
          cause: err,
        });
      }
    });
  },
};
