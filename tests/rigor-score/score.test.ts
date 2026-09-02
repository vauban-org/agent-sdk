/**
 * Tests for packages/agent-sdk/src/rigor-score/score.ts ; wave-2 MOVE#9.
 *
 * scoreRigor is the composite: it runs the 3 honestly-scored pillars over one
 * RigorScoreInput and combines them via the renormalized weights (types.ts).
 * Coverage: all-pillars-rigorous -> 100, all-pillars-sloppy -> 0, a mixed
 * fixture matched against a hand-computed expected value (proves the actual
 * renormalized weighting, not just the extremes), and the honesty-framing
 * fields (pillarsScored/pillarsTotal/rationale) are present and correct
 * regardless of input ; the composite must never be presented as a bare
 * number without them (per the design's non-negotiable HUD requirement).
 */
import { describe, expect, it } from "vitest";
import { scoreRigor } from "../../src/rigor-score/score.js";
import type { RigorScoreInput, ScoredToolCall } from "../../src/rigor-score/types.js";

// Every pillar 1: reused shape from pillars.test.ts's "rigorous" fixtures ; a
// read before its edit, one recovered failure, ends on a clean call.
const ALL_RIGOROUS: ScoredToolCall[] = [
  { name: "read_file", args: { path: "/a.ts" } },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
  { name: "edit_file", args: { filePath: "/a.ts", old_string: "x", new_string: "y" } },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 0 },
];

// Every pillar 0: an edit with no prior read, plus a 3x identical-failure
// doom loop that ends the turn still failing.
const ALL_SLOPPY: ScoredToolCall[] = [
  { name: "edit_file", args: { filePath: "/b.ts", old_string: "x", new_string: "y" } },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
];

// VC=1, RE=0, ATI=1 on the SAME toolCalls array: a 3x-identical-command doom
// loop (kills loopFreedom, and the retry is never varied so errorRecovery is
// also 0) that happens to succeed on its last (4th, still-identical) attempt
// (kills nothing in ATI: no edit_file at all -> readBeforeEdit vacuous-passes,
// and the last call is a SUCCESS -> endedClean holds).
const MIXED_TOOL_CALLS: ScoredToolCall[] = [
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
  { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 0 },
];

describe("scoreRigor", () => {
  it("all 3 pillars rigorous -> composite 100", () => {
    const input: RigorScoreInput = {
      toolCalls: ALL_RIGOROUS,
      evidenceCount: 3,
      gapCount: 0,
    };
    const result = scoreRigor(input);
    expect(result.composite).toBe(100);
    expect(result.pillars.verificationCoverage).toBe(1);
    expect(result.pillars.recoveryEfficiency).toBe(1);
    expect(result.pillars.atomicTransitionIntegrity).toBe(1);
  });

  it("all 3 pillars sloppy -> composite 0", () => {
    const input: RigorScoreInput = {
      toolCalls: ALL_SLOPPY,
      evidenceCount: 0,
      gapCount: 3,
    };
    const result = scoreRigor(input);
    expect(result.composite).toBe(0);
    expect(result.pillars.verificationCoverage).toBe(0);
    expect(result.pillars.recoveryEfficiency).toBe(0);
    expect(result.pillars.atomicTransitionIntegrity).toBe(0);
  });

  it("a mixed fixture (VC=1, RE=0, ATI=1) matches the hand-computed renormalized weighting", () => {
    const input: RigorScoreInput = {
      toolCalls: MIXED_TOOL_CALLS,
      evidenceCount: 1,
      gapCount: 0,
    };
    const result = scoreRigor(input);
    expect(result.pillars.verificationCoverage).toBe(1);
    expect(result.pillars.recoveryEfficiency).toBe(0);
    expect(result.pillars.atomicTransitionIntegrity).toBe(1);
    // 1*0.3846 + 0*0.3846 + 1*0.2308 = 0.6154 -> round(61.54) = 62.
    expect(result.composite).toBe(62);
  });

  it("always reports pillarsScored=3 / pillarsTotal=5, regardless of input (honest framing is not conditional)", () => {
    const rigorous = scoreRigor({ toolCalls: ALL_RIGOROUS, evidenceCount: 3, gapCount: 0 });
    const sloppy = scoreRigor({ toolCalls: ALL_SLOPPY, evidenceCount: 0, gapCount: 3 });
    const empty = scoreRigor({ toolCalls: [], evidenceCount: 0, gapCount: 0 });
    for (const r of [rigorous, sloppy, empty]) {
      expect(r.pillarsScored).toBe(3);
      expect(r.pillarsTotal).toBe(5);
    }
  });

  it("rationale always names the 3/5 scope, never implying a full RigorBench score", () => {
    const result = scoreRigor({ toolCalls: ALL_SLOPPY, evidenceCount: 0, gapCount: 3 });
    expect(result.rationale).toContain("3/5");
  });

  it("the composite is always an integer in [0, 100] even for fractional pillar scores", () => {
    const result = scoreRigor({
      toolCalls: [{ name: "read_file", args: { path: "/a.ts" } }],
      evidenceCount: 1,
      gapCount: 1,
    });
    expect(Number.isInteger(result.composite)).toBe(true);
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(100);
  });
});
