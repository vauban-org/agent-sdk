/**
 * EmailPublisher ; Resend HTTPS API publisher.
 *
 * Promoted from the Forge-local campaign-send-mail skill ; preserves the
 * Message-ID + mailto: posted_url + publish_evidence contract documented in
 * Brain pattern f15a286d.
 *
 * Env mapping (forge legacy naming) :
 *   - Resend API key historically lived in `PROTONMAIL_BRIDGE_PASS` ;
 *     XPublisherConfig keeps the explicit `apiKey` field name to avoid
 *     leaking that legacy.
 *
 * @public
 */

import { HttpError, fetchOrThrow } from "../../http/fetch-json.js";
import type { PublishInput, PublishResult, PublisherPort } from "../../ports/publisher.js";

/** @public */
export interface EmailPublisherConfig {
  /** Resend API key (re_xxx...). */
  readonly apiKey: string;
  /** Default `from` address when payload.from is absent. */
  readonly defaultFrom: string;
}

/** @public */
export class EmailPublisher implements PublisherPort {
  readonly channel = "email" as const;
  private readonly cfg: EmailPublisherConfig;

  constructor(cfg: EmailPublisherConfig) {
    this.cfg = cfg;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(this.cfg.apiKey);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const p = input.payload;
    const to = typeof p.to === "string" ? p.to : "";
    const subject = typeof p.subject === "string" ? p.subject : "";
    const body = typeof p.body === "string" ? p.body : "";
    if (!to || !subject || !body) {
      return {
        status: "failed",
        channel: "email",
        error: "to/subject/body required",
      };
    }

    if (!this.cfg.apiKey) {
      return {
        status: "failed",
        channel: "email",
        error: "Resend API key missing (EmailPublisherConfig.apiKey empty)",
      };
    }

    const fromAddr =
      typeof p.from === "string" && p.from ? (p.from as string) : this.cfg.defaultFrom;
    if (!fromAddr) {
      return {
        status: "failed",
        channel: "email",
        error: "no from address (payload.from + config.defaultFrom both empty)",
      };
    }

    const toList = to
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    try {
      const res = await fetchOrThrow(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromAddr,
            to: toList,
            subject,
            text: body,
          }),
          signal: AbortSignal.timeout(15_000),
        },
        { bodySnippetLength: 512 },
      );
      // Tolerant: a 2xx with an empty/malformed body still counts as sent.
      const data = (await res.json().catch(() => null)) as {
        id?: string;
      } | null;
      const messageId = data?.id ?? "resend-no-id";
      const firstRecipient = toList[0] ?? to;
      return {
        status: "published",
        channel: "email",
        posted_url: `mailto:${firstRecipient}`,
        posted_id: messageId,
        posted_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          status: "failed",
          channel: "email",
          error: `Resend API ${err.status}: ${err.bodySnippet}`,
        };
      }
      return {
        status: "failed",
        channel: "email",
        error: (err as Error).message || (err as Error).name,
      };
    }
  }
}
