/**
 * Tests for packages/agent-sdk/src/compute/strategies/tree-of-thoughts.ts
 *
 * Coverage:
 *   treeOfThoughtsStrategy — validation (maxDepth/branchFactor/maxCalls<1, bad policy),
 *     strategy name includes search policy,
 *     BFS: returns highest-scored output, respects maxCalls budget,
 *     DFS: returns highest-scored output,
 *     prune threshold filters out low-scoring candidates,
 *     custom evaluateState function,
 *     metadata.cost.calls = actual generator calls used
 *
 * Ref: test coverage for agent-sdk/compute/strategies/tree-of-thoughts.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { treeOfThoughtsStrategy } from "../src/compute/strategies/tree-of-thoughts.js";

describe("treeOfThoughtsStrategy — validation", () => {
  it("throws RangeError when maxDepth < 1", () => {
    expect(() => treeOfThoughtsStrategy({ maxDepth: 0 })).toThrow(RangeError);
  });

  it("throws RangeError when branchFactor < 1", () => {
    expect(() => treeOfThoughtsStrategy({ branchFactor: 0 })).toThrow(RangeError);
  });

  it("throws RangeError when maxCalls < 1", () => {
    expect(() => treeOfThoughtsStrategy({ maxCalls: 0, maxDepth: 1, branchFactor: 1 })).toThrow(
      RangeError,
    );
  });

  it("throws when searchPolicy is invalid", () => {
    expect(() => treeOfThoughtsStrategy({ searchPolicy: "bunk" as never })).toThrow("bfs");
  });
});

describe("treeOfThoughtsStrategy — strategy name", () => {
  it("name includes searchPolicy", () => {
    expect(treeOfThoughtsStrategy({ searchPolicy: "bfs" }).name).toContain("bfs");
    expect(treeOfThoughtsStrategy({ searchPolicy: "dfs" }).name).toContain("dfs");
    expect(treeOfThoughtsStrategy().name).toContain("tree-of-thoughts");
  });
});

describe("treeOfThoughtsStrategy — BFS", () => {
  it("returns a result from the generator", async () => {
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "bfs",
      maxDepth: 1,
      branchFactor: 3,
      maxCalls: 3,
    });
    const { result } = await strategy.run({}, async () => "output");
    expect(result).toBe("output");
  });

  it("picks highest-scored candidate via custom evaluateState", async () => {
    let call = 0;
    // Candidates are numbers 0,1,2; evaluator = identity (higher = better)
    // but we clamp to [0,1], so score(2) = 1, score(1) = 1, score(0) = 0
    const scores = [0.1, 0.9, 0.5];
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "bfs",
      maxDepth: 1,
      branchFactor: 3,
      maxCalls: 3,
      pruneThreshold: 0,
      evaluateState: (s) => scores[s as number] ?? 0,
    });
    const { result } = await strategy.run({}, async () => call++);
    expect(result).toBe(1); // index 1 has highest score 0.9
  });

  it("respects maxCalls budget (does not exceed it)", async () => {
    let calls = 0;
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "bfs",
      maxDepth: 3,
      branchFactor: 4,
      maxCalls: 5,
      pruneThreshold: 0,
      evaluateState: () => 0.8,
    });
    await strategy.run({}, async () => {
      calls++;
      return "x";
    });
    expect(calls).toBeLessThanOrEqual(5);
  });

  it("metadata.cost.calls reports actual generator calls", async () => {
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "bfs",
      maxDepth: 1,
      branchFactor: 2,
      maxCalls: 2,
      pruneThreshold: 0,
    });
    const { metadata } = await strategy.run({}, async () => "x");
    expect(metadata.cost.calls).toBe(2);
  });
});

describe("treeOfThoughtsStrategy — DFS", () => {
  it("returns a result from the generator", async () => {
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "dfs",
      maxDepth: 2,
      branchFactor: 2,
      maxCalls: 4,
      pruneThreshold: 0,
    });
    const { result } = await strategy.run({}, async () => "dfs-out");
    expect(result).toBe("dfs-out");
  });

  it("prunes nodes below pruneThreshold from further expansion", async () => {
    let calls = 0;
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "dfs",
      maxDepth: 3,
      branchFactor: 3,
      maxCalls: 20,
      pruneThreshold: 0.9, // very high threshold → most pruned
      evaluateState: () => 0.5, // all below threshold → no expansion beyond depth 1
    });
    await strategy.run({}, async () => {
      calls++;
      return "x";
    });
    // Only depth-1 nodes (3) are generated; all pruned, no further expansion
    expect(calls).toBe(3);
  });
});

describe("treeOfThoughtsStrategy — default evaluator", () => {
  it("string: longer strings score higher (up to 1.0 at 200 chars)", async () => {
    const strategy = treeOfThoughtsStrategy({
      searchPolicy: "bfs",
      maxDepth: 1,
      branchFactor: 2,
      maxCalls: 2,
      pruneThreshold: 0,
    });
    const short = "x";
    const long = "x".repeat(200);
    let call = 0;
    const gen = async () => (call++ === 0 ? short : long);
    const { result } = await strategy.run({}, gen);
    expect(result).toBe(long);
  });
});
