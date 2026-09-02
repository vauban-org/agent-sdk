/**
 * Tests — OODA skill capture wiring (sprint-727:skill-capture).
 *
 * Covers the 6 gating + persistence paths of captureSkillFromCycle:
 *   1. disabled → no-op
 *   2. shouldLearn returns false → trigger_below_threshold
 *   3. quality below minQuality → "quality X < Y"
 *   4. happy path → procedural.registerSkill called with expected shape
 *   5. procedural.registerSkill throws → persist_failed, warn logged, NO throw
 *   6. markdownSink throws → capture still succeeds, warn logged
 */

import { describe, expect, it, vi } from "vitest";
import type { LearningTrigger } from "../src/orchestration/ooda/learn.js";
import {
  type SkillCaptureOptions,
  captureSkillFromCycle,
} from "../src/orchestration/ooda/skill-capture.js";
import type { OutcomeRecord } from "../src/orchestration/ooda/types.js";
import type { ProceduralMemoryPort, ProceduralSkill } from "../src/ports/brain.js";
import type { LoggerPort } from "../src/ports/logger.js";

function makeLogger(): LoggerPort & {
  warnCalls: Array<{ obj: unknown; msg: string }>;
  infoCalls: Array<{ obj: unknown; msg: string }>;
} {
  const warnCalls: Array<{ obj: unknown; msg: string }> = [];
  const infoCalls: Array<{ obj: unknown; msg: string }> = [];
  const logger = {
    info: (obj: unknown, msg?: string) => {
      infoCalls.push({ obj, msg: msg ?? "" });
    },
    warn: (obj: unknown, msg?: string) => {
      warnCalls.push({ obj, msg: msg ?? "" });
    },
    error: () => undefined,
    debug: () => undefined,
    warnCalls,
    infoCalls,
  } as unknown as LoggerPort & {
    warnCalls: Array<{ obj: unknown; msg: string }>;
    infoCalls: Array<{ obj: unknown; msg: string }>;
  };
  return logger;
}

/** Trigger that always passes `shouldLearn` (toolCallCount>=4, roi>0, durationMs>5000, !wasReplay). */
const PASS_TRIGGER: LearningTrigger = {
  toolCallCount: 6,
  roi: 12,
  durationMs: 7000,
  wasReplay: false,
};

/** Trigger that fails shouldLearn (durationMs too low). */
const FAIL_TRIGGER: LearningTrigger = {
  toolCallCount: 6,
  roi: 12,
  durationMs: 100,
  wasReplay: false,
};

const HIGH_QUALITY_OUTCOME: OutcomeRecord = {
  outcome_type: "test",
  value_cents: 1200,
  confidence: 0.95,
  quality: 0.9,
};

