/**
 * calendar_check — RTH / CME holiday calendar lookup.
 *
 * Reuses cme-holidays-2026.json packaged from quick-3 (resolved at runtime
 * from process.env.CME_HOLIDAYS_PATH or default path under config/).
 * Pure function — no I/O when isReplay, and idempotent at runtime since
 * holidays are static yearly data.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
    market: z.enum(["NYSE", "CME", "NASDAQ"]).default("CME"),
  })
  .strict();
type CalendarCheckInput = z.infer<typeof inputSchema>;

export interface CalendarCheckOutput {
  date: string;
  market: "NYSE" | "CME" | "NASDAQ";
  /** Standard regular trading hours session (true = market open, false = closed/holiday/weekend). */
  is_rth: boolean;
  is_holiday: boolean;
  is_weekend: boolean;
  holiday_name: string | null;
}

interface HolidayRecord {
  date: string;
  name: string;
  market?: string[];
}

let CACHED_HOLIDAYS: HolidayRecord[] | null = null;

async function loadHolidays(): Promise<HolidayRecord[]> {
  if (CACHED_HOLIDAYS) return CACHED_HOLIDAYS;
  const path = process.env.CME_HOLIDAYS_PATH;
  if (!path) {
    // Empty list ⇒ behaves as if no holidays defined; weekend/RTH still computed.
    CACHED_HOLIDAYS = [];
    return CACHED_HOLIDAYS;
  }
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as
      | HolidayRecord[]
      | { holidays?: HolidayRecord[] };
    CACHED_HOLIDAYS = Array.isArray(parsed)
      ? parsed
      : (parsed.holidays ?? []);
    return CACHED_HOLIDAYS;
  } catch (err) {
    throw new SkillExecutionError("calendar_check", "could not load holidays", {
      cause: err,
    });
  }
}

/** Test helper. */
export function _resetCalendarCache(): void {
  CACHED_HOLIDAYS = null;
}

export const calendarCheck: Skill<CalendarCheckInput, CalendarCheckOutput> = {
  name: "calendar_check",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<CalendarCheckOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["calendar_check"];
      if (mock) return mock(input) as CalendarCheckOutput;
      return {
        date: input.date,
        market: input.market,
        is_rth: false,
        is_holiday: false,
        is_weekend: false,
        holiday_name: null,
      };
    }
    return withSkillSpan("calendar_check", async () => {
      const holidays = await loadHolidays();
      const dt = new Date(`${input.date}T12:00:00Z`);
      const dow = dt.getUTCDay(); // 0=Sun, 6=Sat
      const isWeekend = dow === 0 || dow === 6;
      const match = holidays.find(
        (h) =>
          h.date === input.date &&
          (h.market === undefined || h.market.includes(input.market)),
      );
      const isHoliday = match != null;
      return {
        date: input.date,
        market: input.market,
        is_rth: !isWeekend && !isHoliday,
        is_holiday: isHoliday,
        is_weekend: isWeekend,
        holiday_name: match?.name ?? null,
      };
    });
  },
};
