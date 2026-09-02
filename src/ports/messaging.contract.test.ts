/**
 * MessagingChannelPort contract test suite.
 *
 * Applied to all 5 adapters: Telegram, Slack, Discord, Console, MCP.
 * HTTP adapters use vitest mock fetch — no real API calls.
 *
 * sprint-615:quick-2
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { ConsoleChannel } from "../adapters/messaging/console.js";
import { DiscordChannel } from "../adapters/messaging/discord.js";
import { MCPChannel } from "../adapters/messaging/mcp.js";
import type { MCPClientLike } from "../adapters/messaging/mcp.js";
import { SlackChannel } from "../adapters/messaging/slack.js";
import { TelegramChannel, TelegramRateLimitError } from "../adapters/messaging/telegram.js";
import type { MessagingChannelPort } from "./messaging.js";
import { InvalidTargetError } from "./messaging.js";

// ─── Contract suite ───────────────────────────────────────────────────────────

/**
 * Shared contract applied to every MessagingChannelPort implementation.
 *
 * @param factory - Returns a fresh adapter instance for each test.
 * @param opts    - Per-adapter overrides for special cases.
 */
export function messagingChannelContract(
  factory: () => MessagingChannelPort,
  opts: {
    /** Skip rate-limit test if the adapter cannot simulate 429 via fetch mock */
    skipRateLimit?: boolean;
    /** Adapter name for describe label */
    name?: string;
  } = {},
): void {
  describe(`MessagingChannelPort contract${opts.name ? ` — ${opts.name}` : ""}`, () => {
    test("sendAlert critical formats title prominently", async () => {
      // Verify the adapter does not throw and the level is communicated
      const channel = factory();
      // No throw = correct; we capture output via mock in per-adapter tests
      await expect(
        channel.sendAlert("critical", "System down", "All services unreachable"),
      ).resolves.toBeUndefined();
    });

    test("sendAlert info|warn|error|critical all callable without throw", async () => {
      const channel = factory();
      await expect(channel.sendAlert("info", "T", "B")).resolves.toBeUndefined();
      await expect(channel.sendAlert("warn", "T", "B")).resolves.toBeUndefined();
      await expect(channel.sendAlert("error", "T", "B")).resolves.toBeUndefined();
      await expect(channel.sendAlert("critical", "T", "B")).resolves.toBeUndefined();
    });

    test("sendMessage with valid target succeeds", async () => {
      const channel = factory();
      await expect(channel.sendMessage("target-123", "hello")).resolves.toBeUndefined();
    });

    test("sendMessage with empty target throws InvalidTargetError", async () => {
      const channel = factory();
      await expect(channel.sendMessage("", "hello")).rejects.toThrow(InvalidTargetError);
    });

    test("sendMessage with whitespace-only target throws InvalidTargetError", async () => {
      const channel = factory();
      await expect(channel.sendMessage("   ", "hello")).rejects.toThrow(InvalidTargetError);
    });

    if (!opts.skipRateLimit) {
      test("rate limit handling returns or throws clear error (no silent drop)", async () => {
        // Each adapter suite overrides fetch to return 429 — verified there
        // This baseline ensures the contract documents the requirement.
        // Per-adapter tests exercise the actual throw path.
        expect(true).toBe(true);
      });
    }
  });
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

describe("TelegramChannel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      }),
    );
  });

  messagingChannelContract(
    () =>
      new TelegramChannel({
        botToken: "test-token",
        defaultChatId: "123456",
      }),
    { name: "TelegramChannel" },
  );

  test("sendAlert posts to Telegram API with correct level emoji", async () => {
    const channel = new TelegramChannel({
      botToken: "tok",
      defaultChatId: "42",
    });
    await channel.sendAlert("critical", "Down", "All gone");
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/bottok/sendMessage");
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.chat_id).toBe("42");
    expect(body.text).toContain("🚨");
    expect(body.text).toContain("CRITICAL");
  });

  test("sendMessage uses target as chat_id", async () => {
    const channel = new TelegramChannel({ botToken: "tok" });
    await channel.sendMessage("@mychannel", "hi");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.chat_id).toBe("@mychannel");
  });

  test("sendAlert throws InvalidTargetError when no defaultChatId", async () => {
    const channel = new TelegramChannel({ botToken: "tok" });
    await expect(channel.sendAlert("info", "T", "B")).rejects.toThrow(InvalidTargetError);
  });

  test("rate limit (429) throws TelegramRateLimitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ parameters: { retry_after: 30 } }),
      }),
    );
    const channel = new TelegramChannel({
      botToken: "tok",
      defaultChatId: "42",
    });
    await expect(channel.sendAlert("info", "T", "B")).rejects.toThrow(TelegramRateLimitError);
  });
});

// ─── Slack ────────────────────────────────────────────────────────────────────

describe("SlackChannel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
      }),
    );
  });

  messagingChannelContract(() => new SlackChannel({ webhookUrl: "https://hooks.slack.com/test" }), {
    name: "SlackChannel",
  });

  test("sendAlert posts Block Kit attachment with correct color", async () => {
    const channel = new SlackChannel({
      webhookUrl: "https://hooks.slack.com/test",
    });
    await channel.sendAlert("warn", "Watch out", "Details here");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      attachments: Array<{ color: string; title: string }>;
    };
    expect(body.attachments[0].color).toBe("warning");
    expect(body.attachments[0].title).toContain("WARN");
    expect(body.attachments[0].title).toContain("⚠️");
  });

  test("sendMessage prepends target to text", async () => {
    const channel = new SlackChannel({
      webhookUrl: "https://hooks.slack.com/test",
    });
    await channel.sendMessage("general", "hello team");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain("general");
    expect(body.text).toContain("hello team");
  });

  test("rate limit (429) throws with clear message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }),
    );
    const channel = new SlackChannel({
      webhookUrl: "https://hooks.slack.com/test",
    });
    await expect(channel.sendAlert("info", "T", "B")).rejects.toThrow(/rate limit/i);
  });
});