describe("captureSkillFromCycle", () => {
  it("returns disabled when opts.enabled is false (no procedural call)", async () => {
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: vi.fn().mockResolvedValue(undefined),
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const opts: SkillCaptureOptions = {
      enabled: false,
      domain: "test",
      procedural,
    };
    const logger = makeLogger();
    const r = await captureSkillFromCycle(
      "agent-a",
      "run-1",
      PASS_TRIGGER,
      HIGH_QUALITY_OUTCOME,
      "trace summary",
      opts,
      logger,
    );
    expect(r.captured).toBe(false);
    expect(r.reason).toBe("disabled");
    expect(procedural.registerSkill).not.toHaveBeenCalled();
  });

  it("returns trigger_below_threshold when shouldLearn is false", async () => {
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: vi.fn().mockResolvedValue(undefined),
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const opts: SkillCaptureOptions = {
      enabled: true,
      domain: "test",
      procedural,
    };
    const r = await captureSkillFromCycle(
      "agent-a",
      "run-2",
      FAIL_TRIGGER,
      HIGH_QUALITY_OUTCOME,
      "trace summary",
      opts,
      makeLogger(),
    );
    expect(r.captured).toBe(false);
    expect(r.reason).toBe("trigger_below_threshold");
    expect(procedural.registerSkill).not.toHaveBeenCalled();
  });

  it("returns quality reason when outcome.quality below minQuality", async () => {
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: vi.fn().mockResolvedValue(undefined),
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const lowQuality: OutcomeRecord = {
      outcome_type: "test",
      value_cents: 100,
      quality: 0.4,
    };
    const opts: SkillCaptureOptions = {
      enabled: true,
      domain: "test",
      procedural,
      minQuality: 0.8,
    };
    const r = await captureSkillFromCycle(
      "agent-a",
      "run-3",
      PASS_TRIGGER,
      lowQuality,
      "trace summary",
      opts,
      makeLogger(),
    );
    expect(r.captured).toBe(false);
    expect(r.reason).toContain("0.40");
    expect(r.reason).toContain("0.80");
    expect(procedural.registerSkill).not.toHaveBeenCalled();
  });

  it("happy path — registers skill with expected shape (source learning-loop, confidence=quality)", async () => {
    const registerSpy = vi
      .fn<(agentId: string, skill: ProceduralSkill) => Promise<void>>()
      .mockResolvedValue(undefined);
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: registerSpy,
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const opts: SkillCaptureOptions = {
      enabled: true,
      domain: "test-domain",
      procedural,
    };
    const logger = makeLogger();
    const r = await captureSkillFromCycle(
      "agent-h",
      "run-happy",
      PASS_TRIGGER,
      HIGH_QUALITY_OUTCOME,
      "trace summary",
      opts,
      logger,
    );
    expect(r.captured).toBe(true);
    expect(r.candidateId).toBeDefined();
    expect(r.candidateId).toMatch(/^[0-9a-f]{64}$/);
    expect(registerSpy).toHaveBeenCalledOnce();
    const [agentIdArg, skillArg] = registerSpy.mock.calls[0]!;
    expect(agentIdArg).toBe("agent-h");
    expect(skillArg.source).toBe("learning-loop");
    expect(skillArg.confidence).toBe(0.9);
    expect(skillArg.name).toMatch(/^test-domain-[0-9a-f]{8}$/);
    expect(skillArg.description).toContain("run-happy");
    expect(skillArg.description).toContain("0.90");
    expect(skillArg.chainOfThought).toBe("trace summary");
  });

  it("registerSkill throws → returns persist_failed, logs warn, does NOT throw", async () => {
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: vi.fn().mockRejectedValue(new Error("DB down")),
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const opts: SkillCaptureOptions = {
      enabled: true,
      domain: "test",
      procedural,
    };
    const logger = makeLogger();
    const r = await captureSkillFromCycle(
      "agent-p",
      "run-persist-fail",
      PASS_TRIGGER,
      HIGH_QUALITY_OUTCOME,
      "trace",
      opts,
      logger,
    );
    expect(r.captured).toBe(false);
    expect(r.reason).toBe("persist_failed");
    expect(logger.warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(logger.warnCalls[0]!.msg).toBe("ooda.skill_capture.persist_failed");
  });

  it("markdownSink throws → capture still returns captured=true, logs warn", async () => {
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: vi.fn().mockResolvedValue(undefined),
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const markdownSink = vi.fn().mockRejectedValue(new Error("disk full"));
    const opts: SkillCaptureOptions = {
      enabled: true,
      domain: "test",
      procedural,
      markdownSink,
    };
    const logger = makeLogger();
    const r = await captureSkillFromCycle(
      "agent-m",
      "run-md-fail",
      PASS_TRIGGER,
      HIGH_QUALITY_OUTCOME,
      "trace",
      opts,
      logger,
    );
    expect(r.captured).toBe(true);
    expect(r.candidateId).toBeDefined();
    expect(markdownSink).toHaveBeenCalledOnce();
    const mdWarn = logger.warnCalls.find((w) => w.msg === "ooda.skill_capture.markdown_failed");
    expect(mdWarn).toBeDefined();
  });

  it("markdownSink success — receives path with skillName and frontmatter content", async () => {
    const procedural: ProceduralMemoryPort = {
      resolveSkills: vi.fn().mockResolvedValue([]),
      registerSkill: vi.fn().mockResolvedValue(undefined),
      shareSkill: vi.fn().mockResolvedValue(undefined),
    };
    const captured: Array<{ path: string; content: string }> = [];
    const markdownSink = vi.fn(async (path: string, content: string) => {
      captured.push({ path, content });
    });
    const opts: SkillCaptureOptions = {
      enabled: true,
      domain: "mydomain",
      procedural,
      markdownSink,
    };
    const r = await captureSkillFromCycle(
      "agent-md",
      "run-md-ok",
      PASS_TRIGGER,
      HIGH_QUALITY_OUTCOME,
      "trace",
      opts,
      makeLogger(),
    );
    expect(r.captured).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toMatch(/^mydomain-[0-9a-f]{8}\.SKILL\.md$/);
    expect(captured[0]!.content).toContain("tier: unverified");
    expect(captured[0]!.content).toContain("audit_status: review");
    expect(captured[0]!.content).toContain("source: learning-loop");
  });
});
