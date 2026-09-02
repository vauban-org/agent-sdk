/**
 * RunStatePort ; W2 unit contract (ADR-ECO-101).
 *
 * Proves the keystone: the port is a read/fork VIEW over the immutable trace (a
 * fork mints a new prefix and never mutates the parent), and the three pure
 * projections render / locate / inject deterministically over the TraceStep chain.
 */

import { describe, expect, it } from "vitest";
import { findBreakpoint, inMemoryRunState, injectAt, traceToMermaid } from "./run-state.js";
import type { TraceStep } from "./schema.js";

function step(index: number, phase: TraceStep["phase"], type: TraceStep["type"]): TraceStep {
  return {
    index,
    phase,
    type,
    inputHash: `in${index}`,
    outputHash: `out${index}`,
    prevStepHash: index === 0 ? "0".repeat(64) : `h${index - 1}`,
    stepHash: `h${index}`,
  } as TraceStep;
}

const TRACE: readonly TraceStep[] = [
  step(0, "observe", "tool_call"),
  step(1, "orient", "tool_call"),
  step(2, "decide", "guard_check"),
  step(3, "act", "tool_call"),
];

describe("RunStatePort ; read/fork view over the immutable trace", () => {
  it("readPrefix returns the whole trace by default", () => {
    expect(inMemoryRunState(TRACE).readPrefix()).toHaveLength(4);
  });

  it("readPrefix(N) returns steps [0, N)", () => {
    expect(
      inMemoryRunState(TRACE)
        .readPrefix(2)
        .map((s) => s.index),
    ).toEqual([0, 1]);
  });

  it("forkAt(N) mints a prefix WITHOUT mutating the parent (immutability invariant)", () => {
    const rs = inMemoryRunState(TRACE);
    const fork = rs.forkAt(2);
    expect(fork.map((s) => s.index)).toEqual([0, 1]);
    // Parent trace is byte-unchanged.
    expect(rs.readPrefix()).toHaveLength(4);
    expect(TRACE).toHaveLength(4);
  });

  it("headHash returns the last step's stepHash (empty string for an empty trace)", () => {
    expect(inMemoryRunState(TRACE).headHash()).toBe("h3");
    expect(inMemoryRunState([]).headHash()).toBe("");
  });
});

describe("traceToMermaid ; projection #1 (graph-viz)", () => {
  it("renders one node per step plus the chain edges", () => {
    const mmd = traceToMermaid(TRACE);
    expect(mmd.startsWith("flowchart TD")).toBe(true);
    expect(mmd).toContain('s0["#0 OBS:tool_call"]');
    expect(mmd).toContain('s2["#2 DEC:guard_check"]');
    expect(mmd).toContain("s0 --> s1");
    expect(mmd).toContain("s2 --> s3");
  });

  it("is deterministic", () => {
    expect(traceToMermaid(TRACE)).toBe(traceToMermaid(TRACE));
  });

  it("handles an empty trace", () => {
    expect(traceToMermaid([])).toBe("flowchart TD");
  });
});

describe("findBreakpoint ; projection #2 (breakpoint)", () => {
  it("returns the index of the first matching step", () => {
    expect(findBreakpoint(TRACE, (s) => s.phase === "decide")).toBe(2);
  });

  it("returns null when no step matches", () => {
    expect(findBreakpoint(TRACE, (s) => s.phase === "hitl")).toBeNull();
  });
});

describe("injectAt ; projection #3 (state-injection)", () => {
  it("forks at N and appends the injected step, parent unchanged", () => {
    const synthetic = step(99, "observe", "tool_call");
    const forked = injectAt(TRACE, 2, synthetic);
    expect(forked.map((s) => s.index)).toEqual([0, 1, 99]);
    // Immutability: the parent trace is byte-unchanged.
    expect(TRACE.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });
});
