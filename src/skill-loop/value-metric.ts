/**
 * src/skill-loop/value-metric.ts
 *
 * skill_value formula: cumulative weekly metric.
 *
 *   skill_value = Σ(usage_count × outcome_delta_vs_baseline)
 *
 * Consumer provides an outcomeDeltaCalculator function that returns the
 * outcome delta for a given usage event. The metric is cumulative over a
 * sliding 7-day window.
 *
 * @module skill-loop/value-metric
 * @public
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageEvent {
  /** Skill ID this event belongs to. */
  skillId: string;
  /** ISO-8601 timestamp of the usage event. */
  timestamp: string;
  /** Arbitrary context passed to the outcomeDeltaCalculator. */
  context: Record<string, unknown>;
}

/** @public */
export interface SkillValueResult {
  skillId: string;
  /** Sum of (usage × outcome_delta) over the window. */
  skillValue: number;
  /** Number of usage events included. */
  usageCount: number;
  /** Sum of all individual outcome deltas (raw). */
  totalOutcomeDelta: number;
  /** Start of the 7-day window (ISO-8601). */
  windowStart: string;
  /** End of the 7-day window (ISO-8601). */
  windowEnd: string;
}

// ---------------------------------------------------------------------------
// 7-day sliding window constant
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// computeSkillValue
// ---------------------------------------------------------------------------

/**
 * Compute skill_value = Σ(usage × outcome_delta_vs_baseline).
 *
 * Each usage event is weighted by the outcome delta it produced vs the
 * baseline skill. Events outside the 7-day window are excluded.
 *
 * @param skillId                 - The skill being measured.
 * @param usageEvents             - All usage events for this skill.
 * @param outcomeDeltaCalculator  - Consumer-provided function: event → delta.
 * @param nowDate                 - Optional override for "now" (deterministic tests).
 */
export function computeSkillValue(
  skillId: string,
  usageEvents: UsageEvent[],
  outcomeDeltaCalculator: (event: UsageEvent) => number,
  nowDate?: Date,
): SkillValueResult {
  const now = nowDate ?? new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - WEEK_MS).toISOString();

  // Filter to events within the 7-day window
  const windowEvents = usageEvents.filter((e) => {
    const ts = e.timestamp;
    return ts >= windowStart && ts <= windowEnd;
  });

  // skill_value = Σ(usage × outcome_delta)
  // Each event counts as 1 usage unit.
  let skillValue = 0;
  let totalOutcomeDelta = 0;

  for (const event of windowEvents) {
    const delta = outcomeDeltaCalculator(event);
    skillValue += 1 * delta; // usage_count per event = 1
    totalOutcomeDelta += delta;
  }

  return {
    skillId,
    skillValue,
    usageCount: windowEvents.length,
    totalOutcomeDelta,
    windowStart,
    windowEnd,
  };
}

// ---------------------------------------------------------------------------
// computeAggregateSkillValue (multi-skill comparison helper)
// ---------------------------------------------------------------------------

/**
 * Compute skill_value for multiple skills and rank them descending.
 */
export function rankSkillsByValue(
  skills: Array<{
    skillId: string;
    usageEvents: UsageEvent[];
    outcomeDeltaCalculator: (event: UsageEvent) => number;
  }>,
  nowDate?: Date,
): SkillValueResult[] {
  const results = skills.map(({ skillId, usageEvents, outcomeDeltaCalculator }) =>
    computeSkillValue(skillId, usageEvents, outcomeDeltaCalculator, nowDate),
  );
  return results.sort((a, b) => b.skillValue - a.skillValue);
}
