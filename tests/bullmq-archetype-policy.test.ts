/**
 * Tests for src/durable/bullmq-runner.ts — archetypePolicy pure function
 *
 * Coverage:
 *   archetypePolicy — returns correct timeoutMs, attempts, backoff for each
 *     archetype: cron, event, interactive, orchestration.
 *     Returns a copy (mutation-safe).
 *
 * Ref: test coverage for src/durable/bullmq-runner.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { archetypePolicy } from "../src/durable/bullmq-runner.js";

describe("archetypePolicy", () => {
  it("cron — 10 min timeout, 3 attempts, exponential backoff", () => {
    const p = archetypePolicy("cron");
    expect(p.timeoutMs).toBe(10 * 60_000);
    expect(p.attempts).toBe(3);
    expect(p.backoff).toEqual({ type: "exponential", delay: 30_000 });
  });

  it("event — 2 min timeout, 5 attempts, exponential backoff", () => {
    const p = archetypePolicy("event");
    expect(p.timeoutMs).toBe(2 * 60_000);
    expect(p.attempts).toBe(5);
    expect(p.backoff?.type).toBe("exponential");
  });

  it("interactive — 60 min timeout, 1 attempt, no backoff", () => {
    const p = archetypePolicy("interactive");
    expect(p.timeoutMs).toBe(60 * 60_000);
    expect(p.attempts).toBe(1);
    expect(p.backoff).toBeNull();
  });

  it("orchestration — 30 min timeout, 2 attempts, exponential backoff", () => {
    const p = archetypePolicy("orchestration");
    expect(p.timeoutMs).toBe(30 * 60_000);
    expect(p.attempts).toBe(2);
    expect(p.backoff).toEqual({ type: "exponential", delay: 60_000 });
  });

  it("returns a copy — external mutation does not affect policy catalog", () => {
    const p1 = archetypePolicy("cron");
    p1.timeoutMs = 999;
    const p2 = archetypePolicy("cron");
    expect(p2.timeoutMs).toBe(10 * 60_000);
  });

  it("each archetype has timeoutMs > 0 and attempts >= 1", () => {
    const archetypes = ["cron", "event", "interactive", "orchestration"] as const;
    for (const a of archetypes) {
      const p = archetypePolicy(a);
      expect(p.timeoutMs).toBeGreaterThan(0);
      expect(p.attempts).toBeGreaterThanOrEqual(1);
    }
  });
});
