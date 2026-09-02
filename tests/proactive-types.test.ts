import { describe, expect, it } from "vitest";
import type { AttentionVerdict, ProactiveCandidate } from "../src/proactive/types.js";

describe("proactive types", () => {
  it("a candidate and verdict compose with the documented shape", () => {
    const c: ProactiveCandidate = {
      source: "event",
      subject: "forge-content-writer",
      payload: { failedRuns: 3 },
      observedAt: "2026-07-11T09:00:00.000Z",
    };
    const v: AttentionVerdict = {
      class: "push",
      reason: "run_failed_streak>=3",
      ruleId: "run-fail-streak",
    };
    expect(c.source).toBe("event");
    expect(v.class).toBe("push");
  });
});
