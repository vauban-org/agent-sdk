/**
 * Tests for packages/agent-sdk/src/skill-loop/value-metric.ts
 *
 * Coverage:
 *   computeSkillValue — empty events returns zero metrics,
 *                       single event in window,
 *                       multiple events summed correctly,
 *                       events outside window excluded,
 *                       events exactly on window boundary included,
 *                       events just before window excluded,
 *                       negative deltas reduce skillValue,
 *                       usageCount matches filtered events,
 *                       windowStart/windowEnd reflect 7-day span,
 *                       nowDate override enables deterministic tests
 *
 *   rankSkillsByValue — returns results sorted descending by skillValue,
 *                       handles single skill,
 *                       handles equal values (stable order not required but result is array),
 *                       empty skill list returns empty array
 */

import { describe, expect, it } from "vitest";
import {
  type UsageEvent,
  computeSkillValue,
  rankSkillsByValue,
} from "../src/skill-loop/value-metric.js";

const NOW = new Date("2026-01-14T12:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

function tsAt(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function makeEvent(skillId: string, offsetMs: number): UsageEvent {
  return { skillId, timestamp: tsAt(offsetMs), context: {} };
}

describe("computeSkillValue", () => {
  it("returns zero metrics when there are no usage events", () => {
    const result = computeSkillValue("skill-a", [], () => 1, NOW);
    expect(result.skillValue).toBe(0);
    expect(result.usageCount).toBe(0);
    expect(result.totalOutcomeDelta).toBe(0);
    expect(result.skillId).toBe("skill-a");
  });

  it("includes a single event that falls within the window", () => {
    const events = [makeEvent("skill-a", -1000)]; // 1s ago
    const result = computeSkillValue("skill-a", events, () => 5, NOW);
    expect(result.usageCount).toBe(1);
    expect(result.skillValue).toBe(5);
    expect(result.totalOutcomeDelta).toBe(5);
  });

  it("sums multiple events within the window", () => {
    const events = [
      makeEvent("skill-a", -1000),
      makeEvent("skill-a", -2000),
      makeEvent("skill-a", -3000),
    ];
    const result = computeSkillValue("skill-a", events, () => 2, NOW);
    expect(result.usageCount).toBe(3);
    expect(result.skillValue).toBe(6);
    expect(result.totalOutcomeDelta).toBe(6);
  });

  it("excludes events older than 7 days", () => {
    const events = [
      makeEvent("skill-a", -(WEEK_MS + 1)), // 1ms past the window
      makeEvent("skill-a", -1000), // within window
    ];
    const result = computeSkillValue("skill-a", events, () => 10, NOW);
    expect(result.usageCount).toBe(1);
    expect(result.skillValue).toBe(10);
  });

  it("includes events exactly on the window start boundary", () => {
    // The window start is NOW - WEEK_MS; an event at exactly that time should be included
    const events = [makeEvent("skill-a", -WEEK_MS)];
    const result = computeSkillValue("skill-a", events, () => 3, NOW);
    expect(result.usageCount).toBe(1);
  });

  it("includes events at the window end (now)", () => {
    const events = [makeEvent("skill-a", 0)]; // exactly now
    const result = computeSkillValue("skill-a", events, () => 7, NOW);
    expect(result.usageCount).toBe(1);
    expect(result.skillValue).toBe(7);
  });

  it("handles negative outcome deltas correctly", () => {
    const events = [makeEvent("skill-a", -1000), makeEvent("skill-a", -2000)];
    const result = computeSkillValue("skill-a", events, () => -4, NOW);
    expect(result.skillValue).toBe(-8);
    expect(result.totalOutcomeDelta).toBe(-8);
  });

  it("handles mixed positive and negative deltas", () => {
    const events = [
      makeEvent("skill-a", -1000),
      makeEvent("skill-a", -2000),
      makeEvent("skill-a", -3000),
    ];
    let call = 0;
    const deltas = [3, -1, 2];
    const result = computeSkillValue("skill-a", events, () => deltas[call++] ?? 0, NOW);
    expect(result.skillValue).toBe(4);
    expect(result.totalOutcomeDelta).toBe(4);
  });

  it("windowStart is exactly 7 days before windowEnd", () => {
    const result = computeSkillValue("skill-a", [], () => 0, NOW);
    const start = new Date(result.windowStart).getTime();
    const end = new Date(result.windowEnd).getTime();
    expect(end - start).toBe(WEEK_MS);
  });

  it("windowEnd matches the provided nowDate ISO string", () => {
    const result = computeSkillValue("skill-a", [], () => 0, NOW);
    expect(result.windowEnd).toBe(NOW.toISOString());
  });

  it("skillId is propagated to the result", () => {
    const result = computeSkillValue("my-custom-skill", [], () => 0, NOW);
    expect(result.skillId).toBe("my-custom-skill");
  });

  it("uses real Date when nowDate is not provided (smoke test)", () => {
    const result = computeSkillValue("skill-a", [], () => 0);
    expect(result.windowEnd).toBeDefined();
    expect(result.skillValue).toBe(0);
  });
});

describe("rankSkillsByValue", () => {
  it("returns an empty array for empty input", () => {
    expect(rankSkillsByValue([], NOW)).toEqual([]);
  });

  it("returns a single-element array for one skill", () => {
    const result = rankSkillsByValue(
      [
        {
          skillId: "only",
          usageEvents: [makeEvent("only", -1000)],
          outcomeDeltaCalculator: () => 5,
        },
      ],
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].skillId).toBe("only");
  });

  it("ranks skills descending by skillValue", () => {
    const skills = [
      {
        skillId: "low",
        usageEvents: [makeEvent("low", -1000)],
        outcomeDeltaCalculator: () => 1,
      },
      {
        skillId: "high",
        usageEvents: [makeEvent("high", -1000)],
        outcomeDeltaCalculator: () => 10,
      },
      {
        skillId: "mid",
        usageEvents: [makeEvent("mid", -1000)],
        outcomeDeltaCalculator: () => 5,
      },
    ];
    const result = rankSkillsByValue(skills, NOW);
    expect(result[0].skillId).toBe("high");
    expect(result[1].skillId).toBe("mid");
    expect(result[2].skillId).toBe("low");
  });

  it("returns all skills even when some have zero value", () => {
    const skills = [
      {
        skillId: "zero",
        usageEvents: [],
        outcomeDeltaCalculator: () => 0,
      },
      {
        skillId: "positive",
        usageEvents: [makeEvent("positive", -1000)],
        outcomeDeltaCalculator: () => 3,
      },
    ];
    const result = rankSkillsByValue(skills, NOW);
    expect(result).toHaveLength(2);
    expect(result[0].skillId).toBe("positive");
    expect(result[1].skillId).toBe("zero");
  });
});
