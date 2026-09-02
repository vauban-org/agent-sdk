/**
 * Tests for:
 *   agent-sdk/src/adapters/messaging/discord.ts
 *   agent-sdk/src/patterns/_shared/brain-logger.ts
 *
 * Coverage (DiscordChannel):
 *   sendAlert — POSTs embed with correct level color/emoji/title, handles 204,
 *               throws on 429, throws on non-ok status
 *   sendMessage — POSTs content string with [→ target] prefix,
 *                 throws InvalidTargetError on empty target
 *
 * Coverage (logToBrain):
 *   no-op when brain is null/undefined
 *   calls archiveKnowledge with the entry (fire-and-forget, void return)
 *   swallows archiveKnowledge rejection silently
 *
 * Ref: test coverage for discord.ts + brain-logger.ts (no prior tests)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordChannel } from "../src/adapters/messaging/discord.js";
import { logToBrain } from "../src/patterns/_shared/brain-logger.js";
import type { BrainPort } from "../src/ports/brain.js";
import { InvalidTargetError } from "../src/ports/messaging.js";

// ─── DiscordChannel ───────────────────────────────────────────────────────────

function makeOkFetch(status = 204): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    text: vi.fn().mockResolvedValue(""),
  });
}

function makeErrorFetch(status: number, body = "error"): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
  });
}

describe("DiscordChannel.sendAlert", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to the webhook URL", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendAlert("info", "Title", "Body text");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://discord.test/webhook");
  });

  it("sends embed with correct level color for 'info'", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendAlert("info", "My Title", "body");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0x3498db);
  });

  it("sends embed with correct level color for 'error'", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendAlert("error", "Error!", "details");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0xe74c3c);
  });

  it("sends embed with correct level color for 'critical'", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendAlert("critical", "CRITICAL", "details");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0xff0000);
  });

  it("embed title contains level and user title", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendAlert("warn", "Disk full", "body");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].title).toContain("WARN");
    expect(body.embeds[0].title).toContain("Disk full");
  });

  it("embed description matches body param", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendAlert("info", "t", "my body content");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].description).toBe("my body content");
  });

  it("throws on 429 rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await expect(ch.sendAlert("info", "t", "b")).rejects.toThrow("429");
  });

  it("throws on non-ok non-429 status", async () => {
    const fetchMock = makeErrorFetch(500, "Internal error");
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await expect(ch.sendAlert("info", "t", "b")).rejects.toThrow("500");
  });
});

describe("DiscordChannel.sendMessage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs content with [→ target] prefix", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await ch.sendMessage("ops-channel", "hello world");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("ops-channel");
    expect(body.content).toContain("hello world");
  });

  it("throws InvalidTargetError for empty target", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await expect(ch.sendMessage("", "text")).rejects.toThrow(InvalidTargetError);
  });

  it("throws InvalidTargetError for whitespace-only target", async () => {
    const fetchMock = makeOkFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ch = new DiscordChannel({
      webhookUrl: "https://discord.test/webhook",
    });
    await expect(ch.sendMessage("   ", "text")).rejects.toThrow(InvalidTargetError);
  });
});

// ─── logToBrain ───────────────────────────────────────────────────────────────

describe("logToBrain", () => {
  const entry = {
    title: "test entry",
    category: "decision",
    tags: ["test"],
    context: "ctx",
    decision_or_pattern: "the pattern",
    why_it_matters: "important",
  };

  it("returns void and does nothing when brain is null", () => {
    const result = logToBrain(null, entry);
    expect(result).toBeUndefined();
  });

  it("returns void and does nothing when brain is undefined", () => {
    const result = logToBrain(undefined, entry);
    expect(result).toBeUndefined();
  });

  it("calls archiveKnowledge with the entry when brain is provided", async () => {
    const archiveKnowledge = vi.fn().mockResolvedValue(undefined);
    const brain = { archiveKnowledge } as unknown as BrainPort;
    logToBrain(brain, entry);
    // give the fire-and-forget micro-task a tick to run
    await new Promise((r) => setTimeout(r, 0));
    expect(archiveKnowledge).toHaveBeenCalledWith(entry);
  });

  it("swallows archiveKnowledge rejection silently", async () => {
    const archiveKnowledge = vi.fn().mockRejectedValue(new Error("brain down"));
    const brain = { archiveKnowledge } as unknown as BrainPort;
    expect(() => logToBrain(brain, entry)).not.toThrow();
    // tick to let the rejection propagate and be swallowed
    await new Promise((r) => setTimeout(r, 0));
    expect(archiveKnowledge).toHaveBeenCalledOnce();
  });

  it("return type is void (not Promise)", () => {
    const archiveKnowledge = vi.fn().mockResolvedValue(undefined);
    const brain = { archiveKnowledge } as unknown as BrainPort;
    const result = logToBrain(brain, entry);
    // void — not a promise
    expect(result).toBeUndefined();
  });
});
