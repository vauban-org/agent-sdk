import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { sendEmail } from "../src/skills/send-email.js";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("skill send_email", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "noreply@vauban.tech";
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.SMTP_URL;
  });

  it("rejects bad email via Zod", () => {
    expect(() =>
      sendEmail.inputSchema.parse({
        to: "not-an-email",
        subject: "x",
        text: "x",
      }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no network call", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await sendEmail.execute(
      { to: "u@v.io", subject: "hi", text: "body" },
      ctx,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.provider).toBe("replay");
  });

  it("isReplay=false → calls Resend API", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }),
    );
    const ctx = makeCtx({ isReplay: false });
    const out = await sendEmail.execute(
      { to: "u@v.io", subject: "hi", text: "body" },
      ctx,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.provider).toBe("resend");
    expect(out.message_id).toBe("msg_123");
  });

  it("throws when no provider configured", async () => {
    delete process.env.RESEND_API_KEY;
    const ctx = makeCtx({ isReplay: false });
    await expect(
      sendEmail.execute({ to: "u@v.io", subject: "x", text: "y" }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
  });
});
