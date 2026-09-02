/**
 * Tests for packages/agent-sdk/src/rigor-score/pillars.ts ; wave-2 MOVE#9.
 *
 * Each of the 3 honestly-scored RigorBench-inspired pillars gets: a rigorous
 * fixture -> 1, a sloppy fixture -> 0, a vacuous-pass edge case (nothing to
 * judge) -> 1 (mirrors turn-verifier.ts's runChecks([]) "vacuous pass"
 * convention), and where the pillar composes two sub-metrics, one isolated
 * violation -> 0.5 (proves the two halves are independently load-bearing,
 * not one sub-metric silently dominating).
 */
import { describe, expect, it } from "vitest";
import {
  atomicTransitionIntegrity,
  recoveryEfficiency,
  verificationCoverage,
} from "../../src/rigor-score/pillars.js";
import type { ScoredToolCall } from "../../src/rigor-score/types.js";

// ─── verificationCoverage ────────────────────────────────────────────────────

describe("verificationCoverage", () => {
  it("all evidence, no gaps -> 1 (rigorous)", () => {
    expect(verificationCoverage(3, 0)).toBe(1);
  });

  it("all gaps, no evidence -> 0 (sloppy)", () => {
    expect(verificationCoverage(0, 3)).toBe(0);
  });

  it("zero checks derived -> 1 (vacuous pass, mirrors runChecks([]) convention)", () => {
    expect(verificationCoverage(0, 0)).toBe(1);
  });

  it("an even split -> 0.5", () => {
    expect(verificationCoverage(1, 1)).toBe(0.5);
  });
});

// ─── recoveryEfficiency ──────────────────────────────────────────────────────

describe("recoveryEfficiency", () => {
  it("no repetition, a failure followed by a genuinely different call -> 1 (rigorous)", () => {
    const calls: ScoredToolCall[] = [
      { name: "read_file", args: { path: "/a.ts" } },
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
      {
        name: "edit_file",
        args: { filePath: "/a.ts", old_string: "x", new_string: "y" },
      },
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 0 },
    ];
    expect(recoveryEfficiency(calls)).toBe(1);
  });

  it("a 3x identical doom loop of a repeated failing command, never varied -> 0 (sloppy)", () => {
    const failing: ScoredToolCall = {
      name: "run_bash",
      args: { command: "pnpm test" },
      observedExitCode: 1,
    };
    const calls: ScoredToolCall[] = [failing, { ...failing }, { ...failing }];
    expect(recoveryEfficiency(calls)).toBe(0);
  });

  it("zero tool calls -> 1 (vacuous pass on both sub-metrics)", () => {
    expect(recoveryEfficiency([])).toBe(1);
  });

  it("loopFreedom violated alone (no failures to recover from) -> 0.5", () => {
    const readA: ScoredToolCall = { name: "read_file", args: { path: "/a.ts" } };
    const calls: ScoredToolCall[] = [readA, { ...readA }, { ...readA }];
    expect(recoveryEfficiency(calls)).toBe(0.5);
  });

  it("errorRecovery violated alone (no doom loop ; only 2 identical calls) -> 0.5", () => {
    const failing: ScoredToolCall = {
      name: "run_bash",
      args: { command: "pnpm test" },
      observedExitCode: 1,
    };
    const calls: ScoredToolCall[] = [failing, { ...failing }];
    expect(recoveryEfficiency(calls)).toBe(0.5);
  });

  it("a run_bash failure with no observed exit code on the NEXT call is not double-penalized by identical unobserved args", () => {
    // args-equality uses the SDK canonicalize(); two calls with different
    // commands are never "the same call" regardless of exit-code visibility.
    const calls: ScoredToolCall[] = [
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
      { name: "run_bash", args: { command: "pnpm test -- --watch=false" } },
    ];
    expect(recoveryEfficiency(calls)).toBe(1);
  });
});

// ─── atomicTransitionIntegrity ───────────────────────────────────────────────

describe("atomicTransitionIntegrity", () => {
  it("edit preceded by a read of the same path, ended on a clean call -> 1 (rigorous)", () => {
    const calls: ScoredToolCall[] = [
      { name: "read_file", args: { path: "/a.ts" } },
      {
        name: "edit_file",
        args: { filePath: "/a.ts", old_string: "x", new_string: "y" },
      },
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 0 },
    ];
    expect(atomicTransitionIntegrity(calls)).toBe(1);
  });

  it("edit with no prior read, ends on an observed failure -> 0 (sloppy)", () => {
    const calls: ScoredToolCall[] = [
      {
        name: "edit_file",
        args: { filePath: "/b.ts", old_string: "x", new_string: "y" },
      },
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
    ];
    expect(atomicTransitionIntegrity(calls)).toBe(0);
  });

  it("zero tool calls -> 1 (vacuous pass on both sub-metrics)", () => {
    expect(atomicTransitionIntegrity([])).toBe(1);
  });

  it("readBeforeEdit violated alone (endedClean satisfied) -> 0.5", () => {
    const calls: ScoredToolCall[] = [
      {
        name: "edit_file",
        args: { filePath: "/b.ts", old_string: "x", new_string: "y" },
      },
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 0 },
    ];
    expect(atomicTransitionIntegrity(calls)).toBe(0.5);
  });

  it("endedClean violated alone (readBeforeEdit satisfied) -> 0.5", () => {
    const calls: ScoredToolCall[] = [
      { name: "read_file", args: { path: "/a.ts" } },
      {
        name: "edit_file",
        args: { filePath: "/a.ts", old_string: "x", new_string: "y" },
      },
      { name: "run_bash", args: { command: "pnpm test" }, observedExitCode: 1 },
    ];
    expect(atomicTransitionIntegrity(calls)).toBe(0.5);
  });

  it("an unobserved trailing run_bash exit code is never treated as a failure (unverifiable, not guilty)", () => {
    const calls: ScoredToolCall[] = [
      { name: "read_file", args: { path: "/a.ts" } },
      {
        name: "edit_file",
        args: { filePath: "/a.ts", old_string: "x", new_string: "y" },
      },
      { name: "run_bash", args: { command: "pnpm test" } }, // no observedExitCode
    ];
    expect(atomicTransitionIntegrity(calls)).toBe(1);
  });
});
