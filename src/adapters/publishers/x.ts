/**
 * XPublisher ; X (Twitter) v2 /2/tweets publisher with thread chaining,
 * 280-char validation, jittered inter-tweet sleep, and duplicate-content
 * retry. Promoted from the Forge-local outreach-publish-post skill ;
 * SDK 1.15.0.
 *
 * Behavior preserved from Forge :
 *   - 280-char per-tweet validation (free-tier write).
 *   - 30-90s jittered sleep before each reply (anti-spam guard).
 *   - Retry-once on duplicate-content 403/422 after a longer 120-180s sleep.
 *   - Persistent duplicate rejection ; keep chaining off the previous successful
 *     replyToId, surface 1-based partial_failure_tweets, status stays
 *     "published" (root went out, ops decides whether to escalate).
 *
 * The OAuth 1.0a HMAC-SHA1 signing is implemented inline ; no external
 * dependency (Node 20+ native fetch + crypto).
 *
 * @public
 */

import { createHmac } from "node:crypto";
import { fetchJson } from "../../http/fetch-json.js";
import type { PublishInput, PublishResult, PublisherPort } from "../../ports/publisher.js";

/** @public */
export interface XPublisherConfig {
  readonly bearerToken: string;
  readonly apiKey: string;
  readonly apiKeySecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

/** @public */
export interface XPublisherOptions {
  /** Override for tests ; defaults to native setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override for tests ; defaults to Math.random. Returns [0, 1). */
  readonly random?: () => number;
}

const X_TWEET_MAX_CHARS = 280;
const X_THREAD_SLEEP_MIN_MS = 30_000;
const X_THREAD_SLEEP_RANGE_MS = 60_000;
const X_THREAD_RETRY_SLEEP_MIN_MS = 120_000;
const X_THREAD_RETRY_SLEEP_RANGE_MS = 60_000;

function rfc3986Encode(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function buildOAuthHeader(method: string, url: string, cfg: XPublisherConfig): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nc = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cfg.apiKey,
    oauth_nonce: nc,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: ts,
    oauth_token: cfg.accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(oauthParams[k] ?? "")}`)
    .join("&");

  const baseString = [method.toUpperCase(), rfc3986Encode(url), rfc3986Encode(paramString)].join(
    "&",
  );

  const signingKey = `${rfc3986Encode(cfg.apiKeySecret)}&${rfc3986Encode(cfg.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  return `OAuth ${Object.keys(oauthParams)
    .sort()
    .map((k) => `${rfc3986Encode(k)}="${rfc3986Encode(oauthParams[k] ?? "")}"`)
    .join(", ")}`;
}

async function postTweet(
  cfg: XPublisherConfig,
  text: string,
  replyToId?: string,
): Promise<{ id: string; url: string }> {
  const url = "https://api.twitter.com/2/tweets";
  const body: Record<string, unknown> = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const json = await fetchJson<{ data: { id: string } }>(
    url,
    {
      method: "POST",
      headers: {
        Authorization: buildOAuthHeader("POST", url, cfg),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { label: "X POST /2/tweets failed" },
  );
  return {
    id: json.data.id,
    url: `https://x.com/i/web/status/${json.data.id}`,
  };
}

function isDuplicateContentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(403|422)\b/.test(msg) && /duplicate/i.test(msg);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function validateTweetsOrThrow(tweets: readonly string[]): void {
  for (let i = 0; i < tweets.length; i++) {
    const t = tweets[i];
    if (!t || t.length === 0) {
      throw new Error(`tweet[${i}] is empty`);
    }
    if (t.length > X_TWEET_MAX_CHARS) {
      throw new Error(
        `tweet[${i}] length ${t.length} exceeds X free-tier cap ${X_TWEET_MAX_CHARS} ; X API would return 403 ; either trim the content or split into more tweets in the thread array`,
      );
    }
  }
}

/** @public */
export class XPublisher implements PublisherPort {
  readonly channel = "x" as const;
  private readonly cfg: XPublisherConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(cfg: XPublisherConfig, opts: XPublisherOptions = {}) {
    this.cfg = cfg;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(
      this.cfg.bearerToken &&
        this.cfg.apiKey &&
        this.cfg.apiKeySecret &&
        this.cfg.accessToken &&
        this.cfg.accessTokenSecret,
    );
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const p = input.payload;
    const text = typeof p.text === "string" ? p.text : "";
    if (!text) {
      return {
        status: "failed",
        channel: "x",
        error: "text required for x platform",
      };
    }

    const thread = Array.isArray(p.thread)
      ? (p.thread as unknown[]).filter((t): t is string => typeof t === "string")
      : [];

    const replyToId = typeof p.reply_to_id === "string" ? p.reply_to_id : undefined;

    const allTweets = [text, ...thread];
    try {
      validateTweetsOrThrow(allTweets);
    } catch (err) {
      return { status: "failed", channel: "x", error: (err as Error).message };
    }

    if (!(await this.isConfigured())) {
      return {
        status: "failed",
        channel: "x",
        error:
          "X publisher not configured ; X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_BEARER_TOKEN must all be set",
      };
    }

    let root: { id: string; url: string };
    try {
      root = await postTweet(this.cfg, text, replyToId);
    } catch (err) {
      return { status: "failed", channel: "x", error: (err as Error).message };
    }

    const partialFailureTweets: number[] = [];

    if (thread.length > 0) {
      let replyToId = root.id;
      for (let i = 0; i < thread.length; i++) {
        const tweet = thread[i];
        const baseSleepMs = X_THREAD_SLEEP_MIN_MS + this.random() * X_THREAD_SLEEP_RANGE_MS;
        await this.sleep(baseSleepMs);

        try {
          const reply = await postTweet(this.cfg, tweet, replyToId);
          replyToId = reply.id;
        } catch (err) {
          if (!isDuplicateContentError(err)) {
            return {
              status: "failed",
              channel: "x",
              error: (err as Error).message,
            };
          }
          // Deliberately NOT using the shared retry() primitive here (unlike
          // litellm.ts / linkedin.ts): calculateDelay()'s jitter is a fixed
          // ±25%-of-capped offset, i.e. max/min ratio 5/3 regardless of
          // config. This site's documented+tested window is a uniform
          // [120s, 180s] range (ratio 1.5) ; no baseDelayMs/maxDelayMs
          // satisfies both boundaries simultaneously (verified: at
          // this.random()=0 the shared formula undershoots 120s, at =1 it
          // overshoots 180s). Forcing the migration would either break the
          // existing 120-180s assertions or silently widen the retry window
          // in production. Kept as bespoke uniform-random backoff.
          const retrySleepMs =
            X_THREAD_RETRY_SLEEP_MIN_MS + this.random() * X_THREAD_RETRY_SLEEP_RANGE_MS;
          await this.sleep(retrySleepMs);
          try {
            const reply = await postTweet(this.cfg, tweet, replyToId);
            replyToId = reply.id;
          } catch (err2) {
            if (!isDuplicateContentError(err2)) {
              return {
                status: "failed",
                channel: "x",
                error: (err2 as Error).message,
              };
            }
            // Persistent duplicate ; skip this tweet, chain rest off the
            // previous successful reply id. Index is 1-based ; root = 1, so
            // the first reply (i=0) is tweet 2.
            partialFailureTweets.push(i + 2);
          }
        }
      }
    }

    const result: PublishResult = {
      status: "published",
      channel: "x",
      posted_url: root.url,
      posted_id: root.id,
      posted_at: new Date().toISOString(),
      ...(partialFailureTweets.length > 0 ? { partial_failure_tweets: partialFailureTweets } : {}),
    };
    return result;
  }
}
