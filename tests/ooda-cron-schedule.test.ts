/**
 * Tests for packages/agent-sdk/src/orchestration/ooda/cron-schedule.ts
 *
 * Covers: cronSessionGuard construction, name, isActive matching via UTC fields.
 * All date assertions use explicit UTC timestamps to avoid TZ drift.
 */

import { describe, expect, it } from "vitest";
import { cronSessionGuard } from "../src/orchestration/ooda/cron-schedule.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a UTC Date from explicit components (month is 1-based). */
function utcDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

// Reference dates (UTC):
// Mon 2026-01-05 => getUTCDay() === 1
// Tue 2026-01-06 => getUTCDay() === 2
// Sat 2026-01-03 => getUTCDay() === 6
// Sun 2026-01-04 => getUTCDay() === 0
// Fri 2026-01-09 => getUTCDay() === 5

// ─── Construction & name ─────────────────────────────────────────────────────

describe("cronSessionGuard — construction", () => {
  it("returns a SessionGuard with the correct name", () => {
    const guard = cronSessionGuard("0 9 * * 1");
    expect(guard.name).toBe("cron:0 9 * * 1");
  });

  it("throws on a 6-field expression", () => {
    expect(() => cronSessionGuard("0 9 * * 1 2026")).toThrow(/Invalid cron expression/);
  });

  it("throws on a 3-field expression", () => {
    expect(() => cronSessionGuard("0 9 *")).toThrow(/Invalid cron expression/);
  });

  it("throws on a 4-field expression", () => {
    expect(() => cronSessionGuard("0 9 * *")).toThrow(/Invalid cron expression/);
  });

  it("throws an Error instance (not just any thrown value)", () => {
    expect(() => cronSessionGuard("bad")).toThrow(Error);
  });
});

// ─── Wildcard — every minute ──────────────────────────────────────────────

describe('cronSessionGuard("* * * * *") — every minute', () => {
  const guard = cronSessionGuard("* * * * *");

  it("is active at an arbitrary moment", async () => {
    const result = await guard.isActive(utcDate(2026, 1, 5, 9, 30));
    expect(result).toBe(true);
  });

  it("is active at midnight", async () => {
    expect(await guard.isActive(utcDate(2026, 3, 15, 0, 0))).toBe(true);
  });

  it("is active at end-of-day", async () => {
    expect(await guard.isActive(utcDate(2026, 12, 31, 23, 59))).toBe(true);
  });
});

// ─── Day-of-week — Monday 9:00 ───────────────────────────────────────────

describe('cronSessionGuard("0 9 * * 1") — Monday 9:00 UTC', () => {
  const guard = cronSessionGuard("0 9 * * 1");

  it("is active on Monday at 09:00", async () => {
    // Mon 2026-01-05
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 0))).toBe(true);
  });

  it("is NOT active on Tuesday at 09:00", async () => {
    // Tue 2026-01-06
    expect(await guard.isActive(utcDate(2026, 1, 6, 9, 0))).toBe(false);
  });

  it("is NOT active on Monday at 09:01", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 1))).toBe(false);
  });

  it("is NOT active on Monday at 08:00", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 8, 0))).toBe(false);
  });
});

// ─── Fixed time every day — 14:30 ────────────────────────────────────────

describe('cronSessionGuard("30 14 * * *") — every day 14:30 UTC', () => {
  const guard = cronSessionGuard("30 14 * * *");

  it("is active at 14:30 on any weekday", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 14, 30))).toBe(true);
  });

  it("is NOT active at 14:31", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 14, 31))).toBe(false);
  });

  it("is NOT active at 14:29", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 14, 29))).toBe(false);
  });
});

// ─── Business hours Mon-Fri 9-17 ─────────────────────────────────────────

