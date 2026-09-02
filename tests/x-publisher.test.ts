/**
 * Tests for XPublisher.publish() — reply_to_id forwarding (SDK 3.0.1 fix).
 *
 * Stubs global fetch to avoid real HTTP calls. Exercises:
 *   - payload.reply_to_id forwarded to postTweet (in_reply_to_tweet_id body field)
 *   - standalone post when reply_to_id is absent
 *   - missing text returns failed status
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { XPublisher } from "../src/adapters/publishers/x.js";
import type { XPublisherConfig } from "../src/adapters/publishers/x.js";

const FAKE_CFG: XPublisherConfig = {
  bearerToken: "bt",
  apiKey: "ak",
  apiKeySecret: "aks",
  accessToken: "at",
  accessTokenSecret: "ats",
};

const FAKE_SLEEP = () => Promise.resolve();
const FAKE_RANDOM = () => 0;

function makeFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[call++] ?? responses[responses.length - 1];
    return {
      ok: r!.ok,
      text: async () => JSON.stringify(r!.body),
      json: async () => r!.body,
    };
  });
}

const OK_RESPONSE = { ok: true, body: { data: { id: "tweet-abc" } } };

describe("XPublisher.publish — reply_to_id forwarding", () => {
  let fetchMock: ReturnType<typeof makeFetch>;

  beforeEach(() => {
    fetchMock = makeFetch([OK_RESPONSE]);
    vi.stubGlobal("fetch", fetchMock);
  });

  it("forwards payload.reply_to_id as in_reply_to_tweet_id in the POST body", async () => {
    const publisher = new XPublisher(FAKE_CFG, {
      sleep: FAKE_SLEEP,
      random: FAKE_RANDOM,
    });

    const result = await publisher.publish({
      payload: {
        text: "Hello reply",
        reply_to_id: "original-tweet-999",
      },
    });

    expect(result.status).toBe("published");

    const callArgs = fetchMock.mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;

    expect(body.reply).toEqual({
      in_reply_to_tweet_id: "original-tweet-999",
    });
  });

  it("does NOT include reply field when reply_to_id is absent", async () => {
    const publisher = new XPublisher(FAKE_CFG, {
      sleep: FAKE_SLEEP,
      random: FAKE_RANDOM,
    });

    await publisher.publish({ payload: { text: "Standalone tweet" } });

    const callArgs = fetchMock.mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;

    expect(body.reply).toBeUndefined();
  });

  it("returns failed when text is missing", async () => {
    const publisher = new XPublisher(FAKE_CFG, {
      sleep: FAKE_SLEEP,
      random: FAKE_RANDOM,
    });

    const result = await publisher.publish({ payload: {} });
    expect(result.status).toBe("failed");
    expect((result as { error: string }).error).toMatch(/text required/);
  });
});
