/**
 * GitHubPublisher ; GitHub issue-comment publisher.
 *
 * Promoted from the Forge-local outreach-publish-post skill GitHub branch.
 * Expects payload `{ repo: "owner/name", issue: <number>, comment_body }`.
 *
 * @public
 */

import { HttpError, fetchJson } from "../../http/fetch-json.js";
import type { PublishInput, PublishResult, PublisherPort } from "../../ports/publisher.js";

/** @public */
export interface GitHubPublisherConfig {
  /** GitHub PAT or fine-grained token with `issues:write` on target repos. */
  readonly token: string;
}

/** @public */
export class GitHubPublisher implements PublisherPort {
  readonly channel = "github" as const;
  private readonly cfg: GitHubPublisherConfig;

  constructor(cfg: GitHubPublisherConfig) {
    this.cfg = cfg;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(this.cfg.token);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!this.cfg.token) {
      return {
        status: "failed",
        channel: "github",
        error: "GITHUB_TOKEN missing ; required for github platform",
      };
    }
    const p = input.payload;
    const repo = typeof p.repo === "string" ? p.repo : "";
    const issueNum = typeof p.issue === "number" ? p.issue : 0;
    const commentBody = typeof p.comment_body === "string" ? p.comment_body : "";
    if (!repo || !issueNum || !commentBody) {
      return {
        status: "failed",
        channel: "github",
        error:
          "github platform requires payload.repo (owner/name), payload.issue (number), payload.comment_body",
      };
    }

    try {
      const data = await fetchJson<{ html_url?: string; id?: number }>(
        `https://api.github.com/repos/${repo}/issues/${issueNum}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${this.cfg.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "vauban-agent-sdk-github-publisher",
          },
          body: JSON.stringify({ body: commentBody }),
          signal: AbortSignal.timeout(15_000),
        },
        { bodySnippetLength: 256 },
      );
      const result: PublishResult = {
        status: "published",
        channel: "github",
        posted_at: new Date().toISOString(),
        ...(data.html_url ? { posted_url: data.html_url } : {}),
        ...(data.id ? { posted_id: String(data.id) } : {}),
      };
      return result;
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          status: "failed",
          channel: "github",
          error: `github API ${err.status}: ${err.bodySnippet}`,
        };
      }
      return {
        status: "failed",
        channel: "github",
        error: (err as Error).message,
      };
    }
  }
}
