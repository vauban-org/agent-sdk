/**
 * business-hours — configurable time-window session guard.
 *
 * For non-trading agents that run within a defined business window:
 *   - dreams agent: 02:00–05:00 UTC daily
 *   - narrator agent: 08:00–09:00 UTC Mon–Fri
 *   - Any ops agent bounded by a regional work schedule
 *
 * Anti-pattern #5: guard is consulted on every OODA cycle — no caching.
 *
 * @public
 */

import type { SessionGuard } from "../types.js";

export interface BusinessHoursOptions {
  /**
   * IANA timezone string (e.g. 'Europe/Paris', 'UTC', 'America/New_York').
   * @defaultValue 'UTC'
   */
  tz?: string;

  /**
   * Days of week when the window is active.
   * 1=Monday, 2=Tuesday, ..., 7=Sunday (ISO 8601 convention).
   * @example [1,2,3,4,5] // Mon–Fri
   */
  daysOfWeek: number[];

  /**
   * Window start time in 24-hour 'HH:MM' format (inclusive).
   * @example '09:00'
   */
  windowStart: string;

  /**
   * Window end time in 24-hour 'HH:MM' format (exclusive).
   * @example '18:00'
   */
  windowEnd: string;
}

/**
 * Returns a SessionGuard active within the specified business-hours window.
 *
 * The window is evaluated in the given timezone — pass 'UTC' for UTC-anchored
 * agents (e.g. dreams 02:00–05:00 UTC).
 *
 * @throws {Error} if `windowStart` / `windowEnd` are not valid 'HH:MM' strings.
 */
export function businessHours(opts: BusinessHoursOptions): SessionGuard {
  const tz = opts.tz ?? "UTC";
  const startMinutes = parseHHMM(opts.windowStart, "windowStart");
  const endMinutes = parseHHMM(opts.windowEnd, "windowEnd");
  const activeDays = new Set(opts.daysOfWeek);

  const name = `business-hours:${tz}:${opts.windowStart}-${opts.windowEnd}`;

  return {
    name,

    async isActive(at: Date): Promise<boolean> {
      const parts = getDateParts(at, tz);

      // ISO day-of-week: 1=Mon … 7=Sun
      if (!activeDays.has(parts.isoDow)) {
        return false;
      }

      const minutesFromMidnight = parts.hour * 60 + parts.minute;
      return (
        minutesFromMidnight >= startMinutes &&
        minutesFromMidnight < endMinutes
      );
    },
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

interface DateParts {
  hour: number;
  minute: number;
  /** ISO day-of-week: 1=Mon, 7=Sun */
  isoDow: number;
}

function getDateParts(at: Date, tz: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = fmt.formatToParts(at);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  // en-US "short" weekday → ISO day-of-week mapping
  const isoMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const isoDow = isoMap[get("weekday")] ?? 1;

  return { hour, minute, isoDow };
}

function parseHHMM(value: string, fieldName: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(
      `businessHours: invalid ${fieldName} '${value}' — expected 'HH:MM'`,
    );
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) {
    throw new Error(
      `businessHours: ${fieldName} '${value}' out of range (00:00–23:59)`,
    );
  }
  return h * 60 + m;
}
