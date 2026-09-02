import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { SkillExecutionError, SkillNotConfiguredError } from "../src/skills/errors.js";
import { telegramNotify } from "../src/skills/telegram-notify.js";
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
    expect(() => telegramNotify.inputSchema.parse({ text: "hi" })).toThrow(ZodError);
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
    await expect(telegramNotify.execute({ text: "hi", chat_id: "1" }, ctx)).rejects.toBeInstanceOf(
      SkillNotConfiguredError,
    );
  });

  it("uses dryRunMock when provided in replay mode", async () => {
    const mockResult = { delivered: true, message_id: 99 };
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: { telegram_notify: () => mockResult },
    });
    const out = await telegramNotify.execute({ text: "hi", chat_id: "1" }, ctx);
    expect(out.message_id).toBe(99);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws SkillExecutionError when API returns non-retryable 4xx", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "bad request" }), {
        status: 400,
      }),
    );
    const ctx = makeCtx({ isReplay: false });
    await expect(telegramNotify.execute({ text: "hi", chat_id: "1" }, ctx)).rejects.toBeInstanceOf(
      SkillExecutionError,
    );
  });

  it("throws SkillExecutionError when no telegram binding found for user", async () => {
    const ctx = makeCtx({ isReplay: false, rows: [] });
    const VALID_UUID = "11111111-1111-4111-9111-111111111111";
    await expect(
      telegramNotify.execute({ text: "hi", binding_user_id: VALID_UUID }, ctx),
    ).rejects.toBeInstanceOf(SkillExecutionError);
  });

  it("accepts parse_mode field in schema", () => {
    expect(() =>
      telegramNotify.inputSchema.parse({
        text: "**bold**",
        chat_id: "123",
        parse_mode: "MarkdownV2",
      }),
    ).not.toThrow();
  });
});
