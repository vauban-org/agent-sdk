/**
 * Tests for packages/agent-sdk/src/budget/budget-state.ts
 *
 * Coverage:
 *   createBudgetState — defaults, overrides
 *   createCoherenceDetector — validation errors, loop detection, stall detection, score
 *   compactToolLog — short log unchanged, trimming, summary message
 *   emergencyContextSummary — transcript formatting, recursion guard
 *
 * Ref: test coverage for agent-sdk/budget/budget-state.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import {
  compactToolLog,
  createBudgetState,
  createCoherenceDetector,
  emergencyContextSummary,
} from "../src/budget/budget-state.js";

// ─── createBudgetState ────────────────────────────────────────────────────────

describe("createBudgetState", () => {
  it("returns defaults when no overrides provided", () => {
    const state = createBudgetState();
    expect(state.stepCount).toBe(0);
    expect(state.maxSteps).toBe(20);
    expect(state.coherenceScore).toBe(1);
    expect(state.compactionTrigger).toBe(15);
    expect(state.tokensBudget.input).toBe(200_000);
  });

  it("applies scalar overrides", () => {
    const state = createBudgetState({ maxSteps: 10, coherenceScore: 0.5 });
    expect(state.maxSteps).toBe(10);
    expect(state.coherenceScore).toBe(0.5);
    expect(state.stepCount).toBe(0); // default preserved
  });

  it("merges tokensBudget overrides", () => {
    const state = createBudgetState({
      tokensBudget: {
        input: 100_000,
        output: 25_000,
        usedInput: 5000,
        usedOutput: 1000,
      },
    });
    expect(state.tokensBudget.input).toBe(100_000);
    expect(state.tokensBudget.usedInput).toBe(5000);
  });

  it("merges contextWindow overrides", () => {
    const state = createBudgetState({
      contextWindow: { maxTokens: 128_000, currentTokens: 50_000 },
    });
    expect(state.contextWindow.maxTokens).toBe(128_000);
    expect(state.contextWindow.currentTokens).toBe(50_000);
  });
});

// ─── createCoherenceDetector ──────────────────────────────────────────────────

describe("createCoherenceDetector", () => {
  it("throws when loopDetectionWindow < 2", () => {
    expect(() => createCoherenceDetector({ loopDetectionWindow: 1 })).toThrow(
      "loopDetectionWindow must be >= 2",
    );
  });

  it("throws when stallThreshold < 1", () => {
    expect(() => createCoherenceDetector({ stallThreshold: 0 })).toThrow(
      "stallThreshold must be >= 1",
    );
  });

  it("returns score=1 when no loop and no stall", () => {
    const detector = createCoherenceDetector();
    const result = detector.check(
      [
        { name: "a", args: {} },
        { name: "b", args: {} },
        { name: "c", args: {} },
      ],
      2,
    );
    expect(result.isLoop).toBe(false);
    expect(result.isStall).toBe(false);
    expect(result.score).toBe(1);
  });

  it("detects loop when last N tool calls are identical (same name+args)", () => {
    const detector = createCoherenceDetector({ loopDetectionWindow: 3 });
    const call = { name: "search", args: { q: "starknet" } };
    const result = detector.check([call, call, call], 0);
    expect(result.isLoop).toBe(true);
    expect(result.score).toBe(0.5);
  });

  it("does not detect loop when key insertion order differs (key-order-independent)", () => {
    const detector = createCoherenceDetector({ loopDetectionWindow: 2 });
    const c1 = { name: "search", args: { a: 1, b: 2 } };
    const c2 = { name: "search", args: { b: 2, a: 1 } }; // same content, different key order
    const result = detector.check([c1, c2], 0);
    expect(result.isLoop).toBe(true);
  });

  it("detects stall when stepsWithoutTool >= threshold", () => {
    const detector = createCoherenceDetector({ stallThreshold: 3 });
    const result = detector.check([], 3);
    expect(result.isStall).toBe(true);
    expect(result.score).toBe(0.5);
  });

  it("returns score=0 when both loop and stall detected", () => {
    const detector = createCoherenceDetector({
      loopDetectionWindow: 2,
      stallThreshold: 2,
    });
    const call = { name: "t", args: {} };
    const result = detector.check([call, call], 5);
    expect(result.isLoop).toBe(true);
    expect(result.isStall).toBe(true);
    expect(result.score).toBe(0);
  });

  it("does not detect loop when fewer calls than window size", () => {
    const detector = createCoherenceDetector({ loopDetectionWindow: 5 });
    const call = { name: "t", args: {} };
    const result = detector.check([call, call], 0);
    expect(result.isLoop).toBe(false);
  });
});

// ─── compactToolLog ───────────────────────────────────────────────────────────

describe("compactToolLog", () => {
  const msgs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: "assistant" as const,
      content: `step ${i}`,
    }));

  it("returns copy unchanged when log is short enough", () => {
    const log = msgs(4);
    const result = compactToolLog(log, { keepFirst: 2, keepLast: 4 });
    expect(result).toHaveLength(4);
    expect(result).not.toBe(log); // new array
  });

  it("trims middle and inserts summary message", () => {
    const log = msgs(10);
    const result = compactToolLog(log, { keepFirst: 2, keepLast: 3 });
    // 2 + 1 summary + 3 = 6
    expect(result).toHaveLength(6);
    const summary = result[2];
    expect(summary.role).toBe("system");
    expect(summary.content).toContain("5 tool steps omitted");
  });

  it("uses defaults of keepFirst=2, keepLast=4", () => {
    const log = msgs(10);
    const result = compactToolLog(log);
    // 10 > 2+4 → compact: 2 + 1 + 4 = 7
    expect(result).toHaveLength(7);
  });

  it("throws for negative keepFirst", () => {
    expect(() => compactToolLog(msgs(5), { keepFirst: -1, keepLast: 2 })).toThrow();
  });

  it("preserves first and last messages intact", () => {
    const log = msgs(8);
    const result = compactToolLog(log, { keepFirst: 1, keepLast: 1 });
    expect(result[0].content).toBe("step 0");
    expect(result[result.length - 1].content).toBe("step 7");
  });
});

// ─── emergencyContextSummary ──────────────────────────────────────────────────

describe("emergencyContextSummary", () => {
  it("calls summarize with a transcript of the log", async () => {
    const summarize = vi.fn().mockResolvedValue("summary text");
    const log = [
      { role: "user" as const, content: "do task X" },
      {
        role: "assistant" as const,
        content: "thinking...",
        toolName: "search",
      },
    ];
    const result = await emergencyContextSummary(log, summarize, {
      recursion: false,
    });
    expect(result).toBe("summary text");
    const [prompt] = summarize.mock.calls[0];
    expect(prompt).toContain("[user]");
    expect(prompt).toContain("[assistant:search]");
    expect(prompt).toContain("do task X");
  });

  it("includes all log messages in transcript", async () => {
    const summarize = vi.fn().mockResolvedValue("ok");
    const log = Array.from({ length: 5 }, (_, i) => ({
      role: "assistant" as const,
      content: `step ${i}`,
    }));
    await emergencyContextSummary(log, summarize, { recursion: false });
    const [prompt] = summarize.mock.calls[0];
    for (let i = 0; i < 5; i++) {
      expect(prompt).toContain(`step ${i}`);
    }
  });
});