describe('cronSessionGuard("0 9-17 * * 1-5") — business hours Mon-Fri', () => {
  const guard = cronSessionGuard("0 9-17 * * 1-5");

  it("is active on Monday at noon", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 12, 0))).toBe(true);
  });

  it("is active on Friday at 17:00", async () => {
    // Fri 2026-01-09
    expect(await guard.isActive(utcDate(2026, 1, 9, 17, 0))).toBe(true);
  });

  it("is NOT active on Saturday at noon", async () => {
    // Sat 2026-01-03
    expect(await guard.isActive(utcDate(2026, 1, 3, 12, 0))).toBe(false);
  });

  it("is NOT active on Monday at 08:00 (before window)", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 8, 0))).toBe(false);
  });

  it("is NOT active on Monday at 18:00 (after window)", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 18, 0))).toBe(false);
  });
});

// ─── Step — every 15 minutes ─────────────────────────────────────────────

describe('cronSessionGuard("*/15 * * * *") — every 15 minutes', () => {
  const guard = cronSessionGuard("*/15 * * * *");

  it("is active at :00", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 0))).toBe(true);
  });

  it("is active at :15", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 15))).toBe(true);
  });

  it("is active at :30", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 30))).toBe(true);
  });

  it("is active at :45", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 45))).toBe(true);
  });

  it("is NOT active at :01", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 1))).toBe(false);
  });

  it("is NOT active at :14", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 14))).toBe(false);
  });
});

// ─── Day-of-month — first of month midnight ──────────────────────────────

describe('cronSessionGuard("0 0 1 * *") — 1st of month at midnight UTC', () => {
  const guard = cronSessionGuard("0 0 1 * *");

  it("is active on Jan 1 at 00:00", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 1, 0, 0))).toBe(true);
  });

  it("is active on Feb 1 at 00:00", async () => {
    expect(await guard.isActive(utcDate(2026, 2, 1, 0, 0))).toBe(true);
  });

  it("is NOT active on Jan 2", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 2, 0, 0))).toBe(false);
  });

  it("is NOT active on Jan 1 at 00:01", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 1, 0, 1))).toBe(false);
  });
});

// ─── Day-of-week 0 — Sunday ───────────────────────────────────────────────

describe('cronSessionGuard("0 9 * * 0") — Sunday 9:00 UTC', () => {
  const guard = cronSessionGuard("0 9 * * 0");

  it("is active on Sunday at 09:00", async () => {
    // Sun 2026-01-04
    expect(await guard.isActive(utcDate(2026, 1, 4, 9, 0))).toBe(true);
  });

  it("is NOT active on Monday at 09:00", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 5, 9, 0))).toBe(false);
  });
});

// ─── List — 9:00 and 9:30 ────────────────────────────────────────────────

describe('cronSessionGuard("0,30 9 * * *") — 9:00 and 9:30', () => {
  const guard = cronSessionGuard("0,30 9 * * *");

  it("is active at 9:00", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 9, 0))).toBe(true);
  });

  it("is active at 9:30", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 9, 30))).toBe(true);
  });

  it("is NOT active at 9:01", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 9, 1))).toBe(false);
  });

  it("is NOT active at 9:15", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 7, 9, 15))).toBe(false);
  });
});

// ─── Range on minutes — 9:01 to 9:05 ────────────────────────────────────

describe('cronSessionGuard("1-5 9 * * *") — minutes 1-5 at hour 9', () => {
  const guard = cronSessionGuard("1-5 9 * * *");

  it("is active at 9:01", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 8, 9, 1))).toBe(true);
  });

  it("is active at 9:03", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 8, 9, 3))).toBe(true);
  });

  it("is active at 9:05", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 8, 9, 5))).toBe(true);
  });

  it("is NOT active at 9:00", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 8, 9, 0))).toBe(false);
  });

  it("is NOT active at 9:06", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 8, 9, 6))).toBe(false);
  });
});

// ─── Month filter — January only ─────────────────────────────────────────

describe('cronSessionGuard("0 9 * 1 *") — January only at 9:00', () => {
  const guard = cronSessionGuard("0 9 * 1 *");

  it("is active in January", async () => {
    expect(await guard.isActive(utcDate(2026, 1, 15, 9, 0))).toBe(true);
  });

  it("is NOT active in February", async () => {
    expect(await guard.isActive(utcDate(2026, 2, 15, 9, 0))).toBe(false);
  });

  it("is NOT active in December", async () => {
    expect(await guard.isActive(utcDate(2026, 12, 15, 9, 0))).toBe(false);
  });
});
