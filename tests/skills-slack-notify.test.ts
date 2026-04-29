import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { slackNotify } from "../src/skills/slack-notify.js";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
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
    expect(() => slackNotify.inputSchema.parse({ text: "x" })).toThrow(
      ZodError,
    );
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
    await expect(
      slackNotify.execute({ text: "hi", channel: "#ops" }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
  });
});
