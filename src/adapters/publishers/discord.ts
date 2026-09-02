/**
 * DiscordPublisher ; Discord webhook publisher.
 *
 * Promoted from the Forge-local outreach-publish-post skill Discord branch.
 * Webhook-only ; foreign-server posts (e.g. Starknet builders) stay HITL by
 * design ; an unconfigured webhook returns status="dlq" so the orchestrator
 * does not silently drop the action.
 *
 * @public
 */

import { HttpError, fetchOrThrow } from "../../http/fetch-json.js";
import type { PublishInput, PublishResult, PublisherPort } from "../../ports/publisher.js";

/** @public */
export interface DiscordPublisherConfig {
  /** Webhook URL ; may be empty (publisher reports unconfigured ; routes to dlq). */
  readonly webhookUrl: string;
}

/** @public */
export class DiscordPublisher implements PublisherPort {
  readonly channel = "discord" as const;
  private readonly cfg: DiscordPublisherConfig;

  constructor(cfg: DiscordPublisherConfig) {
    this.cfg = cfg;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(this.cfg.webhookUrl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!this.cfg.webhookUrl) {
      return {
        status: "dlq",
        channel: "discord",
        reason:
          "DISCORD_WEBHOOK_URL not set ; Discord posting requires a webhook owned by a server the bot is in ; foreign-server posts remain HITL by design",
      };
    }
    const p = input.payload;
    const message = typeof p.message === "string" ? p.message : "";
    if (!message) {
      return {
        status: "failed",
        channel: "discord",
        error: "discord platform requires payload.message",
      };
    }

    try {
      // Discord webhooks return 204 with no body on success ; posted_url not
      // available (204 satisfies res.ok, same as any other 2xx).
      await fetchOrThrow(
        this.cfg.webhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
          signal: AbortSignal.timeout(15_000),
        },
        { bodySnippetLength: 256 },
      );
      return {
        status: "published",
        channel: "discord",
        posted_id: `discord-${Date.now()}`,
        posted_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          status: "failed",
          channel: "discord",
          error: `discord webhook ${err.status}: ${err.bodySnippet}`,
        };
      }
      return {
        status: "failed",
        channel: "discord",
        error: (err as Error).message,
      };
    }
  }
}
