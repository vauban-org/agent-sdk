/**
 * x_tweet_metrics — fetch X API v2 public_metrics + non_public_metrics for a given tweet_id.
 *
 * Returns likes, retweets, replies, impressions, bookmarks, quotes.
 * Auth: Bearer token via X_BEARER_TOKEN env.
 * non_public_metrics (impressions) requires OAuth 1.0a user context on owned tweets.
 * Falls back to public_metrics only when non_public_metrics returns 403.
 *
 * @public
 */
import { z } from "zod";
import { HttpError, fetchJson, fetchOrThrow } from "../http/fetch-json.js";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { withSkillSpan } from "./_otel.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";

const inputSchema = z
  .object({
    tweet_id: z.string().regex(/^\d+$/, "tweet_id must be a numeric string"),
  })
  .strict();
type XTweetMetricsInput = z.infer<typeof inputSchema>;

/** @public */
export interface XTweetMetricsOutput {
  tweet_id: string;
  likes: number;
  retweets: number;
  replies: number;
  impressions: number;
  bookmarks: number;
  quotes: number;
}

const MOCK_OUTPUT: XTweetMetricsOutput = {
  tweet_id: "0",
  likes: 0,
  retweets: 0,
  replies: 0,
  impressions: 0,
  bookmarks: 0,
  quotes: 0,
};

const X_TWEET_FIELDS = "public_metrics,non_public_metrics";
const X_API_TIMEOUT_MS = 10_000;

interface PublicMetricsWire {
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  impression_count?: number;
  bookmark_count?: number;
  quote_count?: number;
}

async function fetchPublicMetricsFallback(
  tweetId: string,
  bearerToken: string,
): Promise<XTweetMetricsOutput> {
  // non_public_metrics requires user context; fall back to public_metrics only.
  const urlPublic = `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`;
  let data: { data?: { public_metrics?: PublicMetricsWire } };
  try {
    data = await fetchJson(
      urlPublic,
      {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(X_API_TIMEOUT_MS),
      },
      { bodySnippetLength: 200 },
    );
  } catch (err) {
    if (err instanceof HttpError) {
      throw new SkillExecutionError(
        "x_tweet_metrics",
        `X API ${err.status} on public_metrics fallback: ${err.bodySnippet}`,
      );
    }
    throw err;
  }
  const pm = data.data?.public_metrics ?? {};
  return {
    tweet_id: tweetId,
    likes: pm.like_count ?? 0,
    retweets: pm.retweet_count ?? 0,
    replies: pm.reply_count ?? 0,
    impressions: pm.impression_count ?? 0,
    bookmarks: pm.bookmark_count ?? 0,
    quotes: pm.quote_count ?? 0,
  };
}

async function fetchTweetMetrics(
  tweetId: string,
  bearerToken: string,
): Promise<XTweetMetricsOutput> {
  // First attempt: request both public + non_public metrics
  const url = `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=${X_TWEET_FIELDS}`;
  let res: Response;
  try {
    res = await fetchOrThrow(
      url,
      {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(X_API_TIMEOUT_MS),
      },
      { bodySnippetLength: 200 },
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      return fetchPublicMetricsFallback(tweetId, bearerToken);
    }
    if (err instanceof HttpError) {
      throw new SkillExecutionError("x_tweet_metrics", `X API ${err.status}: ${err.bodySnippet}`);
    }
    throw err;
  }

  const data = (await res.json()) as {
    data?: {
      public_metrics?: {
        like_count?: number;
        retweet_count?: number;
        reply_count?: number;
        impression_count?: number;
        bookmark_count?: number;
        quote_count?: number;
      };
      non_public_metrics?: {
        impression_count?: number;
      };
    };
  };

  const pm = data.data?.public_metrics ?? {};
  const npm = data.data?.non_public_metrics ?? {};

  return {
    tweet_id: tweetId,
    likes: pm.like_count ?? 0,
    retweets: pm.retweet_count ?? 0,
    replies: pm.reply_count ?? 0,
    // non_public impressions are more accurate when available
    impressions: npm.impression_count ?? pm.impression_count ?? 0,
    bookmarks: pm.bookmark_count ?? 0,
    quotes: pm.quote_count ?? 0,
  };
}

/** @public */
export const xTweetMetrics: Skill<XTweetMetricsInput, XTweetMetricsOutput> = {
  name: "x_tweet_metrics",
  inputSchema,
  async execute(input: XTweetMetricsInput, ctx: SkillContext): Promise<XTweetMetricsOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks.x_tweet_metrics;
      if (mock) return mock(input) as XTweetMetricsOutput;
      return { ...MOCK_OUTPUT, tweet_id: input.tweet_id };
    }

    return withSkillSpan("x_tweet_metrics", async () => {
      const bearerToken = process.env.X_BEARER_TOKEN;
      if (!bearerToken) {
        throw new SkillNotConfiguredError("x_tweet_metrics", ["X_BEARER_TOKEN"]);
      }
      return fetchTweetMetrics(input.tweet_id, bearerToken);
    });
  },
};
