/**
 * rth-session — NYSE/CME Regular Trading Hours session guard.
 *
 * Active: Monday–Friday 09:30–16:00 America/New_York, excluding CME holidays.
 * CME 2026 holiday list is static JSON — update yearly (see CME calendar:
 * https://www.cmegroup.com/tools-information/holiday-calendar.html).
 *
 * Anti-pattern #5: session guard is consulted on every OODA cycle with the
 * cycle's `ctx.now` timestamp — no TTL, no caching.
 *
 * @public
 */

import type { SessionGuard } from "../types.js";

// Update yearly — see CME calendar: https://www.cmegroup.com/tools-information/holiday-calendar.html
const CME_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

// RTH window in Eastern Time: 09:30 – 16:00
const RTH_OPEN_MINUTES = 9 * 60 + 30; // 570
const RTH_CLOSE_MINUTES = 16 * 60; // 960

export interface RTHSessionOptions {
  /**
   * IANA timezone string for Eastern Time.
   * Override in tests only — production always uses 'America/New_York'.
   * @defaultValue 'America/New_York'
   */
  tz?: string;
}

/**
 * Returns a SessionGuard that is active during NYSE/CME Regular Trading Hours:
 * Monday–Friday 09:30–16:00 America/New_York, excluding CME 2026 holidays.
 */
export function rthSession(opts?: RTHSessionOptions): SessionGuard {
  const tz = opts?.tz ?? "America/New_York";

  return {
    name: "rth-session",

    async isActive(at: Date): Promise<boolean> {
      // Resolve date parts in Eastern Time using Intl.DateTimeFormat
      const parts = getDateParts(at, tz);

      // Weekend check (0=Sunday, 6=Saturday)
      if (parts.weekday === 0 || parts.weekday === 6) {
        return false;
      }

      // CME holiday check — ISO date string in ET
      const isoDate = formatISODate(parts);
      if (CME_HOLIDAYS_2026.has(isoDate)) {
        return false;
      }

      // RTH window check
      const minutesFromMidnight = parts.hour * 60 + parts.minute;
      return (
        minutesFromMidnight >= RTH_OPEN_MINUTES &&
        minutesFromMidnight < RTH_CLOSE_MINUTES
      );
    },
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

interface DateParts {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sunday, 6=Saturday
}

function getDateParts(at: Date, tz: string): DateParts {
  // Use Intl.DateTimeFormat to extract wall-clock components in the target tz.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = fmt.formatToParts(at);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  // Intl weekday "short" in en-US: Sun, Mon, Tue, Wed, Thu, Fri, Sat
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const hour = Number(get("hour")) % 24; // "24" → 0 in hour12=false edge case

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function formatISODate(parts: DateParts): string {
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}
