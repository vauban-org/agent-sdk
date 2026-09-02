/**
 * Tests for debate.ts + economic-observer.ts (guard factory)
 *
 * Coverage (debate):
 *   runDebate — single round: calls strategist→skeptic→synthesizer in order,
 *               returns correct thesis/antithesis/synthesis/rounds,
 *               multi-round: refines thesis+antithesis N times
 *
 * Coverage (economicObserverGuard):
 *   guard name is 'economic_observer',
 *   proceed=true when shouldThrottle=false,
 *   proceed=false with reason when shouldThrottle=true
 *
 * Ref: test coverage for ooda/debate.ts + ooda/economic-observer.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { runDebate } from "../src/orchestration/ooda/debate.js";
import { economicObserverGuard } from "../src/orchestration/ooda/economic-observer.js";

// ─── runDebate ────────────────────────────────────────────────────────────────

const THESIS = {
  content: "deploy now",
  confidence: 0.8,
  keyPoints: ["fast"],
  risks: [],
};
const ANTITHESIS = {
  content: "wait for signals",
  confidence: 0.7,
  keyPoints: ["safe"],
  risks: ["slow"],
};
const SYNTHESIS = {
  conclusion: "partial deploy",
  consensusScore: 0.75,
  recommendation: "deploy with feature flag",
  tradeoffs: ["speed vs safety"],
  hitlRecommended: false,
};

describe("runDebate", () => {
  it("single round: calls strategist, skeptic, synthesizer in order", async () => {
    const strategist = vi.fn().mockResolvedValue(THESIS);
    const skeptic = vi.fn().mockResolvedValue(ANTITHESIS);
    const synthesizer = vi.fn().mockResolvedValue(SYNTHESIS);

    await runDebate({ question: "Deploy?", strategist, skeptic, synthesizer });

    expect(strategist).toHaveBeenCalledOnce();
    expect(skeptic).toHaveBeenCalledOnce();
    expect(synthesizer).toHaveBeenCalledOnce();
    // Order enforced by argument passing: strategist called before skeptic
    expect(skeptic).toHaveBeenCalledWith("Deploy?", THESIS, undefined);
  });

  it("returns thesis, antithesis, synthesis, and rounds=1", async () => {
    const strategist = vi.fn().mockResolvedValue(THESIS);
    const skeptic = vi.fn().mockResolvedValue(ANTITHESIS);
    const synthesizer = vi.fn().mockResolvedValue(SYNTHESIS);

    const result = await runDebate({
      question: "Deploy?",
      strategist,
      skeptic,
      synthesizer,
    });

    expect(result.thesis).toBe(THESIS);
    expect(result.antithesis).toBe(ANTITHESIS);
    expect(result.synthesis).toBe(SYNTHESIS);
    expect(result.rounds).toBe(1);
  });

  it("passes context to strategist and skeptic when provided", async () => {
    const strategist = vi.fn().mockResolvedValue(THESIS);
    const skeptic = vi.fn().mockResolvedValue(ANTITHESIS);
    const synthesizer = vi.fn().mockResolvedValue(SYNTHESIS);

    await runDebate({
      question: "Deploy?",
      context: "sprint-700",
      strategist,
      skeptic,
      synthesizer,
    });

    expect(strategist).toHaveBeenCalledWith("Deploy?", "sprint-700");
    expect(skeptic).toHaveBeenCalledWith("Deploy?", THESIS, "sprint-700");
  });

  it("multi-round: refines thesis+antithesis N-1 extra times", async () => {
    const strategist = vi.fn().mockResolvedValue(THESIS);
    const skeptic = vi.fn().mockResolvedValue(ANTITHESIS);
    const synthesizer = vi.fn().mockResolvedValue(SYNTHESIS);

    await runDebate({
      question: "Deploy?",
      maxRounds: 3,
      strategist,
      skeptic,
      synthesizer,
    });

    // 1 initial + 2 refinements = 3 calls each for strategist and skeptic
    expect(strategist).toHaveBeenCalledTimes(3);
    expect(skeptic).toHaveBeenCalledTimes(3);
    // Synthesizer always called once at end
    expect(synthesizer).toHaveBeenCalledOnce();
  });

  it("result.rounds reflects maxRounds", async () => {
    const strategist = vi.fn().mockResolvedValue(THESIS);
    const skeptic = vi.fn().mockResolvedValue(ANTITHESIS);
    const synthesizer = vi.fn().mockResolvedValue(SYNTHESIS);

    const result = await runDebate({
      question: "Q",
      maxRounds: 2,
      strategist,
      skeptic,
      synthesizer,
    });
    expect(result.rounds).toBe(2);
  });
});

// ─── economicObserverGuard ────────────────────────────────────────────────────

describe("economicObserverGuard", () => {
  it("guard name is 'economic_observer'", () => {
    const observer = {
      shouldThrottle: vi.fn(),
      recordCycle: vi.fn(),
      getStats: vi.fn(),
    };
    const guard = economicObserverGuard(observer, "forge");
    expect(guard.name).toBe("economic_observer");
  });

  it("returns proceed=true when shouldThrottle=false", async () => {
    const observer = {
      shouldThrottle: vi.fn().mockResolvedValue(false),
      recordCycle: vi.fn(),
      getStats: vi.fn(),
    };
    const guard = economicObserverGuard(observer, "forge");
    const result = await guard.check({} as never);
    expect(result.proceed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns proceed=false with reason when shouldThrottle=true", async () => {
    const observer = {
      shouldThrottle: vi.fn().mockResolvedValue(true),
      recordCycle: vi.fn(),
      getStats: vi.fn(),
    };
    const guard = economicObserverGuard(observer, "scribe");
    const result = await guard.check({} as never);
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe("economic_observer:negative_roi");
  });

  it("passes agentId to shouldThrottle", async () => {
    const observer = {
      shouldThrottle: vi.fn().mockResolvedValue(false),
      recordCycle: vi.fn(),
      getStats: vi.fn(),
    };
    const guard = economicObserverGuard(observer, "synergy");
    await guard.check({} as never);
    expect(observer.shouldThrottle).toHaveBeenCalledWith("synergy");
  });
});
