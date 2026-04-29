import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  calendarCheck,
  _resetCalendarCache,
} from "../src/skills/calendar-check.js";
import { makeCtx } from "./skills-helpers.js";

let tmpDir: string;

describe("skill calendar_check", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cal-"));
    _resetCalendarCache();
  });
  afterEach(() => {
    _resetCalendarCache();
    delete process.env.CME_HOLIDAYS_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects bad date via Zod", () => {
    expect(() =>
      calendarCheck.inputSchema.parse({ date: "2026/04/28" }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no fs read", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await calendarCheck.execute(
      { date: "2026-12-25", market: "CME" },
      ctx,
    );
    expect(out.is_holiday).toBe(false);
    expect(out.is_rth).toBe(false);
  });

  it("identifies weekend correctly", async () => {
    const ctx = makeCtx({ isReplay: false });
    // 2026-04-26 is a Sunday
    const out = await calendarCheck.execute(
      { date: "2026-04-26", market: "CME" },
      ctx,
    );
    expect(out.is_weekend).toBe(true);
    expect(out.is_rth).toBe(false);
  });

  it("identifies a CME holiday from the JSON", async () => {
    const path = join(tmpDir, "cme.json");
    writeFileSync(
      path,
      JSON.stringify([
        { date: "2026-12-25", name: "Christmas", market: ["CME", "NYSE"] },
      ]),
    );
    process.env.CME_HOLIDAYS_PATH = path;
    const ctx = makeCtx({ isReplay: false });
    const out = await calendarCheck.execute(
      { date: "2026-12-25", market: "CME" },
      ctx,
    );
    expect(out.is_holiday).toBe(true);
    expect(out.holiday_name).toBe("Christmas");
    expect(out.is_rth).toBe(false);
  });
});
