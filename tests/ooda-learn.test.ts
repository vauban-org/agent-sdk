/**
 * tests/ooda-learn.test.ts
 *
 * Sprint-564: C2 — Learning loop shadow mode tests.
 * Covers shouldLearn() boundary conditions + extractSkillFromTrace() guards.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ExtractedSkill,
  GOLDEN_FIXTURES,
  type LearnOptions,
  type LearningTrigger,
  extractSkillFromTrace,
  shouldLearn,
} from "../src/orchestration/ooda/learn.js";
import type { CycleEvent } from "../src/orchestration/ooda/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function trigger(overrides: Partial<LearningTrigger> = {}): LearningTrigger {
  return {
    toolCallCount: 4,
    roi: 1,
    durationMs: 5001,
    wasReplay: false,
    ...overrides,
  };
}

const events: CycleEvent[] = [
  {
    type: "phase_start",
    runId: "r1",
    cycleIndex: 0,
    phase: "observe",
    ts: 100,
  },
  {
    type: "phase_complete",
    runId: "r1",
    cycleIndex: 0,
    phase: "observe",
    durationMs: 50,
    ts: 150,
  },
  { type: "phase_start", runId: "r1", cycleIndex: 0, phase: "orient", ts: 151 },
  {
    type: "cycle_complete",
    runId: "r1",
    cycleIndex: 0,
    status: "succeeded",
    durationMs: 200,
    ts: 300,
  },
];

function validSkill(overrides: Partial<ExtractedSkill> = {}): ExtractedSkill {
  return {
    name: "test_skill",
    description: "a skill",
    chainOfThought: "because",
    confidence: 0.9,
    verified: false,
    ...overrides,
  };
}

// ─── shouldLearn ─────────────────────────────────────────────────────────────

describe("shouldLearn", () => {
  it("returns true when all conditions are met", () => {
    expect(shouldLearn(trigger())).toBe(true);
  });

  it("returns false when toolCallCount < 4", () => {
    expect(shouldLearn(trigger({ toolCallCount: 0 }))).toBe(false);
  });

  it("returns true when toolCallCount === 4 (lower boundary)", () => {
    expect(shouldLearn(trigger({ toolCallCount: 4 }))).toBe(true);
  });

  it("returns false when toolCallCount === 3 (just below boundary)", () => {
    expect(shouldLearn(trigger({ toolCallCount: 3 }))).toBe(false);
  });

  it("returns false when roi is negative", () => {
    expect(shouldLearn(trigger({ roi: -1 }))).toBe(false);
  });

  it("returns false when roi === 0 (boundary)", () => {
    expect(shouldLearn(trigger({ roi: 0 }))).toBe(false);
  });

  it("returns true when roi > 0 with minimal positive value (0.001)", () => {
    expect(shouldLearn(trigger({ roi: 0.001 }))).toBe(true);
  });

  it("returns false when durationMs === 5000 (exact threshold, not strictly greater)", () => {
    expect(shouldLearn(trigger({ durationMs: 5000 }))).toBe(false);
  });

  it("returns false when durationMs < 5000", () => {
    expect(shouldLearn(trigger({ durationMs: 4999 }))).toBe(false);
  });

  it("returns true when durationMs === 5001 (just above threshold)", () => {
    expect(shouldLearn(trigger({ durationMs: 5001 }))).toBe(true);
  });

  it("returns false when wasReplay is true", () => {
    expect(shouldLearn(trigger({ wasReplay: true }))).toBe(false);
  });

  it("returns true when wasReplay is false with all other conditions met", () => {
    expect(shouldLearn(trigger({ wasReplay: false }))).toBe(true);
  });

  it("returns false when multiple conditions fail simultaneously", () => {
    expect(
      shouldLearn({
        toolCallCount: 1,
        roi: -1,
        durationMs: 100,
        wasReplay: true,
      }),
    ).toBe(false);
  });
});

// ─── extractSkillFromTrace ────────────────────────────────────────────────────

describe("extractSkillFromTrace", () => {
  it("returns null immediately when opts.enabled is false (no LLM call)", async () => {
    const extractor = vi.fn().mockResolvedValue(validSkill());
    const opts: LearnOptions = { enabled: false, extractor };
    const result = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(result).toBeNull();
    expect(extractor).not.toHaveBeenCalled();
  });

  it("returns null when opts.extractor is undefined", async () => {
    const opts: LearnOptions = { enabled: true };
    const result = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(result).toBeNull();
  });

  it("returns null when opts.extractor returns null", async () => {
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(null),
    };
    const result = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(result).toBeNull();
  });

  it("returns null when confidence < default minConfidence (0.85)", async () => {
    const skill = validSkill({ confidence: 0.84 });
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(skill),
    };
    const result = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(result).toBeNull();
  });

  it("returns null when confidence < explicit minConfidence", async () => {
    const skill = validSkill({ confidence: 0.7 });
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(skill),
      minConfidence: 0.8,
    };
    const result = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(result).toBeNull();
  });

  it("returns extracted skill when confidence meets default threshold (0.85)", async () => {
    const skill = validSkill({ confidence: 0.85 });
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(skill),
    };
    const result = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(result).toEqual(skill);
  });

  it("returns extracted skill when confidence >= explicit threshold", async () => {
    const skill = validSkill({ confidence: 0.9, name: "new_skill" });
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(skill),
      minConfidence: 0.95,
    };
    const noResult = await extractSkillFromTrace(
      events,
      { agentId: "test", isReplay: false } as any,
      opts,
    );
    expect(noResult).toBeNull();
  });

  it("returns null when events have no phase_start (empty trace)", async () => {
    const emptyEvents: CycleEvent[] = [
      {
        type: "cycle_complete",
        runId: "r1",
        cycleIndex: 0,
        status: "succeeded",
        durationMs: 100,
        ts: 0,
      },
    ];
    const extractor = vi.fn().mockResolvedValue(validSkill());
    const result = await extractSkillFromTrace(emptyEvents, { agentId: "test" } as any, {
      enabled: true,
      extractor,
    });
    expect(result).toBeNull();
    expect(extractor).not.toHaveBeenCalled();
  });

  it("calls ledger.add when skill is verified and ledger is provided", async () => {
    const skill = validSkill({ confidence: 0.9, verified: true });
    const ledgerAdd = vi.fn();
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(skill),
      ledger: { add: ledgerAdd },
    };
    await extractSkillFromTrace(events, { agentId: "test" } as any, opts);
    expect(ledgerAdd).toHaveBeenCalledWith(skill.name, {
      description: skill.description,
      chainOfThought: skill.chainOfThought,
      source: "learning-loop",
      confidence: skill.confidence,
    });
  });

  it("does NOT call ledger.add when skill is not verified", async () => {
    const skill = validSkill({ confidence: 0.9, verified: false });
    const ledgerAdd = vi.fn();
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockResolvedValue(skill),
      ledger: { add: ledgerAdd },
    };
    const result = await extractSkillFromTrace(events, { agentId: "test" } as any, opts);
    expect(result).toEqual(skill);
    expect(ledgerAdd).not.toHaveBeenCalled();
  });

  it("returns null when extractor throws (error isolation)", async () => {
    const opts: LearnOptions = {
      enabled: true,
      extractor: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };
    const result = await extractSkillFromTrace(events, { agentId: "test" } as any, opts);
    expect(result).toBeNull();
  });
});

// ─── GOLDEN_FIXTURES ─────────────────────────────────────────────────────────

describe("GOLDEN_FIXTURES", () => {
  it("has at least one fixture", () => {
    expect(GOLDEN_FIXTURES.length).toBeGreaterThan(0);
  });

  it("each fixture has a non-empty trace string", () => {
    for (const fixture of GOLDEN_FIXTURES) {
      expect(typeof fixture.trace).toBe("string");
      expect(fixture.trace.length).toBeGreaterThan(0);
    }
  });

  it("each fixture has a non-empty expectedSkillName string", () => {
    for (const fixture of GOLDEN_FIXTURES) {
      expect(typeof fixture.expectedSkillName).toBe("string");
      expect(fixture.expectedSkillName.length).toBeGreaterThan(0);
    }
  });
});
