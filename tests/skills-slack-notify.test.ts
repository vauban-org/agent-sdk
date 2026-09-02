import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { SkillExecutionError, SkillNotConfiguredError } from "../src/skills/errors.js";
import { slackNotify } from "../src/skills/slack-notify.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill slack_notify", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.SLACK_BOT_TOKEN = "xoxb-1";
  });
  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
  });

  it("requires channel or binding_user_id", () => {
    expect(() => slackNotify.inputSchema.parse({ text: "x" })).toThrow(ZodError);
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await slackNotify.execute({ text: "hi", channel: "#ops" }, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.delivered).toBe(false);
  });

  it("isReplay=false → calls postMessage", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 }),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await slackNotify.execute({ text: "hi", channel: "#ops" }, ctx);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.ts).toBe("1.2");
  });

  it("throws when token missing", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const ctx = makeCtx({ isReplay: false });
    await expect(slackNotify.execute({ text: "hi", channel: "#ops" }, ctx)).rejects.toBeInstanceOf(
      SkillNotConfiguredError,
    );
  });

  it("uses dryRunMock when provided in replay mode", async () => {
    const mockResult = { delivered: true, ts: "mock-ts" };
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: { slack_notify: () => mockResult },
    });
    const out = await slackNotify.execute({ text: "hi", channel: "#ops" }, ctx);
    expect(out.ts).toBe("mock-ts");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws SkillExecutionError when Slack returns ok:false", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
      }),
    );
    const ctx = makeCtx({ isReplay: false });
    await expect(
      slackNotify.execute({ text: "hi", channel: "#nonexistent" }, ctx),
    ).rejects.toBeInstanceOf(SkillExecutionError);
  });

  it("throws SkillExecutionError when no slack binding found for user", async () => {
    const ctx = makeCtx({ isReplay: false, rows: [] });
    await expect(
      slackNotify.execute({ text: "hi", binding_user_id: "user-xyz" }, ctx),
    ).rejects.toBeInstanceOf(SkillExecutionError);
  });

  it("accepts channel with blocks", () => {
    expect(() =>
      slackNotify.inputSchema.parse({
        text: "Alert!",
        channel: "#alerts",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hi*" } }],
      }),
    ).not.toThrow();
  });
});
