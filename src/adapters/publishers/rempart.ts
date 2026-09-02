/**
 * RempartPublisher ; routes article-shaped payloads to Rempart via MCP.
 *
 * The Rempart MCP exposes `publish_article` (title, content, slug, tags?).
 * This publisher does NOT instantiate an MCP client itself ; it takes an
 * `mcpCaller` in its constructor so callers can plug their own client
 * (Forge has a Rempart MCP wrapper ; Preste has its own). This keeps the
 * SDK transport-agnostic and avoids a new top-level dep.
 *
 * @public
 */

import type { PublishInput, PublishResult, PublisherPort } from "../../ports/publisher.js";

/**
 * Generic MCP caller signature ; takes a tool name + args, returns the tool
 * result as a JSON object. The caller is responsible for transport + auth.
 * @public
 */
export type RempartMcpCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** @public */
export interface RempartPublisherConfig {
  /** Required ; MCP caller for the `rempart` server. */
  readonly mcpCaller: RempartMcpCaller;
}

/** @public */
export class RempartPublisher implements PublisherPort {
  readonly channel = "rempart" as const;
  private readonly cfg: RempartPublisherConfig;

  constructor(cfg: RempartPublisherConfig) {
    this.cfg = cfg;
  }

  async isConfigured(): Promise<boolean> {
    return typeof this.cfg.mcpCaller === "function";
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!(await this.isConfigured())) {
      return {
        status: "dlq",
        channel: "rempart",
        reason: "RempartPublisher.mcpCaller not provided",
      };
    }

    const p = input.payload;
    const title = typeof p.title === "string" ? p.title : "";
    const content = typeof p.content === "string" ? p.content : "";
    if (!title || !content) {
      return {
        status: "failed",
        channel: "rempart",
        error: "rempart platform requires payload.title and payload.content",
      };
    }
    const slug = typeof p.slug === "string" ? p.slug : undefined;
    const tags = Array.isArray(p.tags)
      ? (p.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined;
    const excerpt = typeof p.excerpt === "string" ? p.excerpt : undefined;

    const args: Record<string, unknown> = { title, content };
    if (slug) args.slug = slug;
    if (tags && tags.length > 0) args.tags = tags;
    if (excerpt) args.excerpt = excerpt;

    try {
      const result = await this.cfg.mcpCaller("publish_article", args);
      const url =
        typeof result.url === "string"
          ? (result.url as string)
          : typeof result.posted_url === "string"
            ? (result.posted_url as string)
            : undefined;
      const id =
        typeof result.id === "string"
          ? (result.id as string)
          : typeof result.article_id === "string"
            ? (result.article_id as string)
            : typeof result.posted_id === "string"
              ? (result.posted_id as string)
              : undefined;

      const out: PublishResult = {
        status: "published",
        channel: "rempart",
        posted_at: new Date().toISOString(),
        ...(url ? { posted_url: url } : {}),
        ...(id ? { posted_id: id } : {}),
      };
      return out;
    } catch (err) {
      return {
        status: "failed",
        channel: "rempart",
        error: (err as Error).message,
      };
    }
  }
}
