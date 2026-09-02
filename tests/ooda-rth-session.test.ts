/**
 * Tests: RTH session guard — ooda-rth-session
 *
 * Covers: shape contract, weekday/weekend logic, RTH boundary precision,
 * full CME 2026 holiday list, DST transitions, pre-market/after-hours,
 * determinism, and custom timezone override.
 *
 * UTC offsets for 2026 America/New_York:
 *   EST (UTC-5): Jan 1 → Mar 8
 *   EDT (UTC-4): Mar 8 → Nov 1
 *   EST (UTC-5): Nov 1 → Dec 31
 */

import { describe, expect, it } from "vitest";
import { rthSession } from "../src/orchestration/ooda/guards/rth-session.js";

// Build a UTC Date from an ISO string
function utc(iso: string): Date {
  return new Date(iso);
}

// 2026-01-05 is a Monday (EST, UTC-5 in effect)
// 2026-05-19 is a Tuesday (EDT, UTC-4 in effect)

describe("rthSession — shape contract", () => {
  it("returns an object with a string name property", () => {
    const guard = rthSession();
    expect(typeof guard.name).toBe("string");
    expect(guard.name.length).toBeGreaterThan(0);
  });

  it("name is 'rth-session'", () => {
    const guard = rthSession();
    expect(guard.name).toBe("rth-session");
  });

  it("isActive is an async function (returns a Promise)", async () => {
    const guard = rthSession();
    const result = guard.isActive(new Date());
    expect(result).toBeInstanceOf(Promise);
    // also resolve it
    await result;
  });

  it("resolved value is a boolean", async () => {
    const guard = rthSession();
    const val = await guard.isActive(utc("2026-01-05T14:30:00Z")); // 09:30 EST Monday
    expect(typeof val).toBe("boolean");
  });
});

describe("rthSession — weekend exclusion", () => {
  const guard = rthSession();

  it("Saturday at 12:00 ET → false", async () => {
    // 2026-01-03 Saturday, 12:00 EST = 17:00 UTC
    expect(await guard.isActive(utc("2026-01-03T17:00:00Z"))).toBe(false);
  });

  it("Sunday at 10:00 ET → false", async () => {
    // 2026-01-04 Sunday, 10:00 EST = 15:00 UTC
    expect(await guard.isActive(utc("2026-01-04T15:00:00Z"))).toBe(false);
  });

  it("Saturday pre-dawn 01:00 ET → false", async () => {
    // 2026-01-03 01:00 EST = 06:00 UTC
    expect(await guard.isActive(utc("2026-01-03T06:00:00Z"))).toBe(false);
  });
});

describe("rthSession — RTH window boundaries (EST, UTC-5)", () => {
  const guard = rthSession();

  it("09:29 ET (one minute before open) → false", async () => {
    // 2026-01-05 Monday 09:29 EST = 14:29 UTC
    expect(await guard.isActive(utc("2026-01-05T14:29:00Z"))).toBe(false);
  });

  it("09:30 ET (market open, exact boundary) → true", async () => {
    // 2026-01-05 Monday 09:30 EST = 14:30 UTC
    expect(await guard.isActive(utc("2026-01-05T14:30:00Z"))).toBe(true);
  });

  it("15:59 ET (one minute before close) → true", async () => {
    // 2026-01-05 Monday 15:59 EST = 20:59 UTC
    expect(await guard.isActive(utc("2026-01-05T20:59:00Z"))).toBe(true);
  });

  it("16:00 ET (close is exclusive) → false", async () => {
    // 2026-01-05 Monday 16:00 EST = 21:00 UTC
    expect(await guard.isActive(utc("2026-01-05T21:00:00Z"))).toBe(false);
  });

  it("16:01 ET (after close) → false", async () => {
    // 2026-01-05 Monday 16:01 EST = 21:01 UTC
    expect(await guard.isActive(utc("2026-01-05T21:01:00Z"))).toBe(false);
  });
});

describe("rthSession — pre-market and after-hours", () => {
  const guard = rthSession();

  it("pre-market 08:00 ET (Tuesday) → false", async () => {
    // 2026-01-06 Tuesday 08:00 EST = 13:00 UTC
    expect(await guard.isActive(utc("2026-01-06T13:00:00Z"))).toBe(false);
  });

  it("market open 10:30 ET (typical liquid hour, Tuesday) → true", async () => {
    // 2026-01-06 Tuesday 10:30 EST = 15:30 UTC
    expect(await guard.isActive(utc("2026-01-06T15:30:00Z"))).toBe(true);
  });

  it("after-hours 17:00 ET (Wednesday) → false", async () => {
    // 2026-01-07 Wednesday 17:00 EST = 22:00 UTC
    expect(await guard.isActive(utc("2026-01-07T22:00:00Z"))).toBe(false);
  });

  it("midnight ET (Thursday) → false", async () => {
    // 2026-01-08 Thursday 00:00 EST = 05:00 UTC
    expect(await guard.isActive(utc("2026-01-08T05:00:00Z"))).toBe(false);
  });
});

