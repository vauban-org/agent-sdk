/**
 * CronExpression scheduling — SessionGuard based on cron expressions.
 *
 * Replaces fixed-interval scheduling with cron-based patterns:
 * "every Monday 9am", "first day of month", "every weekday at 8am".
 *
 * The `cronSessionGuard(expr)` returns a `SessionGuard` compatible with
 * the existing OODA guard system — zero boilerplate wiring.
 *
 * @public
 */

import type { SessionGuard } from "./types.js";

// ─── Cron Parser ────────────────────────────────────────────────────────────────

/**
 * Minimal cron expression parser (5-field: minute hour day-of-month month day-of-week).
 *
 * Supports wildcards, specific values, ranges, steps, and lists.
 * Does NOT support L, W, hash, question mark, or year field.
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  if (field === "*") {
    for (let i = min; i <= max; i++) values.add(i);
    return values;
  }

  const parts = field.split(",");
  for (const part of parts) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number.parseInt(stepStr, 10) : 1;

    let rangeMin: number;
    let rangeMax: number;

    if (range === "*") {
      rangeMin = min;
      rangeMax = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      rangeMin = Number.parseInt(a, 10);
      rangeMax = Number.parseInt(b, 10);
    } else {
      rangeMin = Number.parseInt(range, 10);
      rangeMax = rangeMin;
    }

    for (let i = rangeMin; i <= rangeMax; i += step) {
      if (i >= min && i <= max) values.add(i);
    }
  }

  return values;
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseCronExpression(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields, got ${parts.length}`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6), // 0=Sunday
  };
}

function cronMatches(expr: string, date: Date): boolean {
  const fields = parseCronExpression(expr);
  return (
    fields.minutes.has(date.getUTCMinutes()) &&
    fields.hours.has(date.getUTCHours()) &&
    fields.daysOfMonth.has(date.getUTCDate()) &&
    fields.months.has(date.getUTCMonth() + 1) &&
    fields.daysOfWeek.has(date.getUTCDay())
  );
}

// ─── Session Guard ──────────────────────────────────────────────────────────────

/**
 * Create a SessionGuard from a cron expression.
 *
 * The guard returns `isActive: true` when the current time matches the
 * cron expression. This gates whether a cycle should run at all.
 *
 * @example
 * ```typescript
 * // Run every weekday at 9:00 AM UTC
 * const guard = cronSessionGuard("0 9 * * 1-5");
 * ```
 * @public
 */
export function cronSessionGuard(expr: string): SessionGuard {
  // Validate at construction time
  parseCronExpression(expr);

  return {
    name: `cron:${expr}`,
    isActive: async (at: Date) => cronMatches(expr, at),
  };
}
