/**
 * Per-publisher unit tests with mocked fetch.
 * Contract test at the bottom verifies all publishers return uniform
 * PublishResult shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiscordPublisher,
  EmailPublisher,
  GitHubPublisher,
  LinkedInPublisher,
  type PublishInput,
  type PublishResult,
  type PublisherPort,
  RempartPublisher,
  XPublisher,
  createPublisherRegistry,
} from "./index.js";

const CTX = {
  campaignSlug: "test-campaign",
  actionId: "test-action-id",
};

function makeXCfg() {
  return {
    bearerToken: "b",
    apiKey: "k",
    apiKeySecret: "s",
    accessToken: "t",
    accessTokenSecret: "ts",
  };
}

describe("XPublisher", () => {
  let fetchCalls: Array<{ body: unknown }> = [];
  let fetchResponses: Response[] = [];
  let sleepCalls: number[] = [];

  function makeOk(id: string): Response {
    return new Response(JSON.stringify({ data: { id, text: `t-${id}` } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  function makeDup(): Response {
    return new Response(
      JSON.stringify({
        title: "Forbidden",
        detail: "You are not allowed to create a Tweet with duplicate content.",
        status: 403,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  beforeEach(() => {
    fetchCalls = [];
    fetchResponses = [];
    sleepCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchCalls.push({ body: init?.body });
        const r = fetchResponses.shift();
        if (!r) throw new Error("test: fetch called more times than mocked");
        return r;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makePub() {
    return new XPublisher(makeXCfg(), {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => 0.5,
    });
  }

  it("returns failed when text is missing", async () => {
    const res = await makePub().publish({
      payload: {},
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.channel).toBe("x");
    expect(res.error).toMatch(/text required/i);
  });

  it("posts a single root tweet successfully with publish_evidence", async () => {
    fetchResponses.push(makeOk("root1"));
    const res = await makePub().publish({
      payload: { text: "single root tweet under 280" },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.channel).toBe("x");
    expect(res.posted_id).toBe("root1");
    expect(res.posted_url).toBe("https://x.com/i/web/status/root1");
    expect(res.posted_at).toBeDefined();
  });

  it("rejects over-280 tweet with explicit error", async () => {
    const res = await makePub().publish({
      payload: { text: "a".repeat(300) },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/exceeds X free-tier cap 280/);
    expect(fetchCalls.length).toBe(0);
  });

  it("3-tweet thread all succeed ; sleep called 3x in 30-90s window", async () => {
    fetchResponses.push(makeOk("root"));
    fetchResponses.push(makeOk("r2"));
    fetchResponses.push(makeOk("r3"));
    fetchResponses.push(makeOk("r4"));

    const res = await makePub().publish({
      payload: {
        text: "Root tweet",
        thread: ["Reply 2", "Reply 3", "Reply 4"],
      },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.partial_failure_tweets).toBeUndefined();
    expect(sleepCalls).toHaveLength(3);
    for (const ms of sleepCalls) {
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThanOrEqual(90_000);
    }
  });

  it("4-tweet thread, duplicate 403 on tweet 2 then succeeds on retry", async () => {
    fetchResponses.push(makeOk("root"));
    fetchResponses.push(makeDup());
    fetchResponses.push(makeOk("r2-retry"));
    fetchResponses.push(makeOk("r3"));
    fetchResponses.push(makeOk("r4"));

    const res = await makePub().publish({
      payload: {
        text: "Root",
        thread: ["Reply 2", "Reply 3", "Reply 4"],
      },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.partial_failure_tweets).toBeUndefined();
    // Sleeps: 30-90s before t2 attempt 1, 120-180s retry, 30-90s before t3, 30-90s before t4
    expect(sleepCalls).toHaveLength(4);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(30_000);
    expect(sleepCalls[1]).toBeGreaterThanOrEqual(120_000);
    expect(sleepCalls[1]).toBeLessThanOrEqual(180_000);
  });

  it("4-tweet thread, persistent duplicate 403 on tweet 2 ; partial_failure_tweets=[2]", async () => {
    fetchResponses.push(makeOk("root"));
    fetchResponses.push(makeDup());
    fetchResponses.push(makeDup()); // retry also fails
    fetchResponses.push(makeOk("r3"));
    fetchResponses.push(makeOk("r4"));

    const res = await makePub().publish({
      payload: {
        text: "Root",
        thread: ["Reply 2", "Reply 3", "Reply 4"],
      },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.posted_id).toBe("root");
    expect(res.partial_failure_tweets).toEqual([2]);
  });
});

describe("EmailPublisher", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns failed without api key", async () => {
    const pub = new EmailPublisher({ apiKey: "", defaultFrom: "x@y.z" });
    const res = await pub.publish({
      payload: { to: "a@b.c", subject: "s", body: "b" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/Resend API key missing/i);
  });

  it("returns failed on missing to/subject/body", async () => {
    const pub = new EmailPublisher({ apiKey: "re_x", defaultFrom: "x@y.z" });
    const res = await pub.publish({
      payload: { subject: "s" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/to\/subject\/body required/);
  });

  it("returns published with message_id + mailto on Resend 200", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "resend-msg-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const pub = new EmailPublisher({ apiKey: "re_x", defaultFrom: "from@v.z" });
    const res = await pub.publish({
      payload: { to: "a@b.c", subject: "s", body: "b" },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.channel).toBe("email");
    expect(res.posted_id).toBe("resend-msg-1");
    expect(res.posted_url).toBe("mailto:a@b.c");
  });

  it("returns failed on Resend 500", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    const pub = new EmailPublisher({ apiKey: "re_x", defaultFrom: "from@v.z" });
    const res = await pub.publish({
      payload: { to: "a@b.c", subject: "s", body: "b" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/Resend API 500/);
  });
});

describe("DiscordPublisher", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns dlq when webhook URL is empty", async () => {
    const pub = new DiscordPublisher({ webhookUrl: "" });
    const res = await pub.publish({
      payload: { message: "hi" },
      context: CTX,
    });
    expect(res.status).toBe("dlq");
    expect(res.reason).toMatch(/DISCORD_WEBHOOK_URL not set/);
  });

  it("returns failed when message is empty", async () => {
    const pub = new DiscordPublisher({ webhookUrl: "https://discord.com/api/webhooks/x" });
    const res = await pub.publish({
      payload: {},
      context: CTX,
    });
    expect(res.status).toBe("failed");
  });

  it("returns published on 204", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const pub = new DiscordPublisher({ webhookUrl: "https://discord.com/api/webhooks/x" });
    const res = await pub.publish({
      payload: { message: "hi" },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.posted_id).toMatch(/^discord-/);
  });
});

describe("GitHubPublisher", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns failed without token", async () => {
    const pub = new GitHubPublisher({ token: "" });
    const res = await pub.publish({
      payload: { repo: "x/y", issue: 1, comment_body: "hi" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/GITHUB_TOKEN missing/);
  });

  it("returns failed on missing repo / issue / comment_body", async () => {
    const pub = new GitHubPublisher({ token: "gh_x" });
    const res = await pub.publish({
      payload: { repo: "x/y" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
  });

  it("returns published with html_url + id on 201", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          html_url: "https://github.com/x/y/issues/1#issuecomment-42",
          id: 42,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    const pub = new GitHubPublisher({ token: "gh_x" });
    const res = await pub.publish({
      payload: { repo: "x/y", issue: 1, comment_body: "hi" },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.posted_url).toBe("https://github.com/x/y/issues/1#issuecomment-42");
    expect(res.posted_id).toBe("42");
  });
});

describe("RempartPublisher", () => {
  it("returns dlq when mcpCaller not provided", async () => {
    // Casting to test the misuse path ; type system would reject this normally.
    const pub = new RempartPublisher({
      mcpCaller: undefined as unknown as RempartPublisher["cfg"]["mcpCaller"],
    });
    const res = await pub.publish({
      payload: { title: "t", content: "c" },
      context: CTX,
    });
    expect(res.status).toBe("dlq");
  });

  it("returns failed when title or content missing", async () => {
    const mcpCaller = vi.fn();
    const pub = new RempartPublisher({ mcpCaller });
    const res = await pub.publish({
      payload: { title: "t" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(mcpCaller).not.toHaveBeenCalled();
  });

  it("returns published with posted_url + posted_id on MCP success", async () => {
    const mcpCaller = vi.fn().mockResolvedValue({
      url: "https://rempart.vauban.tech/articles/foo",
      id: "art-123",
    });
    const pub = new RempartPublisher({ mcpCaller });
    const res = await pub.publish({
      payload: {
        title: "Title",
        content: "Body content",
        tags: ["zk", "starknet"],
      },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.channel).toBe("rempart");
    expect(res.posted_url).toBe("https://rempart.vauban.tech/articles/foo");
    expect(res.posted_id).toBe("art-123");
    expect(mcpCaller).toHaveBeenCalledWith(
      "publish_article",
      expect.objectContaining({
        title: "Title",
        content: "Body content",
        tags: ["zk", "starknet"],
      }),
    );
  });

  it("returns failed on MCP caller throw", async () => {
    const mcpCaller = vi.fn().mockRejectedValue(new Error("mcp boom"));
    const pub = new RempartPublisher({ mcpCaller });
    const res = await pub.publish({
      payload: { title: "t", content: "c" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/mcp boom/);
  });
});

describe("createPublisherRegistry", () => {
  function dummy(channel: string): PublisherPort {
    return {
      channel,
      isConfigured: async () => true,
      publish: async () => ({ status: "published", channel }),
    };
  }

  it("registers provided publishers and returns null for unknown channel", () => {
    const reg = createPublisherRegistry({
      x: dummy("x"),
      email: dummy("email"),
    });
    expect(reg.get("x")?.channel).toBe("x");
    expect(reg.get("email")?.channel).toBe("email");
    expect(reg.get("bluesky")).toBeNull();
    expect(reg.channels().sort()).toEqual(["email", "x"]);
  });

  it("pick uses payload.platform when present", () => {
    const reg = createPublisherRegistry({
      x: dummy("x"),
      linkedin: dummy("linkedin"),
    });
    const picked = reg.pick("publish_social_post", { platform: "linkedin" });
    expect(picked?.channel).toBe("linkedin");
  });

  it("pick falls back to action_type default (publish_article → rempart)", () => {
    const reg = createPublisherRegistry({
      rempart: dummy("rempart"),
    });
    const picked = reg.pick("publish_article", {});
    expect(picked?.channel).toBe("rempart");
  });

  it("pick falls back to action_type default (send_cold_mail → email)", () => {
    const reg = createPublisherRegistry({ email: dummy("email") });
    const picked = reg.pick("send_cold_mail", { to: "a@b.c" });
    expect(picked?.channel).toBe("email");
  });

  it("pick returns null when no match", () => {
    const reg = createPublisherRegistry({});
    expect(reg.pick("publish_social_post", {})).toBeNull();
  });

  it("extras are reachable via get + pick", () => {
    const reg = createPublisherRegistry({
      extras: { bluesky: dummy("bluesky") },
    });
    expect(reg.get("bluesky")?.channel).toBe("bluesky");
    expect(reg.pick("publish_social_post", { platform: "bluesky" })?.channel).toBe("bluesky");
  });
});

describe("LinkedInPublisher", () => {
  let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let fetchResponses: Response[] = [];
  let sleepCalls: number[] = [];

  function makeOk(urn: string): Response {
    return new Response(JSON.stringify({}), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "x-restli-id": urn,
      },
    });
  }
  function make429(): Response {
    return new Response("rate limited", { status: 429 });
  }
  function make401(): Response {
    return new Response("unauthorized", { status: 401 });
  }
  function make500(body = "internal error"): Response {
    return new Response(body, { status: 500 });
  }

  beforeEach(() => {
    fetchCalls = [];
    fetchResponses = [];
    sleepCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        const r = fetchResponses.shift();
        if (!r) throw new Error("test: fetch called more times than mocked");
        return r;
      }),
    );
    // Clear env vars to isolate tests.
    delete process.env.LINKEDIN_ACCESS_TOKEN;
    delete process.env.LINKEDIN_AUTHOR_URN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LINKEDIN_ACCESS_TOKEN;
    delete process.env.LINKEDIN_AUTHOR_URN;
  });

  function makePub(overrides: { accessToken?: string; authorUrn?: string } = {}) {
    return new LinkedInPublisher(overrides, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => 0.5,
    });
  }

  it("returns failed when LINKEDIN_ACCESS_TOKEN is missing", async () => {
    process.env.LINKEDIN_AUTHOR_URN = "urn:li:person:abc123";
    const pub = makePub();
    const res = await pub.publish({
      payload: { text: "hello linkedin" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.channel).toBe("linkedin");
    expect(res.error).toMatch(/LINKEDIN_ACCESS_TOKEN/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("returns failed when LINKEDIN_AUTHOR_URN is missing", async () => {
    process.env.LINKEDIN_ACCESS_TOKEN = "tok-123";
    const pub = makePub();
    const res = await pub.publish({
      payload: { text: "hello linkedin" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.channel).toBe("linkedin");
    expect(res.error).toMatch(/LINKEDIN_AUTHOR_URN/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("posts successfully and returns posted_url + posted_id from X-RestLi-Id", async () => {
    const urn = "urn:li:ugcPost:123456789";
    fetchResponses.push(makeOk(urn));
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({
      payload: { text: "Release 1.16.0 ships LinkedInPublisher." },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.channel).toBe("linkedin");
    expect(res.posted_id).toBe(urn);
    expect(res.posted_url).toContain("linkedin.com/feed/update/");
    expect(res.posted_url).toContain(encodeURIComponent(urn));
    expect(typeof res.posted_at).toBe("string");
    expect(fetchCalls).toHaveLength(1);
    // Verify Authorization header present.
    const reqHeaders = fetchCalls[0]?.init?.headers as Record<string, string>;
    expect(reqHeaders?.Authorization).toBe("Bearer tok-abc");
  });

  it("returns failed when text exceeds 3000 chars", async () => {
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({
      payload: { text: "a".repeat(3001) },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/3000/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("appends mentions to text", async () => {
    const urn = "urn:li:ugcPost:555";
    fetchResponses.push(makeOk(urn));
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    await pub.publish({
      payload: { text: "Hello world.", mentions: ["@fabien", "@vauban"] },
      context: CTX,
    });
    const body = JSON.parse(fetchCalls[0]?.init?.body as string) as {
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: string };
        };
      };
    };
    const sent = body.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text;
    expect(sent).toContain("@fabien");
    expect(sent).toContain("@vauban");
  });

  it("throws auth error on 401, does not retry", async () => {
    fetchResponses.push(make401());
    const pub = makePub({
      accessToken: "bad-tok",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({
      payload: { text: "post content" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/401/);
    // Exactly 1 fetch call (no retry on 401).
    expect(fetchCalls).toHaveLength(1);
    expect(sleepCalls).toHaveLength(0);
  });

  it("retries on 429 up to 3x with backoff then fails", async () => {
    fetchResponses.push(make429(), make429(), make429(), make429());
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({
      payload: { text: "post content" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/429/);
    // 4 fetches: attempt 0 + 3 retries.
    expect(fetchCalls).toHaveLength(4);
    // 3 sleeps (before retries 1, 2, 3).
    expect(sleepCalls).toHaveLength(3);
    // Backoff grows exponentially: 2500 * 1, 2500 * 2, 2500 * 4.
    expect(sleepCalls[0]).toBeLessThan(sleepCalls[1]!);
    expect(sleepCalls[1]).toBeLessThan(sleepCalls[2]!);
  });

  it("retries on 429 and succeeds on subsequent attempt", async () => {
    const urn = "urn:li:ugcPost:777";
    fetchResponses.push(make429(), makeOk(urn));
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({
      payload: { text: "post content" },
      context: CTX,
    });
    expect(res.status).toBe("published");
    expect(res.posted_id).toBe(urn);
    expect(fetchCalls).toHaveLength(2);
    expect(sleepCalls).toHaveLength(1);
  });

  it("returns failed on 500 with body, no retry", async () => {
    fetchResponses.push(make500("Internal Server Error"));
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({
      payload: { text: "post content" },
      context: CTX,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/500/);
    expect(res.error).toMatch(/Internal Server Error/);
    expect(fetchCalls).toHaveLength(1);
  });

  it("returns failed when payload.text is missing", async () => {
    const pub = makePub({
      accessToken: "tok-abc",
      authorUrn: "urn:li:person:abc123",
    });
    const res = await pub.publish({ payload: {}, context: CTX });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/payload.text/);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("PublisherPort contract ; all publishers conform to PublishResult shape", () => {
  function validateResultShape(r: PublishResult, channel: string) {
    expect(r.channel).toBe(channel);
    expect(["published", "dlq", "failed", "partial"]).toContain(r.status);
    if (r.posted_at !== undefined) {
      expect(typeof r.posted_at).toBe("string");
    }
    if (r.partial_failure_tweets !== undefined) {
      expect(Array.isArray(r.partial_failure_tweets)).toBe(true);
    }
  }

  it("Email/Discord/GitHub/Rempart all emit conformant results in error path", async () => {
    const input: PublishInput = { payload: {}, context: CTX };

    const email = await new EmailPublisher({ apiKey: "", defaultFrom: "" }).publish(input);
    validateResultShape(email, "email");

    const discord = await new DiscordPublisher({ webhookUrl: "" }).publish(input);
    validateResultShape(discord, "discord");

    const github = await new GitHubPublisher({ token: "" }).publish(input);
    validateResultShape(github, "github");

    const rempart = await new RempartPublisher({
      mcpCaller: async () => ({}),
    }).publish(input);
    validateResultShape(rempart, "rempart");
  });

  it("XPublisher emits conformant result in error path", async () => {
    const x = new XPublisher(makeXCfg(), {
      sleep: async () => {},
      random: () => 0.5,
    });
    const res = await x.publish({ payload: {}, context: CTX });
    expect(res.channel).toBe("x");
    expect(res.status).toBe("failed");
  });

  it("LinkedInPublisher emits conformant result in error path (missing token)", async () => {
    delete process.env.LINKEDIN_ACCESS_TOKEN;
    delete process.env.LINKEDIN_AUTHOR_URN;
    const li = new LinkedInPublisher();
    const res = await li.publish({ payload: {}, context: CTX });
    expect(res.channel).toBe("linkedin");
    expect(res.status).toBe("failed");
  });
});
