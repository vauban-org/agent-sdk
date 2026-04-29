/**
 * Tests: RTH session guard (sprint-525:quick-3)
 *
 * All timestamps are provided as UTC Date objects; the guard converts
 * them to America/New_York via Intl.DateTimeFormat internally.
 *
 * 2026 ET offsets:
 *   - EDT (summer): UTC-4  (Mar 8 → Nov 1)
 *   - EST (winter): UTC-5  (Nov 1 → Mar 8)
 */

import { describe, it, expect } from "vitest";
import { rthSession } from "../src/orchestration/ooda/guards/rth-session.js";

describe("rthSession", () => {
  const guard = rthSession();

  // Helper: build UTC Date from a readable string
  function utc(iso: string): Date {
    return new Date(iso);
  }

  // ─── Weekend checks ──────────────────────────────────────────────────

  it("Saturday 14:00 ET → false (weekend)", async () => {
    // 2026-01-03 is a Saturday.
    // 14:00 ET (EST, UTC-5) = 19:00 UTC
    const at = utc("2026-01-03T19:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  it("Sunday 11:00 ET → false (weekend)", async () => {
    // 2026-01-04 is a Sunday.
    const at = utc("2026-01-04T16:00:00Z"); // 11:00 EST
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── Normal RTH weekday ──────────────────────────────────────────────

  it("Monday 14:00 ET → true (RTH 09:30–16:00)", async () => {
    // 2026-01-05 is a Monday.
    // 14:00 EST = 19:00 UTC
    const at = utc("2026-01-05T19:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("Monday 09:30 ET (market open) → true", async () => {
    // 09:30 EST = 14:30 UTC
    const at = utc("2026-01-05T14:30:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  it("Monday 23:00 ET → false (after close)", async () => {
    // 23:00 EST = 04:00 UTC next day
    const at = utc("2026-01-06T04:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  it("Monday 09:29 ET → false (before open)", async () => {
    // 09:29 EST = 14:29 UTC
    const at = utc("2026-01-05T14:29:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  it("Monday 16:00 ET → false (close is exclusive)", async () => {
    // 16:00 EST = 21:00 UTC
    const at = utc("2026-01-05T21:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  // ─── CME holiday checks ───────────────────────────────────────────────

  it("Christmas 2026-12-25 14:00 ET → false (CME holiday)", async () => {
    // 2026-12-25 is a Friday.
    // 14:00 EST = 19:00 UTC
    const at = utc("2026-12-25T19:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  it("New Year 2026-01-01 (Thursday) 14:00 ET → false (CME holiday)", async () => {
    // 14:00 EST = 19:00 UTC
    const at = utc("2026-01-01T19:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  it("Good Friday 2026-04-03 14:00 ET → false (CME holiday)", async () => {
    // 14:00 EDT (UTC-4) = 18:00 UTC
    const at = utc("2026-04-03T18:00:00Z");
    expect(await guard.isActive(at)).toBe(false);
  });

  it("2026-04-06 (Monday after Good Friday) 14:00 ET → true (not a holiday)", async () => {
    // 14:00 EDT = 18:00 UTC
    const at = utc("2026-04-06T18:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  // ─── DST boundary ────────────────────────────────────────────────────

  it("2026-03-09 (Mon, after DST spring-forward) 14:00 ET → true (EDT=UTC-4)", async () => {
    // DST started 2026-03-08. 14:00 EDT = 18:00 UTC
    const at = utc("2026-03-09T18:00:00Z");
    expect(await guard.isActive(at)).toBe(true);
  });

  // ─── Named guard ─────────────────────────────────────────────────────

  it("guard name is 'rth-session'", () => {
    expect(guard.name).toBe("rth-session");
  });
});