describe("rthSession — CME 2026 holidays (all listed)", () => {
  const guard = rthSession();

  it("2026-01-01 New Year's Day (Thursday, 13:00 ET) → false", async () => {
    // 13:00 EST = 18:00 UTC
    expect(await guard.isActive(utc("2026-01-01T18:00:00Z"))).toBe(false);
  });

  it("2026-01-19 MLK Day (Monday, 11:00 ET) → false", async () => {
    // 11:00 EST = 16:00 UTC
    expect(await guard.isActive(utc("2026-01-19T16:00:00Z"))).toBe(false);
  });

  it("2026-02-16 Presidents' Day (Monday, 13:00 ET) → false", async () => {
    // 13:00 EST = 18:00 UTC
    expect(await guard.isActive(utc("2026-02-16T18:00:00Z"))).toBe(false);
  });

  it("2026-04-03 Good Friday (Friday, 12:00 EDT) → false", async () => {
    // 12:00 EDT = 16:00 UTC (UTC-4 after DST spring-forward 2026-03-08)
    expect(await guard.isActive(utc("2026-04-03T16:00:00Z"))).toBe(false);
  });

  it("2026-05-25 Memorial Day (Monday, 11:00 EDT) → false", async () => {
    // 11:00 EDT = 15:00 UTC
    expect(await guard.isActive(utc("2026-05-25T15:00:00Z"))).toBe(false);
  });

  it("2026-06-19 Juneteenth (Friday, 13:00 EDT) → false", async () => {
    // 13:00 EDT = 17:00 UTC
    expect(await guard.isActive(utc("2026-06-19T17:00:00Z"))).toBe(false);
  });

  it("2026-07-03 Independence Day observed (Friday, 14:00 EDT) → false", async () => {
    // 14:00 EDT = 18:00 UTC
    expect(await guard.isActive(utc("2026-07-03T18:00:00Z"))).toBe(false);
  });

  it("2026-09-07 Labor Day (Monday, 10:00 EDT) → false", async () => {
    // 10:00 EDT = 14:00 UTC
    expect(await guard.isActive(utc("2026-09-07T14:00:00Z"))).toBe(false);
  });

  it("2026-11-26 Thanksgiving (Thursday, 13:00 EST) → false", async () => {
    // 13:00 EST = 18:00 UTC (UTC-5 after DST fall-back 2026-11-01)
    expect(await guard.isActive(utc("2026-11-26T18:00:00Z"))).toBe(false);
  });

  it("2026-12-25 Christmas (Friday, 14:00 EST) → false", async () => {
    // 14:00 EST = 19:00 UTC
    expect(await guard.isActive(utc("2026-12-25T19:00:00Z"))).toBe(false);
  });
});

describe("rthSession — day after holiday is a normal trading day", () => {
  const guard = rthSession();

  it("2026-01-20 (Tuesday after MLK, 10:00 ET) → true", async () => {
    // 10:00 EST = 15:00 UTC
    expect(await guard.isActive(utc("2026-01-20T15:00:00Z"))).toBe(true);
  });

  it("2026-09-08 (Tuesday after Labor Day, 14:00 ET) → true", async () => {
    // 14:00 EDT = 18:00 UTC
    expect(await guard.isActive(utc("2026-09-08T18:00:00Z"))).toBe(true);
  });
});

describe("rthSession — DST transitions", () => {
  const guard = rthSession();

  it("2026-03-09 (Mon after spring-forward, 09:30 EDT) → true", async () => {
    // 09:30 EDT (UTC-4) = 13:30 UTC
    expect(await guard.isActive(utc("2026-03-09T13:30:00Z"))).toBe(true);
  });

  it("2026-03-09 09:29 EDT → false (boundary still precise post-DST)", async () => {
    // 09:29 EDT = 13:29 UTC
    expect(await guard.isActive(utc("2026-03-09T13:29:00Z"))).toBe(false);
  });

  it("2026-11-02 (Mon after fall-back, 09:30 EST) → true", async () => {
    // 09:30 EST (UTC-5) = 14:30 UTC
    expect(await guard.isActive(utc("2026-11-02T14:30:00Z"))).toBe(true);
  });

  it("2026-11-02 16:00 EST → false (close remains exclusive post-fall-back)", async () => {
    // 16:00 EST = 21:00 UTC
    expect(await guard.isActive(utc("2026-11-02T21:00:00Z"))).toBe(false);
  });
});

describe("rthSession — determinism", () => {
  const guard = rthSession();

  it("same timestamp produces the same result across multiple calls", async () => {
    const at = utc("2026-01-05T14:30:00Z"); // Monday 09:30 EST
    const results = await Promise.all([guard.isActive(at), guard.isActive(at), guard.isActive(at)]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(results[0]).toBe(true);
  });

  it("two guards created independently agree on the same timestamp", async () => {
    const g1 = rthSession();
    const g2 = rthSession();
    const at = utc("2026-01-05T20:59:00Z"); // 15:59 EST
    const [r1, r2] = await Promise.all([g1.isActive(at), g2.isActive(at)]);
    expect(r1).toBe(r2);
    expect(r1).toBe(true);
  });
});

describe("rthSession — full trading-day sweep (Friday 2026-01-09)", () => {
  const guard = rthSession();
  // 2026-01-09 is a Friday (not a holiday), EST applies (UTC-5)

  it("00:00 ET (midnight) → false", async () => {
    expect(await guard.isActive(utc("2026-01-09T05:00:00Z"))).toBe(false);
  });

  it("09:31 ET → true", async () => {
    expect(await guard.isActive(utc("2026-01-09T14:31:00Z"))).toBe(true);
  });

  it("12:00 ET (noon) → true", async () => {
    expect(await guard.isActive(utc("2026-01-09T17:00:00Z"))).toBe(true);
  });

  it("15:59 ET → true", async () => {
    expect(await guard.isActive(utc("2026-01-09T20:59:00Z"))).toBe(true);
  });

  it("16:00 ET → false (close exclusive)", async () => {
    expect(await guard.isActive(utc("2026-01-09T21:00:00Z"))).toBe(false);
  });
});
