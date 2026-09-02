/**
 * Tests for packages/agent-sdk/src/compute/with-compute.ts
 *
 * Coverage:
 *   withCompute — passes result through from strategy,
 *     InvalidStrategyError for null/missing strategy,
 *     BudgetExhaustedError when maxCalls=0,
 *     DeadlineExceededError when deadline is in the past,
 *     aborted signal throws before generator is called,
 *     generator errors bubble unchanged
 *
 * Ref: test coverage for agent-sdk/compute/with-compute.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import {
  BudgetExhaustedError,
  DeadlineExceededError,
  InvalidStrategyError,
  withCompute,
} from "../src/compute/with-compute.js";

function passThrough<T>() {
  return {
    name: "pass-through",
    run: async (input: T, gen: (i: T, ctx: unknown) => Promise<T>) => {
      const result = await gen(input, {});
      return {
        result,
        metadata: {
          strategy: "pass-through",
          candidates: 1,
          verifier_scores: [],
          cost: { calls: 1 },
          latency_ms: 0,
        },
      };
    },
  };
}

describe("withCompute", () => {
  it("returns result from strategy", async () => {
    const { result } = await withCompute("hello", {
      strategy: passThrough<string>(),
      generator: async (s) => s.toUpperCase(),
    });
    expect(result).toBe("HELLO");
  });

  it("throws InvalidStrategyError when strategy is null", async () => {
    await expect(
      withCompute("x", {
        strategy: null as never,
        generator: async () => "y",
      }),
    ).rejects.toThrow(InvalidStrategyError);
  });

  it("throws InvalidStrategyError when strategy lacks run function", async () => {
    await expect(
      withCompute("x", {
        strategy: { name: "bad" } as never,
        generator: async () => "y",
      }),
    ).rejects.toThrow(InvalidStrategyError);
  });

  it("throws BudgetExhaustedError when budget.maxCalls === 0", async () => {
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: async () => "y",
        budget: { maxCalls: 0 },
      }),
    ).rejects.toThrow(BudgetExhaustedError);
  });

  it("does NOT throw when budget.maxCalls > 0", async () => {
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: async () => "y",
        budget: { maxCalls: 5 },
      }),
    ).resolves.toBeDefined();
  });

  it("throws DeadlineExceededError when deadline is already past", async () => {
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: async () => "y",
        deadline: Date.now() - 1000,
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  it("does NOT throw when deadline is in the future", async () => {
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: async () => "y",
        deadline: Date.now() + 60_000,
      }),
    ).resolves.toBeDefined();
  });

  it("throws when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: async () => "y",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("generator never called when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const gen = vi.fn();
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: gen,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(gen).not.toHaveBeenCalled();
  });

  it("bubbles generator errors unchanged", async () => {
    const err = new TypeError("generator broke");
    await expect(
      withCompute("x", {
        strategy: passThrough<string>(),
        generator: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });
});
