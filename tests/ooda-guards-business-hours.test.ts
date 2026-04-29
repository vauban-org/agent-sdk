/**
 * Tests: businessHours session guard (sprint-525:quick-3)
 *
 * Tests tz handling (UTC input → Paris timezone), day-of-week gating,
 * and window boundaries.
 *
 * Paris offsets for 2026:
 *   - CET  (winter): UTC+1  (through Mar 29)
 *   - CEST (summer): UTC+2  (Mar 29 → Oct 25)
 */

import { describe, it, expect } from "vitest";
import { businessHours } from "../src/orchestration/ooda/guards/business-hours.js";

describe("businessHours", () => {
  // Standard Mon–Fri 09:00–18:00 Europe/Paris guard
  const parisGuard = businessHours({
    tz: "Europe/Paris",
    daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
    windowStart: "09:00",
    windowEnd: "18:00",
  });

  // Helper
  function utc(iso: string): Date {
    return new Date(iso);
  }

  // ─── In-window weekday ───────────────────────────────────────────────

  it("Tuesday 14:00 Paris (CET=UTC+1) → true", async () => {
    // 2026-01-06 is a Tuesday (winter, CET UTC+1).
    // 14:00 CET = 13:00 UTC
    const at = utc("2026-01-06T13:00:00Z");
    expect(await parisGuard.isActive(at)).toBe(true);
  });

  it("window start 09:00 Paris (inclusive) → true", async () => {
    // 2026-01-05 Monday, 09:00 CET = 08:00 UTC
    const at = utc("2026-01-05T08:00:00Z");
    expect(await parisGuard.isActive(at)).toBe(true);
  });

  it("window end 18:00 Paris (exclusive) → false", async () => {
    // 2026-01-05 Monday, 18:00 CET = 17:00 UTC
    const at = utc("2026-01-05T17:00:00Z");
    expect(await parisGuard.isActive(at)).toBe(false);
  });

  it("just before window: 08:59 Paris → false", async () => {
    // 08:59 CET = 07:59 UTC
    const at = utc("2026-01-05T07:59:00Z");
    expect(await parisGuard.isActive(at)).toBe(false);
  });

  // ─── Weekend checks ───────────────────────────────────────────────────

  it("Saturday 14:00 Paris → false", async () => {
    // 2026-01-03 Saturday, 14:00 CET = 13:00 UTC
    const at = utc("2026-01-03T13:00:00Z");
    expect(await parisGuard.isActive(at)).toBe(false);
  });

  it("Sunday 10:00 Paris → false", async () => {
    // 2026-01-04 Sunday
    const at = utc("2026-01-04T09:00:00Z"); // 10:00 CET
    expect(await parisGuard.isActive(at)).toBe(false);
  });

  // ─── Outside window ───────────────────────────────────────────────────

  it("Tuesday 22:00 Paris (outside 09-18) → false", async () => {
    // 2026-01-06 Tuesday, 22:00 CET = 21:00 UTC
    const at = utc("2026-01-06T21:00:00Z");
    expect(await parisGuard.isActive(at)).toBe(false);
  });

  it("Tuesday 07:00 Paris (before 09:00) → false", async () => {
    // 07:00 CET = 06:00 UTC
    const at = utc("2026-01-06T06:00:00Z");
    expect(await parisGuard.isActive(at)).toBe(false);
  });

  // ─── Timezone handling: UTC input → correct Paris wall clock ─────────

  it("UTC input converted to Paris time correctly (CEST summer)", async () => {
    // 2026-06-09 Tuesday summer (CEST UTC+2)
    // 14:00 CEST = 12:00 UTC → should be in window
    const inWindow = utc("2026-06-09T12:00:00Z");
    expect(await parisGuard.isActive(inWindow)).toBe(true);

    // 17:59 CEST = 15:59 UTC → still in window
    const nearClose = utc("2026-06-09T15:59:00Z");
    expect(await parisGuard.isActive(nearClose)).toBe(true);

    // 18:00 CEST = 16:00 UTC → closed (exclusive end)
    const atClose = utc("2026-06-09T16:00:00Z");
    expect(await parisGuard.isActive(atClose)).toBe(false);
  });

  // ─── UTC guard (default tz) ───────────────────────────────────────────

  it("UTC guard: Tuesday 14:00 UTC → true", async () => {
    const utcGuard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "18:00",
    });
    // 2026-01-06 Tuesday 14:00 UTC
    const at = utc("2026-01-06T14:00:00Z");
    expect(await utcGuard.isActive(at)).toBe(true);
  });

  it("UTC guard: Tuesday 19:00 UTC → false (outside window)", async () => {
    const utcGuard = businessHours({
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "18:00",
    });
    const at = utc("2026-01-06T19:00:00Z");
    expect(await utcGuard.isActive(at)).toBe(false);
  });

  // ─── Custom narrow window (dreams agent: 02:00–05:00 UTC) ────────────

  it("dreams agent (02:00–05:00 UTC Mon-Sun): 03:00 UTC Sat → true", async () => {
    const dreamsGuard = businessHours({
      tz: "UTC",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7], // all days
      windowStart: "02:00",
      windowEnd: "05:00",
    });
    // 2026-01-03 Saturday 03:00 UTC
    const at = utc("2026-01-03T03:00:00Z");
    expect(await dreamsGuard.isActive(at)).toBe(true);
  });

  it("dreams agent: 05:00 UTC (exclusive end) → false", async () => {
    const dreamsGuard = businessHours({
      tz: "UTC",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      windowStart: "02:00",
      windowEnd: "05:00",
    });
    const at = utc("2026-01-03T05:00:00Z");
    expect(await dreamsGuard.isActive(at)).toBe(false);
  });

  // ─── Guard name ───────────────────────────────────────────────────────

  it("guard name encodes tz and window", () => {
    const guard = businessHours({
      tz: "Europe/Paris",
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: "09:00",
      windowEnd: "18:00",
    });
    expect(guard.name).toContain("Europe/Paris");
    expect(guard.name).toContain("09:00");
    expect(guard.name).toContain("18:00");
  });

  // ─── Validation ───────────────────────────────────────────────────────

  it("throws on invalid windowStart format", () => {
    expect(() =>
      businessHours({
        daysOfWeek: [1],
        windowStart: "9am",
        windowEnd: "18:00",
      }),
    ).toThrow("windowStart");
  });

  it("throws on invalid windowEnd format", () => {
    expect(() =>
      businessHours({
        daysOfWeek: [1],
        windowStart: "09:00",
        windowEnd: "6pm",
      }),
    ).toThrow("windowEnd");
  });
});
