/**
 * Tests for packages/agent-sdk/src/compute/strategies/mixture-of-agents.ts
 *
 * Coverage:
 *   mixtureOfAgentsStrategy — validation (rounds<1, proposersPerRound<1),
 *     default string aggregation (first non-empty),
 *     default number aggregation (median),
 *     custom aggregator overrides default,
 *     cost.calls = rounds × proposersPerRound,
 *     strategy.name = "mixture-of-agents"
 *
 * Ref: test coverage for agent-sdk/compute/strategies/mixture-of-agents.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { mixtureOfAgentsStrategy } from "../src/compute/strategies/mixture-of-agents.js";

describe("mixtureOfAgentsStrategy — validation", () => {
  it("throws RangeError when rounds < 1", () => {
    expect(() => mixtureOfAgentsStrategy({ rounds: 0, proposersPerRound: 3 })).toThrow(RangeError);
  });

  it("throws RangeError when proposersPerRound < 1", () => {
    expect(() => mixtureOfAgentsStrategy({ rounds: 2, proposersPerRound: 0 })).toThrow(RangeError);
  });
});

describe("mixtureOfAgentsStrategy — strategy name", () => {
  it("is 'mixture-of-agents'", () => {
    const s = mixtureOfAgentsStrategy({ rounds: 1, proposersPerRound: 1 });
    expect(s.name).toBe("mixture-of-agents");
  });
});

describe("mixtureOfAgentsStrategy — default string aggregation", () => {
  it("returns first non-empty string from proposers", async () => {
    const strategy = mixtureOfAgentsStrategy({
      rounds: 1,
      proposersPerRound: 3,
    });
    let call = 0;
    const gen = async () => (call++ === 0 ? "" : `output-${call}`);
    const { result } = await strategy.run({}, gen);
    expect(result).toBe("output-2");
  });
});

describe("mixtureOfAgentsStrategy — default number aggregation (median)", () => {
  it("returns median of proposer outputs", async () => {
    const strategy = mixtureOfAgentsStrategy({
      rounds: 1,
      proposersPerRound: 3,
    });
    const values = [10, 50, 30];
    let i = 0;
    const gen = async () => values[i++] as number;
    const { result } = await strategy.run({}, gen);
    expect(result).toBe(30); // median([10,30,50])
  });
});

describe("mixtureOfAgentsStrategy — custom aggregator", () => {
  it("uses provided aggregate function", async () => {
    const aggregate = vi.fn((outputs: string[]) => outputs.join("+"));
    const strategy = mixtureOfAgentsStrategy({
      rounds: 1,
      proposersPerRound: 2,
      aggregate,
    });
    let call = 0;
    const { result } = await strategy.run({}, async () => `x${call++}`);
    expect(aggregate).toHaveBeenCalledWith(["x0", "x1"]);
    expect(result).toBe("x0+x1");
  });
});

describe("mixtureOfAgentsStrategy — cost tracking", () => {
  it("cost.calls = rounds × proposersPerRound", async () => {
    const strategy = mixtureOfAgentsStrategy({
      rounds: 3,
      proposersPerRound: 4,
    });
    const { metadata } = await strategy.run({}, async () => "x");
    expect(metadata.cost.calls).toBe(12);
    expect(metadata.candidates).toBe(12);
  });

  it("runs exactly rounds × proposersPerRound generator calls", async () => {
    const strategy = mixtureOfAgentsStrategy({
      rounds: 2,
      proposersPerRound: 3,
    });
    let calls = 0;
    await strategy.run({}, async () => {
      calls++;
      return calls;
    });
    expect(calls).toBe(6);
  });
});

describe("mixtureOfAgentsStrategy — multi-round", () => {
  it("runs multiple rounds with the same input each round", async () => {
    const inputs: unknown[] = [];
    const strategy = mixtureOfAgentsStrategy({
      rounds: 2,
      proposersPerRound: 2,
    });
    await strategy.run("my-input", async (inp) => {
      inputs.push(inp);
      return "x";
    });
    expect(inputs).toHaveLength(4);
    expect(inputs.every((i) => i === "my-input")).toBe(true);
  });
});
