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
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

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

export interface SendEmailOutput {
  delivered: boolean;
  provider: "smtp" | "resend" | "replay";
  message_id: string | null;
}

export const sendEmail: Skill<SendEmailInput, SendEmailOutput> = {
  name: "send_email",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<SendEmailOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["send_email"];
      if (mock) return mock(input) as SendEmailOutput;
      return { delivered: false, provider: "replay", message_id: null };
    }
    return withSkillSpan("send_email", async () => {
      const resendKey = process.env.RESEND_API_KEY;
      const smtpUrl = process.env.SMTP_URL;
      const defaultFrom = process.env.EMAIL_FROM ?? input.from;
      if (!resendKey && !smtpUrl) {
        throw new SkillNotConfiguredError("send_email", [
          "RESEND_API_KEY",
          "SMTP_URL",
        ]);
      }
      if (!defaultFrom) {
        throw new SkillNotConfiguredError("send_email", [
          "EMAIL_FROM (or input.from)",
        ]);
      }
      // Prefer Resend (HTTP) — no native dep.
      if (resendKey) {
        const res = await fetch("https://api.resend.com/emails", {
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
        if (!res.ok) {
          throw new SkillExecutionError("send_email", `resend ${res.status}`, {
            status: res.status,
          });
        }
        const data = (await res.json()) as { id?: string };
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
