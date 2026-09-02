/**
 * Multi-agent debate engine unit tests.
 *
 * Covers: DebateResult shape, argument passing, multi-round refinement,
 * optional context, field preservation, and error propagation.
 */

import { describe, expect, it, vi } from "vitest";
import { runDebate } from "../src/orchestration/ooda/debate.js";
import type { DebateStance, DebateSynthesis } from "../src/orchestration/ooda/debate.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const mockThesis: DebateStance = {
  content: "thesis text",
  confidence: 0.8,
  keyPoints: ["p1", "p2"],
  risks: ["r1"],
};

const mockAntithesis: DebateStance = {
  content: "antithesis text",
  confidence: 0.6,
  keyPoints: ["p3"],
  risks: ["r2", "r3"],
};

const mockSynthesis: DebateSynthesis = {
  conclusion: "synthesis",
  consensusScore: 0.7,
  recommendation: "proceed",
  tradeoffs: ["t1"],
  hitlRecommended: false,
};

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    question: "Should we proceed?",
    strategist: vi.fn().mockResolvedValue(mockThesis),
    skeptic: vi.fn().mockResolvedValue(mockAntithesis),
    synthesizer: vi.fn().mockResolvedValue(mockSynthesis),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runDebate — result shape", () => {
  it("returns a DebateResult with thesis, antithesis, synthesis, and rounds fields", async () => {
    const result = await runDebate(makeConfig());
    expect(result).toHaveProperty("thesis");
    expect(result).toHaveProperty("antithesis");
    expect(result).toHaveProperty("synthesis");
    expect(result).toHaveProperty("rounds");
  });

  it("thesis matches the strategist response", async () => {
    const result = await runDebate(makeConfig());
    expect(result.thesis).toEqual(mockThesis);
  });

  it("antithesis matches the skeptic response", async () => {
    const result = await runDebate(makeConfig());
    expect(result.antithesis).toEqual(mockAntithesis);
  });

  it("synthesis matches the synthesizer response", async () => {
    const result = await runDebate(makeConfig());
    expect(result.synthesis).toEqual(mockSynthesis);
  });

  it("rounds equals 1 when maxRounds is not specified (default)", async () => {
    const result = await runDebate(makeConfig());
    expect(result.rounds).toBe(1);
  });

  it("rounds equals 1 when maxRounds=1 is set explicitly", async () => {
    const result = await runDebate(makeConfig({ maxRounds: 1 }));
    expect(result.rounds).toBe(1);
  });
});

describe("runDebate — argument passing", () => {
  it("strategist is called with the question", async () => {
    const cfg = makeConfig();
    await runDebate(cfg);
    expect(cfg.strategist).toHaveBeenCalledWith("Should we proceed?", undefined);
  });

  it("strategist is called with context when provided", async () => {
    const cfg = makeConfig({ context: "background info" });
    await runDebate(cfg);
    expect(cfg.strategist).toHaveBeenCalledWith("Should we proceed?", "background info");
  });

  it("skeptic is called with question, thesis, and undefined context by default", async () => {
    const cfg = makeConfig();
    await runDebate(cfg);
    expect(cfg.skeptic).toHaveBeenCalledWith("Should we proceed?", mockThesis, undefined);
  });

  it("skeptic is called with context when provided", async () => {
    const cfg = makeConfig({ context: "background info" });
    await runDebate(cfg);
    expect(cfg.skeptic).toHaveBeenCalledWith("Should we proceed?", mockThesis, "background info");
  });

  it("synthesizer is called with question, thesis, antithesis, and undefined context by default", async () => {
    const cfg = makeConfig();
    await runDebate(cfg);
    expect(cfg.synthesizer).toHaveBeenCalledWith(
      "Should we proceed?",
      mockThesis,
      mockAntithesis,
      undefined,
    );
  });

  it("synthesizer is called with context when provided", async () => {
    const cfg = makeConfig({ context: "background info" });
    await runDebate(cfg);
    expect(cfg.synthesizer).toHaveBeenCalledWith(
      "Should we proceed?",
      mockThesis,
      mockAntithesis,
      "background info",
    );
  });
});

describe("runDebate — synthesis field preservation", () => {
  it("consensusScore in synthesis is preserved from synthesizer response", async () => {
    const result = await runDebate(makeConfig());
    expect(result.synthesis.consensusScore).toBe(0.7);
  });

  it("hitlRecommended field is preserved (false)", async () => {
    const result = await runDebate(makeConfig());
    expect(result.synthesis.hitlRecommended).toBe(false);
  });

  it("hitlRecommended field is preserved (true)", async () => {
    const synthWithHitl: DebateSynthesis = {
      ...mockSynthesis,
      hitlRecommended: true,
    };
    const cfg = makeConfig({
      synthesizer: vi.fn().mockResolvedValue(synthWithHitl),
    });
    const result = await runDebate(cfg);
    expect(result.synthesis.hitlRecommended).toBe(true);
  });

  it("synthesis.recommendation matches the synthesizer recommendation", async () => {
    const result = await runDebate(makeConfig());
    expect(result.synthesis.recommendation).toBe("proceed");
  });
});

describe("runDebate — multi-round refinement", () => {
  it("with maxRounds=2 strategist is called twice total", async () => {
    const cfg = makeConfig({ maxRounds: 2 });
    await runDebate(cfg);
    expect(cfg.strategist).toHaveBeenCalledTimes(2);
  });

  it("with maxRounds=2 skeptic is called twice total", async () => {
    const cfg = makeConfig({ maxRounds: 2 });
    await runDebate(cfg);
    expect(cfg.skeptic).toHaveBeenCalledTimes(2);
  });

  it("second strategist call includes the antithesis content in the question", async () => {
    const cfg = makeConfig({ maxRounds: 2 });
    await runDebate(cfg);
    const secondCall = (cfg.strategist as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toContain(mockAntithesis.content);
  });

  it("rounds field reflects the actual maxRounds value", async () => {
    const cfg = makeConfig({ maxRounds: 3 });
    await runDebate(cfg);
    expect(cfg.strategist).toHaveBeenCalledTimes(3);
    expect((await runDebate(makeConfig({ maxRounds: 3 }))).rounds).toBe(3);
  });
});

describe("runDebate — error propagation", () => {
  it("a failing strategist lets the error propagate out of runDebate", async () => {
    const cfg = makeConfig({
      strategist: vi.fn().mockRejectedValue(new Error("strategist failed")),
    });
    await expect(runDebate(cfg)).rejects.toThrow("strategist failed");
  });

  it("a failing skeptic lets the error propagate out of runDebate", async () => {
    const cfg = makeConfig({
      skeptic: vi.fn().mockRejectedValue(new Error("skeptic failed")),
    });
    await expect(runDebate(cfg)).rejects.toThrow("skeptic failed");
  });

  it("a failing synthesizer lets the error propagate out of runDebate", async () => {
    const cfg = makeConfig({
      synthesizer: vi.fn().mockRejectedValue(new Error("synthesizer failed")),
    });
    await expect(runDebate(cfg)).rejects.toThrow("synthesizer failed");
  });
});