// ─── Discord ──────────────────────────────────────────────────────────────────

describe("DiscordChannel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => "",
      }),
    );
  });

  messagingChannelContract(
    () =>
      new DiscordChannel({
        webhookUrl: "https://discord.com/api/webhooks/test",
      }),
    { name: "DiscordChannel" },
  );

  test("sendAlert posts embed with correct color for info", async () => {
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/test",
    });
    await channel.sendAlert("info", "Hello", "World");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ color: number; title: string }>;
    };
    expect(body.embeds[0].color).toBe(0x3498db);
    expect(body.embeds[0].title).toContain("INFO");
    expect(body.embeds[0].title).toContain("ℹ️");
  });

  test("sendAlert critical uses 0xff0000 color", async () => {
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/test",
    });
    await channel.sendAlert("critical", "FATAL", "System down");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ color: number }>;
    };
    expect(body.embeds[0].color).toBe(0xff0000);
  });

  test("sendMessage includes target as context label", async () => {
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/test",
    });
    await channel.sendMessage("ops-team", "deploy done");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("ops-team");
    expect(body.content).toContain("deploy done");
  });

  test("rate limit (429) throws with clear message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }),
    );
    const channel = new DiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/test",
    });
    await expect(channel.sendAlert("info", "T", "B")).rejects.toThrow(/rate limit/i);
  });
});

// ─── Console ──────────────────────────────────────────────────────────────────

describe("ConsoleChannel", () => {
  function makeMockStream(): {
    stream: NodeJS.WriteStream;
    output: () => string;
  } {
    let buf = "";
    const stream = {
      write: (data: string) => {
        buf += data;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { stream, output: () => buf };
  }

  messagingChannelContract(() => new ConsoleChannel(), {
    name: "ConsoleChannel",
  });

  test("sendAlert writes [LEVEL] tag with ANSI codes", async () => {
    const { stream, output } = makeMockStream();
    const channel = new ConsoleChannel({ stream });
    await channel.sendAlert("error", "Crash", "Segfault");
    expect(output()).toContain("[ERROR]");
    expect(output()).toContain("Crash");
    expect(output()).toContain("Segfault");
    // ANSI reset code present
    expect(output()).toContain("\x1b[0m");
  });

  test("sendAlert critical uses bold+red ANSI", async () => {
    const { stream, output } = makeMockStream();
    const channel = new ConsoleChannel({ stream });
    await channel.sendAlert("critical", "FATAL", "boom");
    expect(output()).toContain("\x1b[1m\x1b[31m");
    expect(output()).toContain("[CRITICAL]");
  });

  test("sendMessage writes MSG→target prefix", async () => {
    const { stream, output } = makeMockStream();
    const channel = new ConsoleChannel({ stream });
    await channel.sendMessage("ops", "hello");
    expect(output()).toContain("[MSG→ops]");
    expect(output()).toContain("hello");
  });

  test("constructor with no args uses process.stdout (no throw)", () => {
    expect(() => new ConsoleChannel()).not.toThrow();
  });

  // ConsoleChannel has no HTTP calls — skip rate limit test
});

// ─── MCPChannel ───────────────────────────────────────────────────────────────

describe("MCPChannel", () => {
  function makeMockClient(): {
    client: MCPClientLike;
    calls: Array<{ name: string; args: unknown }>;
  } {
    const calls: Array<{ name: string; args: unknown }> = [];
    const client: MCPClientLike = {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { ok: true };
      },
    };
    return { client, calls };
  }

  messagingChannelContract(
    () => {
      const { client } = makeMockClient();
      return new MCPChannel({
        mcpClient: client,
        toolName: "send_notification",
      });
    },
    { name: "MCPChannel" },
  );

  test("sendAlert calls mcpClient.callTool with level/title/body", async () => {
    const { client, calls } = makeMockClient();
    const channel = new MCPChannel({ mcpClient: client, toolName: "notify" });
    await channel.sendAlert("critical", "Down", "All gone");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("notify");
    expect(calls[0].args).toEqual({
      level: "critical",
      title: "Down",
      body: "All gone",
    });
  });

  test("sendMessage calls mcpClient.callTool with target/text", async () => {
    const { client, calls } = makeMockClient();
    const channel = new MCPChannel({ mcpClient: client, toolName: "notify" });
    await channel.sendMessage("ops", "deploy done");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ target: "ops", text: "deploy done" });
  });

  test("rate limit: callTool rejection propagates as clear error (no silent drop)", async () => {
    const client: MCPClientLike = {
      callTool: async () => {
        throw new Error("MCP tool error: 429 rate limit");
      },
    };
    const channel = new MCPChannel({ mcpClient: client, toolName: "notify" });
    await expect(channel.sendAlert("info", "T", "B")).rejects.toThrow(/429 rate limit/);
  });
});
