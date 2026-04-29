import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { telegramNotify } from "../src/skills/telegram-notify.js";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill telegram_notify", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.TELEGRAM_BOT_TOKEN = "tok";
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("requires chat_id or binding_user_id (Zod refine)", () => {
    expect(() =>
      telegramNotify.inputSchema.parse({ text: "hi" }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await telegramNotify.execute({ text: "hi", chat_id: "1" }, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.delivered).toBe(false);
  });

  it("isReplay=false → calls bot API", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
      }),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await telegramNotify.execute({ text: "hi", chat_id: "1" }, ctx);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.delivered).toBe(true);
    expect(out.message_id).toBe(42);
  });

  it("throws when token missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const ctx = makeCtx({ isReplay: false });
    await expect(
      telegramNotify.execute({ text: "hi", chat_id: "1" }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
  });
});
