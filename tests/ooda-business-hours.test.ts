/**
 * Tests: businessHours session guard — extended coverage
 *
 * Complements ooda-guards-business-hours.test.ts by targeting:
 *   - Out-of-range validation (hours/minutes)
 *   - Edge-case day-of-week configs (Sunday-only, non-contiguous, empty)
 *   - Zero-length and single-minute windows
 *   - America/New_York timezone
 *   - Guard name when tz defaults to UTC
 *   - Promise<boolean> contract
 *   - Multiple independent guard instances
 *
 * Reference dates:
 *   2026-01-05 = Monday (CET UTC+1)
 *   2026-01-10 = Saturday
 *   2026-01-11 = Sunday
 *   2026-06-15 = Monday (CEST UTC+2, summer)
 */

import { describe, expect, it } from "vitest";
import { businessHours } from "../src/orchestration/ooda/guards/business-hours.js";

function utc(iso: string): Date {
  return new Date(iso);
}

describe("businessHours — extended coverage", () => {
  // ─── Validation: out-of-range values ──────────────────────────────────

  it("throws when windowStart hour > 23", () => {
    expect(() =>
      businessHours({
        daysOfWeek: [1],
        windowStart: "24:00",
        windowEnd: "18:00",
      }),
    ).toThrow();
  });

  it("throws when windowEnd minute > 59", () => {
    expect(() =>
      businessHours({
        daysOfWeek: [1],
        windowStart: "09:00",
        windowEnd: "18:60",
      }),
    ).toThrow();
  });

  it("throws when windowStart has no colon separator", () => {
    expect(() =>
      businessHours({
        daysOfWeek: [1],
        windowStart: "0900",
        windowEnd: "18:00",
      }),
    ).toThrow("windowStart");
  });

  it("throws when windowEnd is empty string", () => {
    expect(() =>
      businessHours({
        daysOfWeek: [1],
        windowStart: "09:00",
        windowEnd: "",
      }),
    ).toThrow("windowEnd");
  });

  // ─── Empty daysOfWeek → always inactive ───────────────────────────────

  it("empty daysOfWeek: never active on any day", async () => {
    const guard = businessHours({
      daysOfWeek: [],
      windowStart: "09:00",
      windowEnd: "18:00",
    });
    // Tuesday 14:00 UTC — would be in window if any day were allowed
    const at = utc("2026-01-06T14:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── Sunday-only configuration (ISO 7) ────────────────────────────────

  it("Sunday-only guard: Sunday 10:00 UTC → true", async () => {
    const guard = businessHours({
      daysOfWeek: [7],
      windowStart: "09:00",
      windowEnd: "12:00",
    });
    // 2026-01-11 Sunday 10:00 UTC
    const at = utc("2026-01-11T10:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("Sunday-only guard: Monday at same time → false", async () => {
    const guard = businessHours({
      daysOfWeek: [7],
      windowStart: "09:00",
      windowEnd: "12:00",
    });
    // 2026-01-05 Monday 10:00 UTC
    const at = utc("2026-01-05T10:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── Non-contiguous days (Mon + Wed + Fri) ─────────────────────────────

  it("Mon+Wed+Fri guard: Wednesday 14:00 UTC → true", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 3, 5],
      windowStart: "09:00",
      windowEnd: "18:00",
    });
    // 2026-01-07 Wednesday 14:00 UTC
    const at = utc("2026-01-07T14:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("Mon+Wed+Fri guard: Tuesday at same time → false", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 3, 5],
      windowStart: "09:00",
      windowEnd: "18:00",
    });
    // 2026-01-06 Tuesday 14:00 UTC
    const at = utc("2026-01-06T14:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── Zero-length window (windowStart === windowEnd) ────────────────────

  it("zero-length window (start === end): always inactive", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "09:00",
    });
    // At exactly 09:00 — start is inclusive but end is exclusive, so [09:00, 09:00) is empty
    const at = utc("2026-01-05T09:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── Single-minute window ─────────────────────────────────────────────

  it("single-minute window [09:00, 09:01): 09:00 → true", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "09:01",
    });
    const at = utc("2026-01-05T09:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("single-minute window [09:00, 09:01): 09:01 → false", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "09:01",
    });
    const at = utc("2026-01-05T09:01:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── America/New_York timezone ─────────────────────────────────────────

  it("NY guard (EST UTC-5): Tuesday 14:00 EST → true", async () => {
    const guard = businessHours({
      tz: "America/New_York",
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    // 2026-01-06 Tuesday; 14:00 EST = 19:00 UTC
    const at = utc("2026-01-06T19:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("NY guard (EST UTC-5): Tuesday 17:00 EST (exclusive end) → false", async () => {
    const guard = businessHours({
      tz: "America/New_York",
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    // 17:00 EST = 22:00 UTC
    const at = utc("2026-01-06T22:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── Guard name when tz defaults to UTC ───────────────────────────────

  it("guard name contains 'UTC' when tz not specified", () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    expect(guard.name).toContain("UTC");
  });

  // ─── isActive returns a genuine Promise ───────────────────────────────

  it("isActive returns a Promise (thenable)", () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    const result = guard.isActive(new Date("2026-01-05T10:00:00Z"));
    expect(result).toBeInstanceOf(Promise);
  });

  // ─── Multiple independent guards don't share state ────────────────────

  it("two guards with different windows are independent", async () => {
    const morningGuard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "08:00",
      windowEnd: "12:00",
    });
    const afternoonGuard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "13:00",
      windowEnd: "17:00",
    });
    // Monday 10:00 UTC: morning active, afternoon not
    const morning = utc("2026-01-05T10:00:00Z");
    expect(await morningGuard.isActive(morning)).toBe(true);
    expect(await afternoonGuard.isActive(morning)).toBe(false);

    // Monday 14:00 UTC: afternoon active, morning not
    const afternoon = utc("2026-01-05T14:00:00Z");
    expect(await morningGuard.isActive(afternoon)).toBe(false);
    expect(await afternoonGuard.isActive(afternoon)).toBe(true);
  });

  // ─── Late-night / near-midnight window ────────────────────────────────

  it("late-night window [22:00, 23:59): 23:00 UTC Tuesday → true", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      windowStart: "22:00",
      windowEnd: "23:59",
    });
    const at = utc("2026-01-06T23:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("late-night window [22:00, 23:59): 21:59 UTC → false", async () => {
    const guard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      windowStart: "22:00",
      windowEnd: "23:59",
    });
    const at = utc("2026-01-06T21:59:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── guard.name format ────────────────────────────────────────────────

  it("guard name encodes the full window in 'business-hours:tz:start-end' format", () => {
    const guard = businessHours({
      tz: "America/New_York",
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    expect(guard.name).toBe("business-hours:America/New_York:09:00-17:00");
  });
});
