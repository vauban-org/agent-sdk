/**
 * LinkedInPublisher ; LinkedIn API v2 UGC Posts publisher.
 *
 * Auth: Bearer token (OAuth 2.0 user token) via LINKEDIN_ACCESS_TOKEN env var.
 * Author URN: LINKEDIN_AUTHOR_URN env var (e.g. "urn:li:person:abc123").
 * Endpoint: POST https://api.linkedin.com/v2/ugcPosts
 * Limit: 3000 chars per post (LinkedIn platform limit).
 *
 * HTTP contract:
 *   - 401 : throws auth error, no retry
 *   - 429 : exponential backoff via the shared retry() primitive, max 3 retries
 *   - 5xx : throws with HTTP body, no retry
 *   - 2xx : returns posted_url + posted_id from the X-RestLi-Id response header
 *
 * @public
 */

import type { PublishInput, PublishResult, PublisherPort } from "../../ports/publisher.js";
import { type RetryConfig, RetryExhaustedError, retry } from "../../retry/index.js";

const LINKEDIN_POST_MAX_CHARS = 3000;
const LINKEDIN_API_BASE = "https://api.linkedin.com/v2/ugcPosts";
const LINKEDIN_FEED_PREFIX = "https://www.linkedin.com/feed/update/";

// maxAttempts = 1 initial try + 3 retries (matches the original MAX_RETRIES=3
// "retries" semantics, where the loop ran 4 total iterations).
const LINKEDIN_RETRY_MAX_ATTEMPTS = 4;
const LINKEDIN_RETRY_BASE_MS = 2_500;
const LINKEDIN_RETRY_CAP_MS = 20_000;

/**
 * Carries the exact PublishResult to return alongside whether this failure
 * is retryable (429 only). Lets the shared retry() control attempt count and
 * backoff while every non-2xx / non-network condition keeps its precise
 * error message.
 */
class LinkedInPublishFailure extends Error {
  constructor(
    public readonly result: PublishResult,
    public readonly retryable: boolean,
  ) {
    super(result.error ?? "linkedin publish failed");
    this.name = "LinkedInPublishFailure";
  }
}

export interface LinkedInPublisherConfig {
  /** Bearer token for LinkedIn OAuth 2.0. Falls back to LINKEDIN_ACCESS_TOKEN env var. */
  readonly accessToken?: string;
  /** Author URN (urn:li:person:<id>). Falls back to LINKEDIN_AUTHOR_URN env var. */
  readonly authorUrn?: string;
}

export interface LinkedInPublisherOptions {
  /** Override for tests ; defaults to native setTimeout-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override for tests ; returns [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LinkedInPublisher implements PublisherPort {
  readonly channel = "linkedin" as const;
  private readonly cfg: LinkedInPublisherConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(cfg: LinkedInPublisherConfig = {}, options: LinkedInPublisherOptions = {}) {
    this.cfg = cfg;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  private resolveToken(): string | undefined {
    return this.cfg.accessToken ?? process.env.LINKEDIN_ACCESS_TOKEN;
  }

  private resolveAuthorUrn(): string | undefined {
    return this.cfg.authorUrn ?? process.env.LINKEDIN_AUTHOR_URN;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(this.resolveToken()) && Boolean(this.resolveAuthorUrn());
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = this.resolveToken();
    if (!token) {
      return {
        status: "failed",
        channel: "linkedin",
        error:
          "LINKEDIN_ACCESS_TOKEN is required ; set it as env var or pass accessToken in config",
      };
    }

    const authorUrn = this.resolveAuthorUrn();
    if (!authorUrn) {
      return {
        status: "failed",
        channel: "linkedin",
        error: "LINKEDIN_AUTHOR_URN is required ; set it as env var or pass authorUrn in config",
      };
    }

    const p = input.payload;
    const rawText = typeof p.text === "string" ? p.text : "";
    if (!rawText) {
      return {
        status: "failed",
        channel: "linkedin",
        error: "linkedin platform requires payload.text",
      };
    }

    // Append mentions to text when provided (LinkedIn UGC API has no dedicated
    // mention field outside Shares v2 ; surface them inline).
    const mentions = Array.isArray(p.mentions)
      ? (p.mentions as unknown[]).filter((m): m is string => typeof m === "string")
      : [];
    const text = mentions.length > 0 ? `${rawText}\n${mentions.join(" ")}` : rawText;

    if (text.length > LINKEDIN_POST_MAX_CHARS) {
      return {
        status: "failed",
        channel: "linkedin",
        error: `linkedin post exceeds 3000-char limit (got ${text.length})`,
      };
    }

    const body = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    };

    const config: RetryConfig = {
      maxAttempts: LINKEDIN_RETRY_MAX_ATTEMPTS,
      baseDelayMs: LINKEDIN_RETRY_BASE_MS,
      maxDelayMs: LINKEDIN_RETRY_CAP_MS,
      exponentialBase: 2,
      jitter: true,
      retryIf: (err) => err instanceof LinkedInPublishFailure && err.retryable,
    };

    try {
      return await retry(
        async () => {
          let res: Response;
          try {
            res = await fetch(LINKEDIN_API_BASE, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "X-Restli-Protocol-Version": "2.0.0",
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(20_000),
            });
          } catch (err) {
            throw new LinkedInPublishFailure(
              {
                status: "failed",
                channel: "linkedin",
                error: `linkedin fetch error: ${(err as Error).message}`,
              },
              false,
            );
          }

          if (res.status === 401) {
            const bodyText = (await res.text().catch(() => "")).slice(0, 256);
            throw new LinkedInPublishFailure(
              {
                status: "failed",
                channel: "linkedin",
                error: `linkedin auth error (401): ${bodyText}`,
              },
              false,
            );
          }

          if (res.status === 429) {
            // Message matches the exhausted-retries case ; retry() unwraps
            // this same failure from RetryExhaustedError.lastError when the
            // final attempt also 429s.
            throw new LinkedInPublishFailure(
              {
                status: "failed",
                channel: "linkedin",
                error: "linkedin rate-limited (429): max retries exceeded",
              },
              true,
            );
          }

          if (res.status >= 500) {
            const bodyText = (await res.text().catch(() => "")).slice(0, 512);
            throw new LinkedInPublishFailure(
              {
                status: "failed",
                channel: "linkedin",
                error: `linkedin server error (${res.status}): ${bodyText}`,
              },
              false,
            );
          }

          if (res.ok) {
            // LinkedIn returns the post URN in the X-RestLi-Id header on 201.
            const urn = res.headers.get("x-restli-id") ?? res.headers.get("X-RestLi-Id");
            const posted_id = urn ?? undefined;
            const posted_url = urn
              ? `${LINKEDIN_FEED_PREFIX}${encodeURIComponent(urn)}`
              : undefined;

            return {
              status: "published",
              channel: "linkedin",
              posted_at: new Date().toISOString(),
              ...(posted_url ? { posted_url } : {}),
              ...(posted_id ? { posted_id } : {}),
            };
          }

          // Other 4xx errors (400, 403, etc.) ; no retry.
          const bodyText = (await res.text().catch(() => "")).slice(0, 256);
          throw new LinkedInPublishFailure(
            {
              status: "failed",
              channel: "linkedin",
              error: `linkedin error (${res.status}): ${bodyText}`,
            },
            false,
          );
        },
        { config, sleepFn: this.sleep, randomFn: this.random },
      );
    } catch (err) {
      const cause = err instanceof RetryExhaustedError ? err.lastError : err;
      if (cause instanceof LinkedInPublishFailure) {
        return cause.result;
      }
      throw err;
    }
  }
}
